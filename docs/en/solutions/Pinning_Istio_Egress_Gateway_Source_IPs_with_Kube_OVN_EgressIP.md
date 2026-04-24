---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Traffic leaving the cluster through an Istio `egress-gateway` arrives at the upstream service with the **node's** IP as the source address — whichever node happens to be hosting the gateway pod at that moment. Upstream firewalls and partner allow-lists, however, want to see one (or a small, stable set of) source IP(s). Without intervention, every gateway-pod reschedule changes the visible source, and the partner has to allow-list every node in the cluster, which defeats the point of egressing through the gateway in the first place.

## Root Cause

The Istio `egress-gateway` is, from the platform's perspective, an ordinary pod. Its outbound connections are SNATed to the IP of the node it is running on — exactly like any other pod that does not have an explicit egress policy attached.

The mesh layer does not own egress IP selection; that is a CNI-level concern. On ACP, the CNI is **Kube-OVN**, whose `EgressIP` CRD assigns one or more stable external IPs to a set of pods identified by namespace + label selectors. Combining the two — a mesh-level gateway pod plus a CNI-level EgressIP that selects that pod — yields the desired contract: all traffic that the mesh routes through the egress-gateway leaves the cluster from a fixed, allow-list-friendly address.

The mesh control plane does not need to know about the EgressIP: from Istio's point of view nothing changes; the SNAT happens beneath the pod's network namespace.

## Resolution

### Preferred: declare the gateway through the mesh, then pin its source IP via Kube-OVN

Use the platform-managed `service_mesh` capability to deploy the egress gateway in the usual way (typically as part of the `ServiceMeshControlPlane`-equivalent resource that defines the mesh, or as a standalone `Deployment` labelled `app: istio-egressgateway` in the mesh's system namespace). Once the gateway pods are running and routing as expected, attach an `EgressIP` resource that scopes to that namespace + label.

Example: assume the gateway pods run in namespace `istio-system` with label `app: istio-egressgateway`, and the cluster has reserved `10.40.10.20` and `10.40.10.21` as EgressIPs (they must already be configured as routable on the worker network).

```yaml
apiVersion: kubeovn.io/v1
kind: EgressIP
metadata:
  name: istio-egress
spec:
  egressIPs:
    - 10.40.10.20
    - 10.40.10.21
  namespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: istio-system
  podSelector:
    matchLabels:
      app: istio-egressgateway
```

Apply with `kubectl apply -f istio-egress.yaml`. The Kube-OVN controller programs SNAT entries on the OVN logical routers so that any packet whose source pod matches the selectors is rewritten with one of the listed EgressIPs before leaving the cluster. Listing two or more IPs gives the controller the option to fail traffic over if the node currently advertising one EgressIP becomes unhealthy.

A few practical points:

- **Scope tightly.** The `namespaceSelector` + `podSelector` pair must match *only* the gateway pods. A broader selector (for example, "every pod in `istio-system`") will SNAT control-plane traffic such as `istiod` to the same address, which is rarely desirable and may break sidecar bootstrap.
- **Make sure the EgressIPs are routable.** The IPs in `spec.egressIPs` must belong to a subnet the node network already knows how to deliver. This is platform-policy, not Kube-OVN's job — coordinate with the network team before declaring an EgressIP that the upstream router has never heard of.
- **Verify upstream allow-lists once, then leave them alone.** The point of pinning is that the partner only has to allow-list two IPs. Treat that as a contract; do not rotate EgressIPs in place without coordinating.
- **Keep mesh policy and CNI policy separate.** Mesh-level egress controls (AuthorizationPolicy, virtual services routing through the gateway) decide *which* traffic goes via the gateway. The Kube-OVN EgressIP decides *what source address* that traffic leaves with. The two are orthogonal; combining them is the whole reason this configuration is useful.

### Fallback when the gateway is not in the mesh

If a workload egresses directly (no Istio sidecar, no `egress-gateway` in the path) and a stable source IP is still required, the same EgressIP CRD applies — point its selectors at the workload's namespace and labels. The mesh layer is not involved. This is the simpler path when the only requirement is a stable outbound IP and the rich routing/policy of an Istio gateway is not needed.

## Diagnostic Steps

Confirm the gateway pods and their current node placement:

```bash
kubectl -n istio-system get pod -l app=istio-egressgateway -o wide
```

Each pod's `IP` is its **internal** address; the SNAT happens on egress and is not visible inside the pod. To see the outbound-rewrite rules that Kube-OVN has actually programmed, query the OVN northbound database via the kube-ovn controller pod:

```bash
KUBEOVN_NS=kube-system   # adjust to where kube-ovn runs in this cluster
kubectl -n "$KUBEOVN_NS" exec -it deploy/kube-ovn-controller -- \
  kubectl ko nbctl --no-leader-only list nat \
  | grep -A2 -E 'logical_ip|external_ip'
```

Expected: one `snat` entry per gateway pod IP, with `external_ip` set to one of the values from `spec.egressIPs`. If a pod's IP is missing from the table, the EgressIP selector did not match it — re-check the labels.

Confirm end-to-end from the upstream side. Pick an external endpoint that logs the client IP (a small HTTP echo service is ideal) and exercise it through the gateway:

```bash
kubectl -n <client-ns> run debug --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -sS https://echo.example.invalid/whoami
```

The echoed `X-Forwarded-For` / `RemoteAddr` should be one of the listed EgressIPs. If it is the node IP instead, the traffic is bypassing the gateway pod (check the mesh's virtual-service routing) or the EgressIP selector is too narrow (it does not match the gateway pod that actually carried the request).

If the EgressIP fails over to a different node and the partner's firewall sees connection drops, verify the EgressIP CR shows the new assignment:

```bash
kubectl get egressip istio-egress -o jsonpath='{.status}{"\n"}'
```

A healthy assignment lists the assigned node and the active EgressIP; an empty `assignedNode` means no eligible node could host the IP — usually because the candidate nodes lack the required interface or label that Kube-OVN expects for EgressIP advertisement.

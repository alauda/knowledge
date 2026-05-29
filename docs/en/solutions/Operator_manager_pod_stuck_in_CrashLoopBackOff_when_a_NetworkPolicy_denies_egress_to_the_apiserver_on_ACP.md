---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500714
---

# Operator manager pod stuck in CrashLoopBackOff when a NetworkPolicy denies egress to the apiserver on ACP

## Issue

On Alauda Container Platform (Kubernetes `v1.34.5`, CNI `kube-ovn v1.15.10` with NetworkPolicy enforcement enabled via `--enable-np=true --np-enforcement=standard --enable-anp=true`), an operator's controller-manager pod enters `CrashLoopBackOff` shortly after a `NetworkPolicy` is applied in its namespace. The container logs from the previous restart show the manager failing to bootstrap with an API-server connection error of the form `Failed to create a new manager.` and `dial tcp <apiserver-ip>:443: i/o timeout`.

A reproduction on the cluster shows the chain end-to-end: a manager-shaped pod (label `control-plane=controller-manager`) starts cleanly and dials the in-cluster apiserver at `https://10.4.0.1:443/api?timeout=32s` while no policy is in place; once a `default-deny-egress` `NetworkPolicy` selecting the pod is applied, the next startup blocks on the same dial and exits with the timeout error, and the kubelet records `state.waiting.reason=CrashLoopBackOff` with `restartCount` climbing and `Warning BackOff` events of `Back-off restarting failed container`.

## Root Cause

`NetworkPolicy` is a core `networking.k8s.io/v1` namespaced resource on ACP (`netpol`), enforced by kube-ovn with upstream semantics. The `policyTypes` field documents that to deny egress, a policy must list `Egress` in `policyTypes` with no `egress` section; the `egress` field doc states that when the egress list is empty the `NetworkPolicy` limits all outgoing traffic from the selected pods. A `NetworkPolicy` of shape `policyTypes:[Egress]` with no `egress` rules, selecting the controller-manager pod, therefore isolates the pod's egress entirely, including its connection to the in-cluster apiserver.

The operator's manager container reaches the apiserver during bootstrap through the in-cluster `kubernetes.default` `Service`. On ACP the service-cluster-ip-range is `10.4.0.0/16`, so the `kubernetes` `Service` in the `default` namespace has `ClusterIP` `10.4.0.1:443/TCP` — distinct from defaults seen on other Kubernetes distributions. When egress to that endpoint is blocked, the bootstrap connection times out, the manager process exits non-zero, and `restartPolicy: Always` makes the kubelet restart the container in a back-off loop, surfacing as `CrashLoopBackOff`.

A subtle point matters when authoring the fix on kube-ovn: traffic to a `Service` `ClusterIP` is DNAT'd to a backend endpoint IP before egress `NetworkPolicy` is enforced, so an `egress` rule that only permits the `kubernetes` `Service` `ClusterIP` (here `10.4.0.1/32:443`) does not unblock the manager. The rule must permit the apiserver's real backend endpoint(s) — the addresses listed in the `EndpointSlice` for the `kubernetes` `Service`, on their secure port (`6443` in the reproduction).

## Resolution

Add a `NetworkPolicy` egress rule in the operator's namespace that permits the controller-manager pod to reach the apiserver backend endpoint(s) on their secure port, then let the kubelet restart the pod through the back-off so the next bootstrap succeeds.

First, discover the apiserver backend endpoints (these are the addresses the rule must permit, not the `kubernetes` `Service` `ClusterIP`):

```bash
kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes
```

```text
NAME         ADDRESSTYPE   PORTS   ENDPOINTS         AGE
kubernetes   IPv4          6443    192.168.136.179   4h1m
```

Author an egress `NetworkPolicy` that selects the controller-manager pod and permits TCP to each apiserver endpoint IP on the listed port. The `egress.to` peer is a `NetworkPolicyPeer` (`ipBlock | namespaceSelector | podSelector`) and `egress.ports` is a `NetworkPolicyPort` (`port` + `protocol`, default `TCP`); for an apiserver target an `ipBlock` per endpoint IP is the most portable shape:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-apiserver-egress
  namespace: <operator-namespace>
spec:
  podSelector:
    matchLabels:
      control-plane: controller-manager
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 192.168.136.179/32
      ports:
        - protocol: TCP
          port: 6443
```

Apply the policy alongside (or replacing) the existing default-deny-egress policy; multiple `NetworkPolicy` objects selecting the same pod are OR'd, so adding the allow rule is sufficient as long as no other policy narrows the apiserver path further:

```bash
kubectl apply -n <operator-namespace> -f allow-apiserver-egress.yaml
```

After the kubelet next retries the manager container (the back-off interval is bounded; restarts resume on their own), the controller-manager pod transitions out of `CrashLoopBackOff` and the previously failing startup completes — the same probe that failed with `dial tcp 10.4.0.1:443: i/o timeout` returns success on the next bootstrap.

If the cluster has more than one control-plane endpoint, list every address from the `EndpointSlice` as its own `ipBlock` entry under `egress.to`; the rule matches traffic to any one of them. If other in-cluster destinations are also required at startup (for example, CoreDNS for name resolution before connecting to the apiserver), extend the policy with additional `egress` entries — each entry is independently OR'd against the others.

## Diagnostic Steps

When a manager pod is flapping, capture the bootstrap error from the previous container instance — the current container is often mid-retry and its logs are empty or partial:

```bash
kubectl logs -n <operator-namespace> <manager-pod> --previous
```

A log line containing `Failed to create a new manager.` together with `dial tcp <ip>:443: i/o timeout` (or an equivalent connection-timeout error against the in-cluster apiserver address) is the diagnostic signature of egress to the apiserver being blocked.

Confirm the container is being restarted by the kubelet and the back-off is in effect:

```bash
kubectl get pod -n <operator-namespace> <manager-pod> \
  -o jsonpath='{.status.containerStatuses[0]}'
kubectl get events -n <operator-namespace> \
  --field-selector involvedObject.name=<manager-pod> --sort-by=.lastTimestamp
```

A `state.waiting.reason: CrashLoopBackOff` with a non-zero `lastState.terminated.exitCode` and `Warning BackOff` events of `Back-off restarting failed container` confirm the pattern.

List the `NetworkPolicy` objects in the namespace and inspect any that selects the manager pod to see whether `policyTypes` includes `Egress` without an egress rule that permits the apiserver endpoint(s):

```bash
kubectl get networkpolicy -n <operator-namespace>
kubectl describe networkpolicy -n <operator-namespace> <policy-name>
```

Resolve the apiserver `Service` and its backing endpoints to know which addresses the egress rule must permit; the `ClusterIP` alone is not enough on kube-ovn:

```bash
kubectl get svc -n default kubernetes
kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes
```

Once the allow rule is in place, the next bootstrap of the manager container should succeed and the pod should return to `Running` without further restarts.

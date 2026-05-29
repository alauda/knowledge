---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Admission webhook calls dropped by a NetworkPolicy that omits host-network ingress on ACP

## Issue

On Alauda Container Platform (Kubernetes v1.34.5, kube-ovn CNI), a registered admission webhook stops being reachable from the control plane after a NetworkPolicy is introduced in the webhook's namespace. The kube-apiserver invokes admission webhooks over HTTPS, POSTing the admission review to the webhook's service endpoint at `https://<service>.<namespace>.svc:443`. When the webhook namespace carries an allow-same-namespace NetworkPolicy but no policy admitting ingress from host-network sources, the kube-apiserver's webhook call is dropped before it reaches the webhook pod.

## Root Cause

The kube-apiserver runs as a host-network pod on the control-plane nodes, so its admission-webhook requests originate from the node's host network rather than from an address in the cluster pod CIDR. On kube-ovn, host-network-to-pod traffic is SNATed by the CNI, so the ingress arrives at the webhook pod presenting the CNI's internal SNAT (join/transit) subnet address as its source rather than the raw node IP — which is why the matching NetworkPolicy rule must admit that internal subnet, not the node's primary address. A NetworkPolicy in the webhook's namespace controls which sources are permitted to send ingress traffic to the webhook pod, and kube-ovn enforces `networking.k8s.io/v1` NetworkPolicy by translating it into OVN ACLs. An allow-same-namespace-only policy therefore matches only same-namespace pod sources and silently drops the host-network apiserver ingress, which severs the webhook call.

## Resolution

Add a NetworkPolicy to the webhook's namespace that explicitly admits ingress from the host network, so the kube-apiserver source is allowed to reach the webhook pod. Because kube-ovn presents that source as its internal host-to-pod SNAT subnet (the join/transit subnet) rather than a namespace it can label-select, the host-network ingress rule must select those sources with an `ipBlock.cidr` covering that subnet rather than a namespace-label selector. The exact CIDR is cluster-specific and should be confirmed against the CNI's subnet configuration (for example, `kubectl get subnet`); the example below uses a join subnet of `100.64.0.0/16`. The following policy keeps the same-namespace allowance and adds a host-network ingress rule for that subnet:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-apiserver-to-webhook
  namespace: cert-manager
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector: {}
    - from:
        - ipBlock:
            cidr: 100.64.0.0/16
```

Apply the policy to the webhook namespace:

```bash
kubectl apply -f allow-apiserver-to-webhook.yaml
```

Once kube-ovn programs the corresponding OVN ACLs, the host-network apiserver ingress is admitted and the admission webhook calls reach the webhook pod again. If the cluster's join/SNAT subnet differs from the example, or the control-plane nodes' SNAT addresses fall outside it, widen the `ipBlock.cidr` to cover the internal subnet those apiserver instances present as their source.

## Diagnostic Steps

List the NetworkPolicies in the webhook's namespace to confirm whether a host-network ingress policy is present or missing:

```bash
kubectl get networkpolicy -n cert-manager
```

Inspect the policy ingress rules to confirm they cover a host-network source; an allow-same-namespace-only rule set with no `ipBlock` for the node or join subnet is the configuration that drops the apiserver call:

```bash
kubectl get networkpolicy -n cert-manager -o yaml
```

Confirm the webhook's clientConfig points at an in-cluster HTTPS service so the apiserver's HTTPS POST target matches what the NetworkPolicy must admit:

```bash
kubectl get validatingwebhookconfiguration -o yaml
```

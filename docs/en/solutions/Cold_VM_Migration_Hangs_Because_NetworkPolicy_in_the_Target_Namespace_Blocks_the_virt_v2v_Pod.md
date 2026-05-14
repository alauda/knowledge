---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500059
---

# Cold VM Migration Hangs Because NetworkPolicy in the Target Namespace Blocks the virt-v2v Pod
## Issue

A cold VM migration from VMware into ACP virtualization (KubeVirt),
driven by the Alauda Build of Forklift Operator, hangs at the
conversion-progress step. The `forklift-controller` logs repeat
`Failed to update conversion progress`, and the migration's
`virt-v2v` pod in the target namespace logs that it is serving but
seeing no consumer reach it.

## Root Cause

At the conversion step, the per-VM `virt-v2v` pod is launched in the
**target namespace** (the namespace where the imported VM will live)
and exposes the VM's XML on port `8080`. The `forklift-controller`
runs in `konveyor-forklift` and polls that endpoint to read
conversion progress.

If the target namespace has a `NetworkPolicy` that denies ingress by
default (or restricts ingress to a label set that does not include
the Forklift namespace), the controller's TCP connection to the
`virt-v2v` pod's `:8080` is dropped. The migration pod is healthy in
isolation; the controller cannot observe its progress, so it never
advances past the conversion step.

## Resolution

Add a `NetworkPolicy` to the **target namespace** allowing ingress on
port `8080` from the `konveyor-forklift` namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-forklift-controller
  namespace: <target-namespace>
spec:
  podSelector: {}              # apply to virt-v2v pods (and any others)
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: konveyor-forklift
      ports:
        - protocol: TCP
          port: 8080
```

Apply, then re-run the migration plan. The controller's polling reaches
`virt-v2v` and conversion progress advances normally.

If existing policies in the target namespace use a different selector
shape (named labels, allow-all-ingress with a deny-list, etc.), add a
single allow rule equivalent to the above; the rule is purely
additive.

## Diagnostic Steps

Confirm where the controller and the conversion pod live:

```bash
kubectl -n konveyor-forklift get deploy forklift-controller
kubectl -n <target-namespace> get pod -l job-name -o wide   # the virt-v2v pod is a Job-spawned pod
```

Confirm a NetworkPolicy is in fact blocking the path:

```bash
kubectl -n <target-namespace> get networkpolicy
# Pick the policy and check its ingress.from — if no namespaceSelector
# admits `konveyor-forklift`, that is the block.
```

Check the controller logs for `Failed to update conversion progress`
or connection-refused / connection-timeout messages against the target
pod IP:

```bash
kubectl -n konveyor-forklift logs deploy/forklift-controller | \
  grep -E 'conversion progress|virt-v2v' | tail -20
```

A timeout from the controller's IP to the virt-v2v pod's IP confirms
the policy block. A successful `:8080` response after the policy is in
place confirms the fix.

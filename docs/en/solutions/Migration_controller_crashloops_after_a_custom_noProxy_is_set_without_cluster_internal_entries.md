---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Migration controller crashloops after a custom noProxy is set without cluster-internal entries
## Issue

A workload-migration controller (Konveyor / forklift / cluster-side
migration controller) is given a custom `noProxy` value on the migration
controller resource. Immediately after the change the controller pod
restarts in a loop with:

```text
"msg":"unable to register controllers to the manager",
"error":"failed to get API group resources:
  unable to retrieve the complete list of server APIs:
  migration.example.io/v1alpha1:
  Get \"https://172.30.0.1:443/apis/migration.example.io/v1alpha1\":
  context deadline exceeded"
```

Removing the `noProxy` field returns the controller to a healthy state.

## Root Cause

When the controller resource defines its own `noProxy`, that value
**overrides** (does not append to) the cluster-wide proxy noProxy list.
Any internal address that was previously implicit becomes proxied — and the
in-cluster API server endpoint (`https://kubernetes.default.svc`,
`172.30.0.1:443` in the example, or whatever address the service network
uses) is suddenly being routed through the egress proxy.

The egress proxy cannot reach the cluster's internal API service IP, the
controller's first reconcile blocks waiting for the API server's group
list, the request times out, the controller manager bails and the pod is
restarted by the kubelet. The cycle repeats indefinitely until the
override is removed or the cluster-internal addresses are re-added.

The same shape of failure applies to any operator or controller that
exposes a per-component proxy override: setting the override without
preserving the cluster-internal entries breaks the operator's ability to
reach the API server or other cluster services.

## Resolution

Always include the cluster-internal entries when overriding `noProxy`. The
minimal correct set is:

```yaml
spec:
  noProxy: ".cluster.local,.svc,127.0.0.1,localhost,<service-cidr>,<pod-cidr>,<machine-cidr>,.example.com,.s3.us-east-2.amazonaws.com,quay.io"
```

Replace `<service-cidr>`, `<pod-cidr>`, and `<machine-cidr>` with the
values from the cluster's network configuration. Look them up with:

```bash
kubectl get network.config cluster -o yaml \
  | yq '.spec.serviceNetwork, .spec.clusterNetwork[].cidr'
```

The machine network CIDR is the address range the cluster's nodes live
on; in many environments it is one of the standard private RFC1918 ranges,
in others it is environment-defined.

After re-applying the controller resource with the corrected `noProxy`,
the controller pod transitions to `Running` and the migration plan can be
re-issued. As a defensive practice, before customising any operator's own
`noProxy`, check the effective list it would compute on its own — most
operators expose this in `status.noProxy` or in their condition messages.
Use that list as the baseline and add only the extra entries you need.

## Diagnostic Steps

1. Confirm the failure is API-connectivity, not application logic:

   ```bash
   kubectl logs -n <migration-ns> deploy/<migration-controller> --tail=200 \
     | grep -i "context deadline exceeded"
   ```

   The `Get "https://<api-svc-ip>:443/apis/...": context deadline exceeded`
   line is the smoking gun.

2. Inspect the proxy environment that ended up on the controller pod:

   ```bash
   kubectl exec -n <migration-ns> deploy/<migration-controller> -- env \
     | grep -i proxy
   ```

3. Compare the controller's `noProxy` against the cluster's effective
   `noProxy` (which, on a healthy cluster, includes `.cluster.local`,
   `.svc`, the service CIDR, the pod CIDR, and the machine CIDR).

4. Remove the customisation as a quick rollback:

   ```bash
   kubectl patch <controller-cr> -n <migration-ns> \
     --type=json -p='[{"op":"remove","path":"/spec/noProxy"}]'
   ```

   The controller pod settles in `Running` again; you then re-apply the
   override with the cluster-internal entries included.

5. Re-issue the migration plan after the controller is healthy and confirm
   the data path through the egress proxy still works (the `noProxy`
   override is what allowed the migration's external endpoints to bypass
   the proxy in the first place, so verify the original goal is met).

---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A workload must bind only to IPv4 inside its pod network namespace, either because the upstream application silently prefers `::1` over `127.0.0.1` and fails on dual-stack loopback, or because the host network is IPv4-only and IPv6 advertisements from the pod trigger confusion upstream. The natural toggle —

```yaml
securityContext:
  sysctls:
    - name: net.ipv6.conf.all.disable_ipv6
      value: "1"
    - name: net.ipv6.conf.default.disable_ipv6
      value: "1"
```

— is rejected by the kubelet with an `unsafe sysctl` error. The sysctls are namespaced (they only affect the pod's network namespace), but the kubelet classifies them as *unsafe* and refuses to apply them unless explicitly opted in.

## Root Cause

Kubernetes splits pod-level sysctls into two buckets:

- **Safe** sysctls (e.g. `net.ipv4.ping_group_range`, `kernel.shm_rmid_forced`) are namespaced, isolated to the pod, and the kubelet applies them with no extra configuration.
- **Unsafe** sysctls are also namespaced, but setting them wrong can degrade the node or leak into other pods on the same host. The IPv6 disable flags are in this bucket because historically some kernels have leaked the change across netns boundaries.

To let a pod set an unsafe sysctl, the kubelet on each target node must be started with `--allowed-unsafe-sysctls=<name>,<name>`. On ACP this flag cannot be set by hand on the node — the declarative node configuration owns the kubelet drop-in. The procedure therefore has two parts: update the kubelet configuration on the node pool, then set the sysctl from the pod's `securityContext`.

## Resolution

1. **Label the target node pool.** Opt a *subset* of nodes into the relaxed kubelet configuration, so that the unsafe sysctl is not available cluster-wide:

   ```bash
   kubectl label node <worker-01> <worker-02> workload-class=ipv6-disable
   ```

2. **Declare the kubelet allowlist through the platform's node-configuration surface.** Under `configure/clusters/nodes`, add a kubelet customisation targeted to the `workload-class=ipv6-disable` selector that sets:

   ```yaml
   kubeletConfiguration:
     allowedUnsafeSysctls:
       - "net.ipv6.conf.all.disable_ipv6"
       - "net.ipv6.conf.default.disable_ipv6"
   ```

   The platform rolls this out by draining each matching node and restarting the kubelet. Do **not** hand-edit `/var/lib/kubelet/config.yaml` on the node; that change is reverted at the next reconcile.

3. **Schedule the workload onto the labelled nodes.** Combine a `nodeSelector` (so the pod lands on a node that has the allowlist) with the `securityContext.sysctls` block:

   ```yaml
   apiVersion: v1
   kind: Pod
   metadata:
     name: ipv4-only
   spec:
     nodeSelector:
       workload-class: ipv6-disable
     securityContext:
       sysctls:
         - name: net.ipv6.conf.all.disable_ipv6
           value: "1"
         - name: net.ipv6.conf.default.disable_ipv6
           value: "1"
     containers:
       - name: app
         image: myorg/app:1.0
   ```

   If the pod is admitted but evicted with `forbidden sysctl: ... not allowlisted on this node`, verify it actually landed on a node with the label (see diagnostic steps).

4. **Prefer application-level fixes where possible.** Disabling IPv6 is a blunt instrument. Many "IPv6 loopback" problems are solved by setting `GODEBUG=netdns=go+4`, `PREFER_IPV4=1`, or binding explicitly to `0.0.0.0` — none of which require node privileges.

5. **Plan the rollback.** Once the workload is migrated, remove the allowlist entry from the node configuration and delete the selector label. The surface area for unsafe sysctls should stay minimal; a permanent cluster-wide allowlist for `disable_ipv6` is usually a sign the underlying issue has not been fixed in the application.

## Diagnostic Steps

Verify the sysctl allowlist is in effect on the target node:

```bash
kubectl get --raw /api/v1/nodes/<node>/proxy/configz \
  | jq '.kubeletconfig.allowedUnsafeSysctls'
```

If the list does not include the IPv6 sysctls, the platform rollout has not landed on that node yet — wait for the MachineConfig-equivalent reconcile to finish or check the node pool status page.

Confirm the pod is scheduled on a labelled node:

```bash
kubectl get pod <pod> -o jsonpath='{.spec.nodeName}{"\n"}'
kubectl get node <node-name> -o jsonpath='{.metadata.labels}' | jq .
```

Inside the pod, check that IPv6 is actually disabled:

```bash
kubectl exec <pod> -- sysctl net.ipv6.conf.all.disable_ipv6 net.ipv6.conf.default.disable_ipv6
kubectl exec <pod> -- ip -6 addr show
# Expected: only ::1 or no global IPv6 addresses; no route::
kubectl exec <pod> -- ip -6 route show
```

If the sysctl is set but the application still binds IPv6, the problem is in the application — Linux keeps the `::1` loopback even when interfaces have no IPv6 addresses; most libraries must be told explicitly to prefer IPv4.

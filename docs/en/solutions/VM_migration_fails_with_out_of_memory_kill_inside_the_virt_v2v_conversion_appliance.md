---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM migration fails with out-of-memory kill inside the virt-v2v conversion appliance
## Issue

When migrating a VM into ACP Virtualization, the Forklift conversion pod terminates before the disk conversion completes. The pod log shows the kernel OOM killer firing inside the virt-v2v appliance, typically while a guest-side tool such as `xfs_repair` is walking the source filesystem:

```text
[1604.204253] xfs_repair invoked oom-killer: gfp_mask=0x140dca, order=0, oom_score_adj=0
[ ... ]
[1604.238280] oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,
mems_allowed=0,global_oom,task_memcg=/,task=xfs_repair,pid=817,uid=0
[1604.239260] Out of memory: Killed process 817 (xfs_repair)
              total-vm:2436804kB, anon-rss:2125820kB, file-rss:0kB,
              shmem-rss:97792kB, UID:0 pgtables:4436kB oom_score_adj:0
```

The `Mem-Info` block just above it confirms the appliance kernel is looking at roughly 2.5 GiB of RAM with no swap, which is the default appliance sizing. Large source disks or filesystem-repair paths exceed that budget and the conversion is killed.

## Root Cause

The conversion pod launches a nested libguestfs appliance (a small VM inside the pod, driven by virt-v2v) to mount and inspect the source disk. That appliance is sized from the libguestfs default memory, which is sufficient for small, clean guests but not for:

- large root filesystems where `xfs_repair` / `fsck` needs to build a full in-memory metadata map, or
- guests whose filesystems need repair as part of the pre-conversion phase, or
- multi-disk Windows guests where NTFS processing and Windows-specific hooks load additional modules.

The appliance memory (`LIBGUESTFS_MEMSIZE`) is not exposed as a user-facing field on the migration Plan today — making it configurable is tracked in the upstream Forklift repository. So the per-pod default has to be overridden out-of-band.

## Resolution

Two workable paths, in preference order.

### Path 1 — Increase the appliance memory via a policy-as-code mutator

This is the preferred path on an ACP cluster because it keeps the migration end-to-end inside ACP Virtualization and does not require a detour through an external host. Use a `MutatingAdmissionPolicy` (or Gatekeeper / Kyverno, if already installed) to inject a larger `LIBGUESTFS_MEMSIZE` environment variable and a matching memory limit into any Pod labelled `forklift.app: virt-v2v` in the migration target namespace.

Gatekeeper example (if the cluster already runs Gatekeeper with mutation enabled):

```yaml
apiVersion: mutations.gatekeeper.sh/v1
kind: Assign
metadata:
  name: increase-virt-v2v-memory
spec:
  applyTo:
    - groups: [""]
      kinds: ["Pod"]
      versions: ["v1"]
  match:
    labelSelector:
      matchLabels:
        forklift.app: virt-v2v
    scope: Namespaced
    namespaces:
      - <migration-target-namespace>
  location: "spec.containers[name:virt-v2v].env[name:LIBGUESTFS_MEMSIZE]"
  parameters:
    assign:
      value:
        name: LIBGUESTFS_MEMSIZE
        value: "12288"
---
apiVersion: mutations.gatekeeper.sh/v1
kind: Assign
metadata:
  name: increase-virt-v2v-limits
spec:
  applyTo:
    - groups: [""]
      kinds: ["Pod"]
      versions: ["v1"]
  match:
    labelSelector:
      matchLabels:
        forklift.app: virt-v2v
    scope: Namespaced
    namespaces:
      - <migration-target-namespace>
  location: "spec.containers[name:virt-v2v].resources.limits.memory"
  parameters:
    assign:
      value: "32Gi"
```

The appliance is launched with **twice** the value of `LIBGUESTFS_MEMSIZE` (the variable is in MiB, and libguestfs reserves headroom), so the example above gives the nested appliance ~24 GiB of RAM on a pod with a 32 GiB memory limit. Size these values to the largest disk expected in the plan; start at 8-12 GiB for typical Linux guests, go to 16 GiB or more for very large filesystems.

The policy mutates Pods *as they are admitted*, so existing virt-v2v pods need to be recreated (Forklift retries the migration automatically, or trigger a new Migration CR) for the new memory budget to take effect.

**Scope caveat.** The mutator should be scoped to the migration target namespace with an explicit `namespaces:` list. Do not match on system namespaces — platform-managed namespaces do not run the migration workload, and pod-mutators there can break unrelated components.

If Gatekeeper is not installed, the equivalent can be expressed as a Kyverno `ClusterPolicy` (rule type `mutate`) or a native Kubernetes `MutatingAdmissionPolicy` matching the same pod labels. The upstream CNCF landscape covers any of these equivalently — pick whatever the cluster already runs so a new admission controller is not introduced just for this workaround.

### Path 2 — Convert the disk off-cluster first

If policy-as-code is not available on the cluster, run virt-v2v on an independent Linux host with enough RAM, override the memsize directly, and then import the resulting disk into ACP Virtualization as a PVC. The command runs with `LIBGUESTFS_MEMSIZE` in the environment:

```bash
LIBGUESTFS_MEMSIZE=16384 virt-v2v -ic vpx://... -o local -os /tmp/vm <vm-name>
```

Upload the converted disk image as a DataVolume / PVC in the target namespace (via `virtctl image-upload pvc ...` or the ACP Virtualization console's **Upload disk image** wizard), then create a `VirtualMachine` that references the imported PVC. This bypasses the appliance-sizing problem entirely because virt-v2v is running in a normal host process where the OOM ceiling is the host's own RAM. It does mean the VM is handled as an import rather than as a Forklift plan, so use this path for one-off large guests rather than bulk migrations.

### Monitoring and retry

After enabling either workaround, re-run the failing VM. The symptom disappears when the appliance has enough RAM to complete whatever filesystem-walking step was being truncated. A large guest can still fail if the budget is set too low — increase `LIBGUESTFS_MEMSIZE` and the Pod memory limit together until the conversion succeeds, then leave the policy in place for the remainder of the wave.

## Diagnostic Steps

1. Confirm the failure is a memory kill, not a timeout or network error. The `oom-killer invoked` line and the killed process name in the pod log are the signature:

   ```bash
   kubectl -n <migration-namespace> logs <virt-v2v-pod> -c virt-v2v \
     | grep -E 'oom-killer|Out of memory|Killed process'
   ```

   If the killed process is `xfs_repair`, `e2fsck`, or `ntfsfix`, the appliance ran out of room during filesystem repair. If it is virt-v2v itself or a conversion helper, the in-memory image of the conversion is too large.

2. Record the appliance's memory ceiling by looking at the `Mem-Info` block in the same log — `present:` in the `Node 0 DMA32` section is a good proxy for the total RAM the appliance kernel saw. ~2.5 GiB is the default; anything at or below that is the built-in sizing.

3. After applying the mutator, admit a new virt-v2v pod and check the effective container spec:

   ```bash
   kubectl -n <migration-namespace> get pod -l forklift.app=virt-v2v \
     -o jsonpath='{.items[0].spec.containers[?(@.name=="virt-v2v")]}' | jq \
     '{env: .env[] | select(.name=="LIBGUESTFS_MEMSIZE"), mem: .resources.limits.memory}'
   ```

   The `env` value should show the new `LIBGUESTFS_MEMSIZE`, and the `mem` limit should be at least double that in MiB. If the env var is not present on the new pod, the mutator match did not fire — check the namespace list, labels, and (for Gatekeeper) that mutation is enabled.

4. Size the budget empirically. Re-run the failing VM after each bump. If OOM fires again on a bigger value, double it and retry; only give up the policy path once the sum of `LIBGUESTFS_MEMSIZE`-derived appliance RAM exceeds the node's schedulable memory, at which point Path 2 (off-cluster conversion) becomes the only option.

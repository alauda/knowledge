---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Huge Page Kernel Arguments Persist After Removing the Tuning Profile or Custom Node Pool
## Issue

Huge pages were enabled at boot time on a subset of worker nodes, typically via a tuning profile that declares `hugepagesz=2M hugepages=50` (or the 1G variant) as kernel arguments. The profile and the matching custom node pool were later removed — either because the workload that required huge pages was retired, or because the pool was being reshaped — and the nodes were rebooted.

After the reboot the huge-page arguments are **still** present in `/proc/cmdline`:

```text
BOOT_IMAGE=(hd0,gpt3)/boot/... rw ostree=/ostree/boot.1/...
 ignition.platform.id=aws console=tty0 console=ttyS0,115200n8
 root=UUID=... rw rootflags=prjquota
 systemd.unified_cgroup_hierarchy=1 cgroup_no_v1=all psi=0
 hugepagesz=2M hugepages=50
```

Removing the tuning profile removes the generated node-config object from the cluster, and the rendered node configuration for the pool no longer lists the huge-page arguments — but the on-disk ostree state on each node still carries them. The node-config reconciler does not consider this a drift to correct, so the pool goes `Updated=True / Degraded=False` even though the kernel is still reserving huge pages. Subsequent workloads that expect the full memory of the node get OOM-killed or scheduled to a smaller effective pool.

## Root Cause

There are **two** independent sources of truth for node kernel arguments, and they must be reconciled manually when pulling back huge-page reservations:

1. The cluster-level rendered node configuration. This is what Alauda Container Platform's `configure/clusters/nodes` surface (and the extended **Immutable Infrastructure** product — the node-image management stack that owns boot-time parameters) hands to each node as the desired state. Removing the tuning profile deletes the corresponding entry here, which is what the operator sees.

2. The per-node ostree boot entry. Kernel arguments live inside the ostree deployment on each node and are set via `rpm-ostree kargs`. The node-config reconciler writes these arguments when a new rendered config calls for them. It does **not**, however, always strip arguments that were dropped from the rendered config — particularly boot-time reservations like `hugepagesz`, which the Linux kernel only honours at boot, can only be changed by a subsequent reboot, and are therefore treated as "sticky" until the reconciler explicitly rewrites the ostree deployment.

The result is a drift between the cluster state ("no custom kernel args") and the node state ("still reserving 100 MiB of 2 MiB huge pages"). The reconciler is not wrong — it was never instructed to remove the existing `hugepagesz=` arg. The remediation is to add that instruction, either cluster-side (by pushing a new rendered config that explicitly omits the arg) or node-side (by running `rpm-ostree kargs --delete`). A coordinated drain + reboot is required either way, because the kernel cannot release boot-time-reserved huge pages without restarting.

## Resolution

Two supported paths. Pick based on whether the custom node pool itself is being retired or only the huge-page profile.

> Note: "huge pages" (HP) and "transparent huge pages" (THP) sound alike but are unrelated. This procedure covers HP — the boot-time kernel arguments. THP is runtime-tunable via `/sys/kernel/mm/transparent_hugepage/enabled` and does not require a reboot.

In every command below, replace the placeholders (`<pool>`, `<tuning-profile>`, `<node>`) with the real names in the cluster. Always review all steps before starting; this is a disruptive rollout.

### Path A — Retiring the custom node pool

1. Delete the custom node pool. Nodes in it will move back to the worker (or closest matching) pool and re-render their configuration accordingly. The pool's associated tuning profile is removed along with it.

   ```bash
   kubectl delete <pool-kind>/<pool>
   ```

2. Confirm the tuning profile is gone. Only the default profile should remain unless other custom profiles exist for unrelated reasons:

   ```bash
   kubectl get tuned -A
   ```

3. Confirm the rendered node configuration for the (now-receiving) pool no longer contains `hugepagesz=`. The expected shape is:

   ```yaml
   kernelArguments:
     - systemd.unified_cgroup_hierarchy=1
     - cgroup_no_v1="all"
     - psi=0
   kernelType: default
   ```

   If the rendered config is clean, proceed to Path C (drain + reboot + verify). If `hugepagesz=` is still in the rendered config, the profile did not actually get removed — re-check step 1.

### Path B — Keeping the pool, dropping only the huge-page profile

1. Delete the tuning profile in its namespace:

   ```bash
   kubectl -n <node-tuning-namespace> delete tuned <tuning-profile>
   ```

2. Verify the rendered configuration for the pool no longer carries `hugepagesz=`, same check as Path A step 3.

   If the rendered node configuration is clean but the nodes themselves still boot with the huge-page args, Path C applies. If the rendered config still has them, the profile was not the one owning those args — locate the owner with `kubectl get tuned -A -o yaml | grep -B5 hugepage`.

### Path C — Drain, clear the on-node kernel args, reboot

Once the rendered cluster-side state is clean, each affected node must be reconciled individually. Do this one node at a time:

1. Cordon and drain the node:

   ```bash
   kubectl cordon <node>
   kubectl drain <node> --ignore-daemonsets --delete-emptydir-data --force --disable-eviction
   ```

2. Open a privileged debug shell on the node and strip the huge-page kernel arguments from the ostree boot entry. Explicit `--delete=key=` with no value-side match removes all occurrences regardless of the specific size/count, which matters if several hugepage variants were layered over time:

   ```bash
   kubectl debug node/<node> -it --image=<node-os-debug-image> \
     -- chroot /host sh -c '
       rpm-ostree kargs --delete=hugepagesz= --delete=hugepages= --delete=default_hugepagesz=
       systemctl reboot
     '
   ```

   The debug shell returns when the node begins its reboot. By design, the node OS is immutable and state changes go through the cluster reconciler — direct SSH is discouraged because it leaves the node tainted as "accessed" and complicates support. The `kubectl debug node/` path is the supported escape hatch for exactly this kind of remediation.

   > The `kubectl debug node/` invocation may fail if kubelet is not running on the target. In that case the node is already unhealthy; open a support ticket rather than forcing SSH, unless you have a specific recovery runbook that allows it.

3. After the node comes back, uncordon it and verify:

   ```bash
   kubectl uncordon <node>
   kubectl debug node/<node> -- chroot /host cat /proc/cmdline
   ```

   The `/proc/cmdline` output should no longer contain `hugepagesz=` or `hugepages=`.

4. Repeat for each remaining node. Scripted form:

   ```bash
   for n in $(kubectl get nodes -l <pool-label> -o name); do
     kubectl debug $n -- chroot /host cat /proc/cmdline \
       | grep -q 'hugepagesz=' && echo "DRIFT: $n still has hugepages"
   done
   ```

   Nodes that still report `hugepagesz=` after the reboot either did not execute the `rpm-ostree` step (debug pod failed or was pre-empted) or are in a pool that still has a tuning profile carrying the arg. Repeat the relevant path for them.

### Prevention

- Treat the pairing "create tuning profile with `hugepagesz=`" ↔ "delete tuning profile + drain/reboot nodes" as a single change. Do not delete the profile without scheduling the drain window, because rendered config cleanliness alone does not evict the boot argument.
- Before sizing node resources for new workloads, verify `/proc/cmdline` on at least one node from each pool. Drift here is silent until a workload trips it.

## Diagnostic Steps

1. Confirm the drift exists by dumping `/proc/cmdline` from every node in the suspect pool:

   ```bash
   for node in $(kubectl get nodes -l <pool-label> -o name); do
     echo "--- $node ---"
     kubectl debug $node -- chroot /host cat /proc/cmdline
   done
   ```

   Anything ending in `... hugepagesz=2M hugepages=50` (or analogous) is a drifted node.

2. Confirm the cluster-side rendered configuration does **not** list the huge-page args. If it still does, the tuning profile or an equivalent declarative object is still in place — fix that before touching nodes:

   ```bash
   kubectl get <rendered-node-config-kind> -o yaml | grep -A2 kernelArguments
   ```

3. Enumerate tuning profiles cluster-wide to find any residual source of `hugepagesz=`:

   ```bash
   kubectl get tuned -A -o yaml | grep -B3 hugepage
   ```

4. On a single node, read the current ostree kernel args to confirm what a reboot would restore — this is what will still be set even if you reboot without clearing:

   ```bash
   kubectl debug node/<node> -- chroot /host rpm-ostree kargs
   ```

5. After Path C has been executed, run the loop in step 1 again. A node that still shows huge-page args is either in a pool with a non-removed profile or failed to reboot cleanly — re-run the debug + reboot for that single node.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Node configuration daemon fails to apply cgroup v2 kernel arguments — runtime security policy kills the pod
## Issue

When migrating cluster nodes from cgroup v1 to cgroup v2, the platform's node configuration controller (the immutable-infrastructure / machine-configuration operator) flips the relevant kernel arguments on each node:

- Removes `systemd.unified_cgroup_hierarchy=0` and `systemd.legacy_systemd_cgroup_controller=1`.
- Appends `systemd.unified_cgroup_hierarchy=1`, `cgroup_no_v1="all"`, and `psi=0`.

Some node pools end up `Degraded` mid-rollout with the controller reporting:

```text
Node is reporting: "unexpected on-disk state validating against:
  missing expected kernel arguments:
    [systemd.unified_cgroup_hierarchy=0 systemd.legacy_systemd_cgroup_controller=1]"
```

The controller is reading the node's running kargs, comparing against the previous (v1) `MachineConfig`, and finding a mismatch — but the node has clearly already moved past v1, just without rebooting into the new state.

## Root Cause

The node configuration daemon ("MCD") on the node performs the karg flip via `rpm-ostree kargs` and then expects to drain → reboot the node so the new boot loads with v2. The daemon's pod manifest declares which low-level operations the rendered config touches; for a karg-only delta it is `kargs:true, passwd:false, files:false` — a password change is **not** part of the rendered transition.

In the affected scenarios, the daemon is incorrectly issuing a `usermod` against the `core` user mid-transition (an upstream bug — the password is being touched even when the rendered config does not require it). Clusters that run a runtime-security operator (StackRox / a Container Security policy that flags user-add-execution) treat that `usermod` as a policy violation. The policy's enforcement is `KILL_POD`, and the security pod kills the daemon's container right after it issued the `rpm-ostree kargs` command — but **before** the daemon could drain and reboot the node.

The end state is broken in a recoverable way: the karg change is staged in `rpm-ostree`, but `/proc/cmdline` still reflects the previous boot. The controller compares the live cmdline against its own expectation and reports `Degraded`.

## Resolution

Two complementary actions: change the runtime-security policy so it does not kill the configuration daemon mid-transition, and reboot any node where the karg change was staged but never applied.

### 1. Set the runtime-security policy to "inform" before the cgroup migration

The relevant policy in the platform's container-security stack monitors changes to the `core` user's password. While the upstream bug is open, switch this policy from `enforce` to `inform` for the duration of the migration window so that the daemon's spurious `usermod` does not get its pod killed:

- Locate the policy named along the lines of "User Add Execution" in the runtime-security console (or its CR equivalent).
- Change **Policy behavior** from `enforce` to `inform`.
- Save and let the change propagate to the sensors before kicking off the cgroup migration.

The policy still records the violation (so you have an audit trail), it just no longer takes the kill action.

### 2. For nodes where rpm-ostree already staged the change, reboot manually

If a node has already gone through the daemon's karg flip — `rpm-ostree status` shows a staged deployment with the new kargs — the only thing left to do is to reboot it:

```bash
NODE=<node-name>
kubectl drain "$NODE" --ignore-daemonsets --delete-emptydir-data --disable-eviction
kubectl debug node/"$NODE" -it --profile=sysadmin --image=<utility-image> \
  -- chroot /host systemctl reboot
```

After the reboot, the new cmdline takes effect. Verify:

```bash
kubectl debug node/"$NODE" -it --profile=sysadmin --image=<utility-image> \
  -- chroot /host bash -c '
    echo "----- /proc/cmdline -----"; cat /proc/cmdline
    echo "----- cgroup version -----"; stat -c %T -f /sys/fs/cgroup
    echo "----- staged kargs -----"; rpm-ostree kargs
  '
```

Expected on a successfully migrated node:

- `/proc/cmdline` carries `systemd.unified_cgroup_hierarchy=1`, `cgroup_no_v1="all"`, `psi=0`.
- `stat -c %T -f /sys/fs/cgroup` returns `cgroup2fs`.
- `rpm-ostree kargs` matches `/proc/cmdline`.

Uncordon the node:

```bash
kubectl uncordon "$NODE"
```

### 3. Other failure shapes

If the cluster does not run a runtime-security tool, or if the daemon pod was not killed by such a tool, the failure has a different cause — typically a missing rendered config, an MCO controller stuck on a different node, or a `pivot` (rpm-ostree) error. Inspect the daemon's pod log on the affected node to identify the actual cause before applying the workaround above.

## Diagnostic Steps

1. Confirm the daemon ran `usermod` against `core` and was killed before it could drain / reboot:

   ```bash
   NODE=<node-name>
   kubectl debug node/"$NODE" -it --profile=sysadmin --image=<utility-image> \
     -- chroot /host journalctl --no-pager --boot \
        | grep -E 'machine-config-daemon\[|change user|Killing container.*machine-config-daemon'
   ```

   Look for the sequence: `Update prepared` → `drain complete` → `usermod ... change user 'core' password` → `Killing container with a grace period`.

2. Confirm the kill came from the runtime-security stack (StackRox / the platform's Container Security agent):

   ```bash
   PODNAME=<machine-config-daemon-pod>
   kubectl logs -n stackrox $(kubectl get pod -n stackrox -l app=sensor -o name) \
     | grep -B2 -A9 "$PODNAME"
   ```

   The fingerprint is `enforcement: KILL_POD_ENFORCEMENT` next to `policy_name: ".*User Add Execution"` referencing the daemon pod.

3. Inspect `rpm-ostree` state to know whether the karg change was *staged* (just needs a reboot) or *not yet applied* (needs the daemon to run again):

   ```bash
   kubectl debug node/"$NODE" -it --profile=sysadmin --image=<utility-image> \
     -- chroot /host bash -c '
       echo "----- boot options -----"; cat /proc/cmdline
       echo "----- cgroup version -----"; stat -c %T -f /sys/fs/cgroup
       echo "----- rpm-ostree status -----"; rpm-ostree status -v
       echo "----- rpm-ostree kargs -----"; rpm-ostree kargs
     '
   ```

   - `Staged: yes` paired with the new kargs in `rpm-ostree kargs` and the **old** kargs in `/proc/cmdline` is the "needs reboot" state — apply step 2 of the resolution.
   - No staged deployment is the "daemon never finished" state — re-enable the daemon (after putting the security policy in `inform`) and let the controller retry.

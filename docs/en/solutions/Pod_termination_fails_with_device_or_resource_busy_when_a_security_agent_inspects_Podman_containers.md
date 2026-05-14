---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Pod termination fails with device or resource busy when a security agent inspects Podman containers
## Issue

Pods on an affected node are stuck in `Terminating` and the kubelet logs repeat a sandbox-stop failure citing an overlay mount that cannot be removed:

```text
"Error syncing pod, skipping" err="failed to \"KillPodSandbox\" for
\"<uid>\" with KillPodSandboxError: \"rpc error: code = Unknown desc =
failed to stop infra container for pod sandbox <id>: failed to unmount
container <id>: removing mount point
\\\"/var/lib/containers/storage/overlay/<hash>/merged\\\": device or
resource busy\"" pod="<ns>/<pod>"
```

Namespace events show the same message as repeated `FailedKillPod` warnings. Control-plane workloads (for example the scheduler or API server static pods) hit this during a revision bump, which blocks the rollout of the new revision and can stall a cluster upgrade.

## Root Cause

A third-party node security agent (observed with CrowdStrike Falcon Node Sensor 7.30 and later, but the mechanism is generic) enumerates Podman containers by invoking the `podman` binary on the host. Some Podman versions leave the container rootfs overlay mount (`/var/lib/containers/storage/overlay/<hash>/merged`) in the **host** mount namespace after `podman inspect` returns — the mount leaks out of Podman's private namespace.

CRI-O and Podman share the same `/var/lib/containers/storage` tree. When the kubelet later asks CRI-O to stop and unmount an unrelated pod's sandbox, the umount fails with `EBUSY` because the leaked mount pins the same overlay. Every subsequent retry fails the same way, so the pod stays `Terminating` indefinitely.

The bug is in the Podman inspect path, not in CRI-O, the kubelet, or the security agent itself — any workload that invokes `podman` against the shared store on a node running CRI-O can trigger it.

## Resolution

Upgrade the node OS / container stack to a build that carries the fixed Podman. The upstream fix for the leaked mount is `containers/podman#26945`; it has been back-ported to the Podman packages shipped in recent ACP node OS images. Nodes running a patched Podman will not accumulate the stuck overlay mounts even with the security agent active.

Preferred path on ACP — roll the cluster forward to a release whose node OS ships the fixed Podman, then rotate any node that already has stuck mounts:

```bash
kubectl get nodes -o wide
kubectl get clusterversion   # or the equivalent node-OS image status object
```

Once the upgrade has landed, confirm the nodes are running the expected image revision and that no pod is still `Terminating` with the `device or resource busy` message.

**Unblocking a node that is already stuck.** The upgrade fixes new container starts, but it does not free the overlay mount that is already leaked — that mount lives in the host namespace until something clears it. Two options:

1. Reboot the node. If the node is in the middle of a drain-and-reboot sequence it will complete on its own; the reboot may take longer than normal while the stale mount is torn down but it does finish. This is the safe default.

2. Clear the leaked mount in place without rebooting. Open a privileged shell on the host mount namespace and lazy-unmount the overlay tree. `nsenter -a -t 1` enters PID 1's namespaces on the node:

   ```bash
   kubectl debug node/<node-name> --image=<debug-image> \
     -- nsenter -a -t 1 umount -l /var/lib/containers/storage/overlay
   ```

   `-l` (lazy) detaches the mount immediately and cleans up references once they are released, which is what is needed here because CRI-O is still holding the busy filesystem open. After the unmount returns, the stuck pods should finish terminating within a few kubelet sync cycles; verify with `kubectl get pod -A | grep Terminating`.

If the cluster cannot be upgraded immediately and the security agent is the proximate trigger, a temporary mitigation is to pause the agent's Podman-scanning feature on the affected nodes until the fixed image is rolled. Do not remove the agent entirely without consulting the security owner.

**Do not** try to restart CRI-O or the kubelet as a first step — the restart will not release the leaked mount (it is owned by PID 1's mount namespace, not by CRI-O's cgroup) and can further destabilise any already-draining pods.

## Diagnostic Steps

1. Confirm the error pattern in the kubelet log and pod events. The signature is the `FailedKillPod` event plus the `/var/lib/containers/storage/overlay/.../merged: device or resource busy` fragment:

   ```bash
   kubectl describe pod -n <namespace> <pod-name> | grep -A2 FailedKillPod
   kubectl logs -n kube-system -l component=kubelet --tail=200 2>/dev/null \
     | grep -E "KillPodSandbox|device or resource busy"
   ```

   On platforms where kubelet logs are not exposed as pod logs, collect them from the node:

   ```bash
   kubectl debug node/<node-name> -- chroot /host journalctl -u kubelet --since="30 min ago"
   ```

2. Identify the offending agent processes on the node. Any process that shells out to `podman` against the shared store is a candidate:

   ```bash
   kubectl debug node/<node-name> -- chroot /host ps -eo pid,comm,args \
     | grep -Ei 'podman|falcon|crowdstrike|<other-security-agent>'
   ```

3. Inspect the host mount table for the leaked overlay entries. Each stuck pod corresponds to one leaked `merged` mount:

   ```bash
   kubectl debug node/<node-name> -- chroot /host \
     findmnt -rno TARGET | grep '/var/lib/containers/storage/overlay' | wc -l
   ```

   The count should stay at zero in steady state on an idle node. A growing count while pods are terminating indicates the leak is active.

4. After applying the workaround or upgrade, re-run the mount-table check and confirm the stuck pods clear:

   ```bash
   kubectl get pod -A --field-selector status.phase=Running,status.phase=Pending \
     | grep -i terminating || echo "no stuck pods"
   ```

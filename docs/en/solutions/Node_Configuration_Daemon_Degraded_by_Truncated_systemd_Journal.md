---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Node Configuration Daemon Degraded by Truncated systemd Journal
## Issue

The node-configuration daemon on a worker reports a degraded state and stops applying further configuration changes. The daemon log on the affected node repeatedly emits the same parse error:

```text
Marking Degraded due to: getting pending state from journal:
  invalid character 'E' looking for beginning of value
```

Inspecting the host's systemd journal directory shows that one or more journal segments have been marked as truncated, and the kubelet and container runtime logs reference the same files:

```text
Journal file /var/log/journal/<machine-id>/system@<sequence>.journal~
  is truncated, ignoring file.
```

While the daemon is degraded, the platform's declarative node configuration surface (`configure/clusters/nodes`, backed by the **Immutable Infrastructure** extension) cannot reconcile new MachineConfig-equivalent updates onto that node, so kubelet/sysctl/chrony tweaks queued through the platform stall on this single host.

## Root Cause

The on-node daemon reads pending-state markers that the platform writes into the systemd journal between configuration phases. When the journal segment that contains those markers is truncated — typically after an unclean shutdown, a full disk on `/var/log/journal`, or a kernel panic — `journalctl` cannot return a valid entry. The daemon's JSON parse fails on the first non-JSON byte and bumps the node into `Degraded` rather than risking a partial apply on top of unknown state.

The truncated `.journal~` files are journald's own bookkeeping: the trailing `~` marks them as quarantined. They are never re-parsed by journald itself, but the daemon's lookup path still trips over them while scanning recent state.

## Resolution

1. **Confirm the journal is genuinely truncated.** SSH equivalent into the affected node via `kubectl debug` and run `journalctl --verify`. A healthy node prints `PASS` for every segment; a truncated node lists the offending file by name.

   ```bash
   NODE=<worker-node>
   kubectl debug node/$NODE -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host journalctl --verify
   ```

2. **Quarantine and remove the truncated segments.** Move the broken files aside first (so the issue can be inspected if it recurs), then restart `systemd-journald` so it opens a fresh segment.

   ```bash
   kubectl debug node/$NODE -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host /bin/bash -c '
       mkdir -p /var/log/journal.quarantine &&
       mv /var/log/journal/*/*.journal~ /var/log/journal.quarantine/ &&
       systemctl restart systemd-journald
     '
   ```

   If the daemon is still degraded after journald restarts cleanly, deleting the surviving non-tilde segments under `/var/log/journal/<machine-id>/` is the more aggressive recovery — it loses prior journal history but unblocks the parser.

3. **Restart the on-node configuration daemon pod.** The daemon caches the `Degraded` decision; the cleanest way to re-evaluate is to delete its pod and let the DaemonSet recreate it.

   ```bash
   kubectl -n kube-system get pods -l app=node-config-daemon \
     --field-selector spec.nodeName=$NODE
   kubectl -n kube-system delete pod <daemon-pod-on-that-node>
   ```

   Within a minute the new pod should report `Done` for the node and the cluster's node-configuration controller should clear the degraded condition.

4. **Address the underlying cause.** Truncation means journald lost a write — usually because `/var/log` filled up, the node power-cycled hard, or the disk had I/O errors. Set a journald size cap (`SystemMaxUse=`) through the platform's node-configuration surface so the directory cannot grow without bound, and add a node-disk-pressure alert for `/var/log` to catch the next occurrence early.

## Diagnostic Steps

Identify which node is degraded and view its daemon log:

```bash
kubectl -n kube-system get pods -l app=node-config-daemon -o wide
kubectl -n kube-system logs <daemon-pod> | grep -i degraded
```

Verify the journal state from inside the host filesystem:

```bash
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host journalctl --disk-usage
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host ls -la /var/log/journal/*/
```

Files ending in `.journal~` are quarantined segments — their presence confirms the diagnosis. After cleanup, `journalctl --verify` should print `PASS` for every remaining segment, and the daemon's next reconcile log line should be `Update completed for config <name>` rather than the `Marking Degraded` loop.

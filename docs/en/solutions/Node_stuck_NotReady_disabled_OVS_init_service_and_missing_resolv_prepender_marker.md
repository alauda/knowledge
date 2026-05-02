---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A worker node refuses to come up after a reboot or after the node-OS image is rolled forward. The node is reported `NotReady`; on the host:

- `systemctl status kubelet` reports kubelet as failed to start, with errors that reference the resolv-prepender (a small one-shot service that injects upstream DNS hints into `/etc/resolv.conf` before kubelet starts).
- `systemctl status ovs-configuration` shows the OVS bring-up service in a *disabled* or *masked* state.
- The OVN networking pods on the node never come up because there is no working bridge to attach to.

The logs from kubelet and from the OVS service all loop on the same idea: the prerequisite for "kubelet may start" was never met.

## Root Cause

A clean node bring-up runs a small chain of one-shot services that each create a marker the next service waits for:

1. `ovs-configuration.service` configures the host's network bridges (`br-ex`, the OVN-bound bridge) and writes the host network state.
2. The resolv-prepender unit lays down `/run/resolv-prepender-kni-conf-done` once it has merged the cluster-side DNS into `/etc/resolv.conf`.
3. The kubelet unit's `ConditionPathExists=/run/resolv-prepender-kni-conf-done` (or a `Wants=` equivalent) holds the kubelet back until that marker exists.

If `ovs-configuration.service` is disabled (manually masked, or its enabling missed during a re-image), step 1 never runs, the resolv-prepender unit is not triggered, the marker file is never created, and kubelet refuses to start with a misleading "missing resolv-prepender" error. The OVN pods cannot land on the node either, because there is no `br-ex` and the node's CNI initialisation never completed. The visible symptom is `NotReady`, but the chain is broken at the very first link.

## Resolution

Re-enable the bring-up chain on the affected node and create the marker so kubelet stops waiting. This is a host-shell operation; reach the node through the platform's node-debug shell (`kubectl debug node/...`) or via SSH if available.

### 1. Re-enable the OVS configuration service

```bash
kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> -- chroot /host bash -c '
  systemctl enable ovs-configuration
  systemctl enable kubelet
'
```

Enabling the service does **not** start it; that is intentional — you do not want the bridge being torn down and rebuilt while you are inside the host shell. The next reboot is what re-runs the chain cleanly.

### 2. Lay down the marker so kubelet starts on the next boot

If you want kubelet to come up *immediately* (without waiting for the OVS service to actually run end-to-end on the next boot), create the marker by hand. The unit only checks for the file's existence:

```bash
kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> -- chroot /host \
  touch /run/resolv-prepender-kni-conf-done
```

After the touch, kubelet's `ConditionPathExists` is satisfied. Restart kubelet:

```bash
kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> -- chroot /host \
  systemctl restart kubelet
```

### 3. Reboot to let the chain run end-to-end

The manual marker is a recovery step, not the steady-state fix. Reboot the node so the (now-enabled) OVS configuration service runs from scratch, the resolv-prepender writes the marker properly, and kubelet starts in the right order:

```bash
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
# from a host shell on the node:
sudo reboot
```

### 4. Confirm the OVN pods land

After the node reboots `Ready`, the platform's CNI controller should schedule the OVN node pod within a couple of minutes:

```bash
kubectl get nodes
kubectl get pods -n <ovn-namespace> -o wide --field-selector spec.nodeName=<node>
```

A node that re-enters `Ready` and runs the expected OVN node pod on it has finished the recovery.

### Avoiding the recurrence

`ovs-configuration` should be enabled on every node by the node-image build. If you are seeing it disabled on multiple nodes, audit the node-config pipeline that produced the image — usually a custom `MachineConfig`-equivalent unit accidentally masked the service, or a script ran `systemctl mask` against it for a one-off debug session and was never reverted. Putting an `Authoritative=true`-style ownership on the unit in the cluster's node-config CR keeps it from drifting on the next reconcile.

## Diagnostic Steps

1. Capture the kubelet unit's status; the failure reason is in the `journal` lines around the unit's start attempt:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> -- chroot /host bash -c '
     systemctl status kubelet
     journalctl -u kubelet --since "30 min ago" | tail -100
   '
   ```

   The signature is `Condition: start condition failed at .* ConditionPathExists=/run/resolv-prepender-kni-conf-done was not met`.

2. Check the OVS bring-up unit's state:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> -- chroot /host bash -c '
     systemctl is-enabled ovs-configuration
     systemctl status ovs-configuration
     ls -l /run/resolv-prepender-kni-conf-done /run/ovs-configuration.* 2>/dev/null
   '
   ```

   `disabled` or `masked` for `ovs-configuration`, plus the missing marker file, is the chain broken at link 1.

3. Verify there is no second copy of the service (a custom unit overlay) suppressing the system one:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> -- chroot /host \
     ls -l /etc/systemd/system/ovs-configuration.service.d/ 2>/dev/null
   ```

   Drop-in files that set `ExecStart=` to a no-op are a common way the service ends up effectively disabled while showing as `enabled` to a casual `is-enabled`.

4. After the recovery and the reboot, watch the OVN node pod start up — that is the end-to-end proof that the chain is intact again. If the pod stays in `ContainerCreating` with CNI errors, the bridges are still missing; loop back to step 1 of the resolution.

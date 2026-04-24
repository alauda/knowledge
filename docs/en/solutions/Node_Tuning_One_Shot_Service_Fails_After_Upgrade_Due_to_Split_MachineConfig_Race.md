---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After a cluster upgrade on a node running a `PerformanceProfile`, a node drops into `NotReady`. The host-level systemd unit that prepares the node-tuning environment (historically named `node-tuned-one-shot.service` or similar) fails at start-up with a message like:

```text
Error: crun: creating /var/lib/node-tuned: openat2 var/lib/node-tuned:
       No such file or directory:
       OCI runtime attempted to invoke a command that was not found
```

The unit tries to bind-mount a host path into a short-lived container that applies the tuning profile, but the bind source does not exist — so `crun` cannot start the container and the service stays in the `failed` state, blocking kubelet readiness.

Checking the rendered MachineConfig that was supposed to be active shows that the tuning image reference has been bumped to the new version, while the systemd unit file on disk still has the old mount paths. The node image and the unit file are out of sync.

## Root Cause

The Node Tuning subsystem produces the on-node artifacts via two independent pieces that both land through node-configuration (MachineConfig-style) rendering:

1. A systemd unit file that defines the one-shot container's bind mounts and entrypoint.
2. An environment-file pointer (`*.env`) carrying the current tuning container image reference.

On earlier releases — before the fix described here — the tuning controller rendered **two separate MachineConfigs**, one for each of those artifacts. The two objects roll out independently: the rendered controller merges them into the node's desired configuration, but the exact moment each layer lands on the node depends on ordering of the underlying render/drain/reboot cycle.

Under upgrade, the two halves are **not applied atomically**. If the image-env MachineConfig lands first, the node boots with a new image reference, but the systemd unit is still the old one — which expects the bind source under the old path (`/var/lib/<tuned>` instead of `/host/var/lib/<tuned>`, say). The new image assumes the new path, the old unit presents the old path, and the one-shot container fails before it can do anything useful. The window is a race: on a clean upgrade it closes immediately; on a multi-pool cluster or a slow MachineConfig rollout it can stay open long enough to strand a node.

The upstream fix is to collapse both artifacts into a single MachineConfig render so they always apply together. On upgraded clusters that still carry the two-render form, the race remains a possibility until the tuning controller is itself upgraded past the fix.

## Resolution

### Preferred: resolve via node-level configuration on ACP

Node-level configuration on ACP is managed through `configure/clusters/nodes` (the in-core node-config path) and, for advanced node-image / mount-layout changes, through the **Immutable Infrastructure** extension product — the functional peer of the MachineConfig-style render/drain/reboot pipeline. The right long-term fix is to pull the tuning controller up to the version that renders a single combined MachineConfig, so the image reference and the systemd unit can never diverge on disk.

If the node is currently stranded and the operator-level fix is not yet reachable, the safe unblock is to **bring the systemd unit into alignment with the new image reference by hand, long enough to let the MachineConfig reconcile finish**. Concretely, on the affected node:

1. Enter a debug session on the node and open a host-namespace shell (node-debug is the ACP equivalent of the privileged debug pod used elsewhere; what matters is a shell in the host filesystem).
2. Edit the stale systemd unit file under `/etc/systemd/system/` (the one named by the tuning pipeline). Align the bind-mount path with what the new image expects. In the historical form of this race, the change is literally a `/host` prefix on the volume line:

   ```text
   --volume /var/lib/<tuned>:/var/lib/<tuned>:rslave
   →
   --volume /var/lib/<tuned>:/host/var/lib/<tuned>:rslave
   ```

3. Reload systemd and restart the unit:

   ```bash
   systemctl daemon-reload
   systemctl restart <tuned-one-shot>.service
   ```

4. Wait for `systemd` to finish its pending jobs and for `kubelet` to report `Ready`:

   ```bash
   systemctl list-jobs
   systemctl status kubelet
   ```

5. **Revert the manual edit** after `kubelet` comes up. The node-configuration controller treats the unit file as machine-owned; leaving a hand-edit in place will make the render controller flag a configuration drift on the next reconcile. Once the correct MachineConfig rolls in (carrying the same `/host` prefix), the live file will match the desired state again.

This is a bridge, not a fix — it only reopens the node for long enough to accept the pending MachineConfig. Once the render lands, the file is owned by the platform again.

### Fallback: OSS node-tuning projects not managed via ACP

If a cluster runs a self-assembled tuning stack on top of ACP — for example a raw upstream Node Tuning Operator deployment or a TuneD DaemonSet the platform does not manage — the same race pattern can appear wherever the deployment renders the image reference and the wrapping unit as separate resources. The mitigation is the same: edit the unit on the affected node to match the image's expected mount layout, let the node return to `Ready`, then upgrade the controller to a version that renders the two pieces together.

## Diagnostic Steps

Confirm the failure mode directly from the node's journal (from the node-debug / host-namespace shell):

```bash
journalctl -u <tuned-one-shot>.service --no-pager
```

The tell-tale is an `openat2` / `crun` error naming a host path (e.g. `/var/lib/<tuned>`) that does not exist.

Check which image the node thinks it should be running:

```bash
cat /var/lib/<tuned>/image.env
```

The env file will point at a specific digest; that digest must match the tuning container image the target version ships. Cross-check against the release (whichever release-info or bundle-reference mechanism the cluster uses to resolve the currently-desired tuning image digest) — if the digest is the *new* one, the image-env MachineConfig has already been applied.

Compare the on-disk systemd unit against the one the currently-rendered MachineConfig prescribes:

```bash
diff <(kubectl get machineconfig <rendered-name> -o yaml | \
       yq '.spec.config.systemd.units[] | select(.name=="<tuned-one-shot>.service") | .contents') \
     /etc/systemd/system/<tuned-one-shot>.service
```

A non-empty diff — specifically, a `/host` prefix on the volume line in one version but not the other — confirms the two MachineConfigs did not land together.

Once the fix rolls in, the two should be identical and `systemctl status <tuned-one-shot>.service` should show `active (exited)` without an error.

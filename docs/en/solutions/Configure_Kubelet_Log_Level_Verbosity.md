---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

When troubleshooting node-level problems, increasing the kubelet log verbosity helps identify the root cause. The default log level (`2`) may not provide enough detail for complex issues such as pod scheduling failures, volume mount errors, or container runtime communication problems.

## Root Cause

The kubelet supports configurable log verbosity levels ranging from `0` (least verbose) to `10` (most verbose). The default level is `2`, which provides basic operational information. Higher levels expose progressively more diagnostic data, but consume additional CPU, disk I/O, and memory on the node.

## Resolution

### Log Level Reference

| Level Range | Purpose |
|---|---|
| 0 | Critical errors only |
| 1–2 | Default operational output |
| 3–4 | Debug-level information, suitable for most troubleshooting |
| 5–8 | Trace-level output, verbose internal state dumps |
| 9–10 | Maximum verbosity, rarely needed |

### Persistent Configuration — KubeletConfiguration (preferred on kubeadm clusters)

On kubeadm-provisioned clusters the kubelet is configured through `/var/lib/kubelet/config.yaml`. Set the `verbosity` field there and restart kubelet:

```bash
# On the target node
sudo sed -i 's/^\s*verbosity:.*/verbosity: 4/; t; $a\verbosity: 4' /var/lib/kubelet/config.yaml
sudo systemctl restart kubelet
```

This works regardless of how the systemd unit passes arguments to kubelet, and kubeadm-based automation will preserve it across upgrades.

### Persistent Configuration — systemd drop-in (fallback)

If you cannot edit `config.yaml` (some operator-managed setups lock the file), override the kubelet `ExecStart` via a drop-in that **inlines the `--v` flag directly**. Setting a bare environment variable like `KUBELET_LOG_LEVEL=4` does **not** raise verbosity — the stock kubeadm systemd unit only expands the three specific variables `$KUBELET_KUBECONFIG_ARGS`, `$KUBELET_CONFIG_ARGS`, and `$KUBELET_KUBEADM_ARGS`; any other name (including `KUBELET_LOG_LEVEL` or `KUBELET_EXTRA_ARGS`) is silently ignored.

```bash
sudo mkdir -p /etc/systemd/system/kubelet.service.d/
sudo tee /etc/systemd/system/kubelet.service.d/10-log-level.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS --v=4
EOF
sudo systemctl daemon-reload
sudo systemctl restart kubelet
```

The `ExecStart=` (empty) line clears the parent unit's ExecStart; the second line rebuilds it with `--v=4` appended.

### Persistent Configuration (Immutable OS Nodes)

On immutable-OS nodes — MicroOS, or any setup where `/etc` is backed by a read-mostly overlay that is reset on node upgrades or rollbacks — direct file edits under `/etc/systemd/system/kubelet.service.d/` **will not survive the next node update**. You may see the desired verbosity right after the change, then lose it silently when the node image is replaced.

Persist the change through ACP's Immutable Infrastructure mechanism instead:

- Define the drop-in file as part of the node configuration managed by ACP (under `configure/clusters/nodes`). The platform renders and re-applies it every time a node boots, so the override survives OS upgrades and rollbacks.
- Trigger a rolling apply on the target node pool. ACP will cordon/drain, restart the kubelet with the new verbosity, and resume scheduling.
- Revert the same way — update the node configuration to remove the override; do not `rm` the file directly on the node, because the mutation will be lost at the next reconcile.

If the cluster spans both mutable and immutable nodes, scope the change to a node group / pool so that only the intended nodes carry the higher verbosity.

### One-Time Change (Single Node)

For temporary debugging on a single mutable-OS node, use the same drop-in pattern shown above via `systemctl edit`:

```bash
sudo systemctl edit kubelet
```

Enter the override block — again, the flag must be inlined into `ExecStart`, not placed into a bare environment variable:

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS --v=4
```

Then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart kubelet
```

On immutable-OS nodes, prefer the Immutable Infrastructure flow above even for short investigations: running `systemctl edit` on a single node works until that node is re-imaged, at which point the change is gone without warning.

> **Important:** Revert the log level back to the default (`2`) after collecting the necessary logs. Extended operation at high verbosity places significant load on node resources.

## Diagnostic Steps

Verify the current kubelet log level. On kubeadm-provisioned clusters kubelet typically does **not** carry `--v` on its command line — verbosity comes from `config.yaml` — so `ps` on its own reports nothing even when verbosity is set. Check both locations:

```bash
# The KubeletConfiguration path (primary on kubeadm clusters)
sudo grep -E '^\s*verbosity:' /var/lib/kubelet/config.yaml || echo "verbosity: (default 2)"

# The command-line path (only populated if you added --v via a drop-in)
ps aux | grep kubelet | grep -oE '\-\-v=[0-9]+' || echo "(no --v on cmdline)"
```

Gather kubelet logs from a specific node:

```bash
kubectl get nodes
kubectl debug node/<node-name> --image=busybox -- cat /host/var/log/kubelet.log
```

Alternatively, SSH into the node and use journalctl:

```bash
ssh <node-address>
sudo journalctl -b -f -u kubelet.service
```

To collect logs from all nodes at once:

```bash
for n in $(kubectl get nodes --no-headers | awk '{print $1}'); do
  ssh "$n" "sudo journalctl -u kubelet.service --since '1 hour ago'" > "${n}.kubelet.log"
done
```

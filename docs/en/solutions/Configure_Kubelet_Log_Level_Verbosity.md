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

### Persistent Configuration (Mutable Host OS)

On mutable host OSes (standard Linux distributions with a writable `/etc`), set the kubelet log level persistently by adding or modifying the `--v` flag via a systemd drop-in file:

```bash
sudo mkdir -p /etc/systemd/system/kubelet.service.d/
sudo tee /etc/systemd/system/kubelet.service.d/10-log-level.conf <<EOF
[Service]
Environment="KUBELET_LOG_LEVEL=4"
ExecStart=
ExecStart=/usr/bin/kubelet \$KUBELET_KUBECONFIG_ARGS \$KUBELET_CONFIG_ARGS \$KUBELET_LOG_LEVEL
EOF
sudo systemctl daemon-reload
sudo systemctl restart kubelet
```

### Persistent Configuration (Immutable OS Nodes)

On immutable-OS nodes — MicroOS, or any setup where `/etc` is backed by a read-mostly overlay that is reset on node upgrades or rollbacks — direct file edits under `/etc/systemd/system/kubelet.service.d/` **will not survive the next node update**. You may see the desired verbosity right after the change, then lose it silently when the node image is replaced.

Persist the change through ACP's Immutable Infrastructure mechanism instead:

- Define the drop-in file as part of the node configuration managed by ACP (under `configure/clusters/nodes`). The platform renders and re-applies it every time a node boots, so the override survives OS upgrades and rollbacks.
- Trigger a rolling apply on the target node pool. ACP will cordon/drain, restart the kubelet with the new verbosity, and resume scheduling.
- Revert the same way — update the node configuration to remove the override; do not `rm` the file directly on the node, because the mutation will be lost at the next reconcile.

If the cluster spans both mutable and immutable nodes, scope the change to a node group / pool so that only the intended nodes carry the higher verbosity.

### One-Time Change (Single Node)

For temporary debugging on a single mutable-OS node without touching the persistent configuration, override the kubelet arguments directly on that node:

```bash
sudo systemctl edit kubelet
```

Add the following to raise verbosity to level 4:

```ini
[Service]
Environment="KUBELET_EXTRA_ARGS=--v=4"
```

Then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart kubelet
```

On immutable-OS nodes, prefer the Immutable Infrastructure flow above even for short investigations: running `systemctl edit` on a single node works until that node is re-imaged, at which point the change is gone without warning.

> **Important:** Revert the log level back to the default (`2`) after collecting the necessary logs. Extended operation at high verbosity places significant load on node resources.

## Diagnostic Steps

Verify the current kubelet log level by inspecting the running process:

```bash
ps aux | grep kubelet | grep -o '\-\-v=[0-9]*'
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

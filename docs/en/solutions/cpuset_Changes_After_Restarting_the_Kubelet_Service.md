---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After restarting the kubelet service on a node, the CPU sets assigned to guaranteed pods change unexpectedly. Pods that were pinned to specific CPUs get reassigned to different cores, potentially breaking NUMA-aware placement and degrading workload performance.

## Root Cause

The kubelet `cpu_manager_state` file at `/var/lib/kubelet/cpu_manager_state` stores the current CPU allocation mapping. On certain kubelet versions, the service definition removes this state file during startup. When the kubelet restarts without the state file, it recalculates CPU assignments from scratch, producing different allocations than the running pods expect.

This behavior occurs when the `cpuManagerPolicy` is set to `static` and the kubelet ExecStart pre-stop logic deletes the state file before reinitializing.

## Resolution

Upgrade the kubelet to a version that preserves the CPU manager state across restarts. The fix ensures the state file survives the kubelet stop/start cycle, maintaining consistent CPU pinning for existing pods.

Modern upstream kubelet (verified on v1.28 and later, including the v1.34 release series) already preserves `/var/lib/kubelet/cpu_manager_state` across `systemctl restart kubelet` by default — no workaround is required. The workaround below is only relevant when running an older, unpatched kubelet that cannot be upgraded immediately.

### Workaround: Preserve State File Manually

If an immediate upgrade is not feasible, protect the state file by adjusting the kubelet service configuration:

1. Back up the current state file before any restart:

```bash
sudo cp /var/lib/kubelet/cpu_manager_state /var/lib/kubelet/cpu_manager_state.bak
```

2. Create a systemd drop-in that restores the file on kubelet start:

```bash
sudo mkdir -p /etc/systemd/system/kubelet.service.d/
sudo tee /etc/systemd/system/kubelet.service.d/10-preserve-cpu-state.conf <<'EOF'
[Service]
ExecStartPre=/bin/sh -c 'if [ -f /var/lib/kubelet/cpu_manager_state.bak ] && [ ! -f /var/lib/kubelet/cpu_manager_state ]; then cp /var/lib/kubelet/cpu_manager_state.bak /var/lib/kubelet/cpu_manager_state; fi'
ExecStopPost=/bin/cp /var/lib/kubelet/cpu_manager_state /var/lib/kubelet/cpu_manager_state.bak
EOF
sudo systemctl daemon-reload
```

3. After the kubelet restarts, verify the CPU assignments match the backup:

```bash
sudo cat /var/lib/kubelet/cpu_manager_state | python3 -m json.tool
```

## Diagnostic Steps

### Confirm the cpuset Change

Capture the CPU manager state before restarting:

```bash
sudo cat /var/lib/kubelet/cpu_manager_state | python3 -m json.tool
```

Restart the kubelet:

```bash
sudo systemctl restart kubelet
```

Compare the state after restart:

```bash
sudo cat /var/lib/kubelet/cpu_manager_state | python3 -m json.tool
```

Check that the `entries` map — which maps pod UIDs to their CPU allocations — remains unchanged.

### Verify Current Policy

```bash
ps aux | grep kubelet | grep -o 'cpu-manager-policy=[^ ]*'
```

This issue only manifests when `cpuManagerPolicy` is set to `static`. The default `none` policy does not perform CPU pinning and is unaffected.

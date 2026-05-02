---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Pods / VMs Stuck Starting — NVMe-TCP Kernel Module Not Loaded on the Node
## Issue

Pods that consume PVCs from an NVMe-over-TCP (NVMe-TCP) backed CSI driver — typical examples are NetApp Trident against ONTAP-NVMe, or any other CSI driver that uses NVMe-TCP rather than iSCSI — stay in `ContainerCreating`. VMs that attach disks through such a CSI driver stay in `Starting`. The driver's node-side pod logs show the specific cause:

```text
time="..." level=warning msg="Error discovering NVMe service on host."
  error="NVMe driver is not loaded on the host"
  logLayer=csi_frontend workflow="plugin=activate"
time="..." level=info msg="NVMe is not active on this host."
```

Running `kubectl debug node/$NODE --image=<image-with-shell> -- lsmod | grep nvme_tcp` returns empty. The kernel is perfectly capable of running the NVMe-TCP stack — the module just has not been loaded, and the node is not configured to load it at boot.

## Root Cause

The `nvme_tcp` kernel module is not autoloaded on most default node OS images; it has to be explicitly declared to load at boot. The standard Linux mechanism for that declaration is a file under `/etc/modules-load.d/`:

```text
# /etc/modules-load.d/nvme-tcp.conf
nvme_tcp
```

`systemd-modules-load.service` reads every `*.conf` under `/etc/modules-load.d/` at boot and loads the listed modules. Without that file, the `nvme_tcp` module remains unloaded and any CSI driver that depends on it cannot communicate with its storage backend.

CSI drivers that expect NVMe-TCP (Trident, some other SAN-family drivers) do not load the kernel module themselves — they are user-space code. They detect the absence, report it, and refuse to activate their node-side plugin. Pods that need a PVC from the driver wait indefinitely.

The file has to live on the **node**, not inside any container. On an immutable node OS, a one-off `modprobe nvme_tcp` survives only until the next reboot; the durable fix is to write the file via the platform's node-configuration surface so every node has it persistently.

## Resolution

### Preferred — deliver the modules-load.d file through the platform's node-config mechanism

Create a node-level configuration resource that writes `/etc/modules-load.d/nvme-tcp.conf` onto every worker node (or the specific subset that hosts NVMe-TCP workloads). The exact CR depends on how the platform exposes node configuration:

- Some platforms accept an Ignition-style config CR that takes a file declaration and a mode.
- Others expose a node tuning CR that can inject systemd drop-ins and modules-load.d files.
- In both shapes, the file content is always the single line `nvme_tcp`.

Example shape (adapt to whichever CR kind the platform provides):

```yaml
# Conceptual shape — the actual kind / apiVersion depends on the platform's
# node-configuration CRD. Consult the platform's node-management docs.
apiVersion: <platform-node-config-api>
kind: NodeConfig
metadata:
  name: load-nvme-tcp-module
  labels:
    role: worker
spec:
  files:
    - path: /etc/modules-load.d/nvme-tcp.conf
      mode: 420              # decimal 420 = octal 0644
      contents: |
        nvme_tcp
```

After the CR reconciles, the node pool rolls (one node at a time) and each node carries the file persistently. Each node's `systemd-modules-load.service` loads `nvme_tcp` at boot from that point on.

Verify on a sample node:

```bash
NODE=<node>
kubectl debug node/$NODE --image=<image-with-shell> -- sh -c '
  cat /etc/modules-load.d/nvme-tcp.conf
  echo ---
  lsmod | grep nvme_tcp
'
```

The file contents and the loaded module together confirm the configuration took effect.

### Fast workaround — modprobe + daemonset

To unblock workloads while the durable change is being scheduled, run `modprobe nvme_tcp` on each affected node. This does **not** survive reboots, so it is strictly interim:

```bash
kubectl debug node/$NODE --image=<image-with-shell> -- modprobe nvme_tcp
```

A DaemonSet that runs a tiny container with `modprobe nvme_tcp` at startup can automate the interim load on every node. It is not a substitute for the durable configuration — on the next node reboot (kernel update, maintenance) the module unloads until the DaemonSet's init container runs again. And the DaemonSet must be scheduled to run **before** the CSI driver's node-side pod does, which is fiddly to sequence right.

Prefer the durable config path; keep the DaemonSet only if the node roll cannot happen for days.

### Confirm the CSI driver recovers

After the module is loaded on the nodes, the driver's node pods self-discover NVMe-TCP on their next reconcile cycle (or immediately on restart):

```bash
kubectl -n <csi-ns> rollout restart daemonset/trident-node-linux
# Watch logs on one node's driver pod.
POD=$(kubectl -n <csi-ns> get pod -l app=trident-csi,service=csi.trident.netapp.io \
        --field-selector=spec.nodeName=$NODE -o jsonpath='{.items[0].metadata.name}')
kubectl -n <csi-ns> logs "$POD" -c trident-main --tail=200 | grep -i nvme
```

The `NVMe is not active on this host` warning is replaced by the driver recording successful NVMe-TCP discovery. Pods / VMs that were Pending on the stuck PVC now proceed.

## Diagnostic Steps

Confirm the module is not loaded on the affected node:

```bash
NODE=<node>
kubectl debug node/$NODE --image=<image-with-shell> -- sh -c '
  lsmod | grep -E "^nvme|nvme_tcp" || echo "no nvme_tcp loaded"
'
```

Check the node's modules-load.d directory for any existing declaration:

```bash
kubectl debug node/$NODE --image=<image-with-shell> -- sh -c '
  ls -la /etc/modules-load.d/ 2>/dev/null
  cat /etc/modules-load.d/nvme-tcp.conf 2>/dev/null || echo "no file"
'
```

Empty directory listing (or the file missing) confirms the configuration has not been applied.

Inspect the CSI node pod's log to confirm the driver is the pod blocking the workload:

```bash
kubectl -n <csi-ns> logs -l app=trident-csi --tail=500 \
  | grep -iE 'nvme|driver.*not loaded|activate' | head -20
```

After the fix:

- `lsmod | grep nvme_tcp` returns a row with the module present (and refcount > 0 when workloads are actively using it).
- The CSI node pod's log carries "NVMe-TCP service discovered" or equivalent affirmative lines.
- Pending pods / VMs proceed to `Running`.

Verify across every node in the affected pool, not just the one that was investigated — the durable fix rolls all nodes, but the DaemonSet workaround only runs where the pod is scheduled.

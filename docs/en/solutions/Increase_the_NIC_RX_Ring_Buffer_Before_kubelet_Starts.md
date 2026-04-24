---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Worker nodes show non-zero RX ring buffer error counters in `ethtool -S` output and packet drops in system logs. Workloads that send bursty inbound traffic — log shippers receiving aggregated traffic, ingress controllers under spike load, or VMs being live-migrated through the node — see retransmits and timeouts that correlate with the RX-drop counter ticking up.

The corrective change is straightforward at the host: raise the RX ring size with `ethtool -G`. The harder requirement is to make that change persist across reboots **and** be in effect before the kubelet starts a workload that would already be hitting the small default.

The platform-preferred path on ACP for this kind of node tuning is the `configure/clusters/nodes` surface, which is the equivalent of MachineConfig and is rolled out by the platform's Immutable Infrastructure layer. A node-tuning operator (a DaemonSet that calls `ethtool` on a label selector) is the simplest answer for steady-state tuning that does not need to be in place before kubelet. The recipe below covers the harder case where the buffer must be wide enough at the moment kubelet brings up its first pod — the same shape as a one-shot systemd unit gated `Before=kubelet.service`.

## Root Cause

NIC drivers ship with conservative default RX ring sizes (typically 256 to 1024 descriptors). On a 25 Gbit/s link receiving short bursts above the line rate the ring fills before the host's softirq drains it, the driver drops the next packet, and the counter `rx_no_buffer` (or vendor-specific equivalent) increments. This happens entirely below the IP stack — Linux network statistics show the drops as interface-level errors, not socket-level errors.

The fix is to grow the ring (subject to the driver's maximum, visible in `ethtool -g`). The fix has to be applied **before** kubelet starts the first workload that will be sensitive to the original drop, otherwise traffic to that workload starts on the small ring and only widens after the unit runs.

## Resolution

There are two paths. Use the daemon path for routine tuning; use the gated systemd unit only when the buffer must be wide before kubelet runs.

### Preferred: A daemon that tunes per-NIC under a node label

Run a small `DaemonSet` that, on each scheduled node, executes `ethtool -G <iface> rx <size>` once at startup and keeps a sleep loop. This is fully platform-managed, requires no node configuration template, and rolls back simply by deleting the DaemonSet. Pin it to a label so only the affected node pool is touched.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: nic-ring-tune
  namespace: kube-system
spec:
  selector:
    matchLabels: { app: nic-ring-tune }
  template:
    metadata:
      labels: { app: nic-ring-tune }
    spec:
      hostNetwork: true
      nodeSelector:
        nic-ring-tune: "true"
      tolerations:
        - operator: Exists
      containers:
        - name: tune
          image: alpine:3.19
          securityContext:
            privileged: true
          command: ["sh", "-ec"]
          args:
            - |
              apk add --no-cache ethtool
              IFACE=${IFACE:-ens5}
              SIZE=${SIZE:-4096}
              ethtool -G "$IFACE" rx "$SIZE"
              ethtool -g "$IFACE"
              # keep the pod up so the change is observable / restartable
              exec sleep infinity
          env:
            - { name: IFACE, value: "ens5" }
            - { name: SIZE,  value: "4096" }
```

Label the target nodes:

```bash
kubectl label node <worker-01> nic-ring-tune=true
```

This is enough for nearly every "raise RX buffer" case. Use it first.

### Fallback: A node-level systemd unit gated before kubelet

For the narrow case where workload startup races kubelet — for example, a router pod that begins receiving traffic the instant it lands and would already be losing packets on the original ring — the change must be on disk and the unit must run before `kubelet.service`. Express the unit through the platform's node configuration surface so the change persists across re-image and is rolled out in the same way as any other node change.

1. **Author the systemd unit.** It is a one-shot, runs after networking is up, runs **before** any cluster service that might bring traffic in, and exits.

   ```ini
   [Unit]
   Description=Set NIC RX buffer size before kubelet starts
   Requires=NetworkManager.service
   After=NetworkManager.service
   Before=kubelet.service
   DefaultDependencies=no

   [Service]
   Type=oneshot
   ExecStart=/usr/sbin/ethtool -G ens5 rx 4096
   RemainAfterExit=yes

   [Install]
   WantedBy=multi-user.target
   ```

2. **Drop the unit through the platform's node-configuration surface (`configure/clusters/nodes`).** Target the same `nic-ring-tune=true` label so the change lands only on the intended pool. The platform writes the unit file to `/etc/systemd/system/set-nic-ring.service`, enables it, and reconciles each node — typically by draining and rebooting one node at a time. Do **not** drop the file directly with `kubectl debug node`; that change is reverted by the next reconcile.

3. **Watch the rollout and confirm the unit ran on each node.** A node where the unit failed (driver does not support the requested ring size, interface name differs) will not have a wider buffer; the daemon path above is more forgiving here.

4. **Pair the change with a metric.** Ship `node_network_receive_drop_total` (and the vendor-specific counter for the NIC, when available) to the platform's Prometheus and alert on a non-zero rate. Without a metric, a regression that re-introduces the small ring (driver upgrade, replacement NIC) will go unnoticed until the next traffic spike.

## Diagnostic Steps

Confirm the current ring sizes on a worker:

```bash
NODE=<worker-01>
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host ethtool -g ens5
```

Expected output lists `Pre-set maximums` (the driver ceiling) and `Current hardware settings` (the active values). The current RX should match the size set by the DaemonSet or systemd unit.

Inspect interface error counters; only the driver-specific names are guaranteed:

```bash
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host ethtool -S ens5 | grep -i -E "drop|nobuf|missed|rx_err"
```

Verify the systemd unit is enabled and successful (fallback path only):

```bash
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host systemctl status set-nic-ring.service
```

If the daemon path applied but the counter still grows, raise the size further (subject to `Pre-set maximums RX:`) or look beyond the ring — irq affinity, RPS/RFS, and `net.core.netdev_max_backlog` are the next layers to tune.

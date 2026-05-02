---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# irqbalance fails to start when many CPU-pinned pods reconfigure interrupt routing in quick succession
## Issue

A node hosting many performance-sensitive pods (workloads that opt out of IRQ load balancing through a pod annotation) eventually loses its `irqbalance` daemon entirely. The journald log on the node shows systemd refusing to restart it:

```text
... systemd[1]: irqbalance.service: Failed with result 'start-limit-hit'.
... systemd[1]: Failed to start irqbalance daemon.
```

After the daemon dies, IRQs end up scheduled on every CPU again — the very arrangement the pinned workloads were trying to avoid. Latency-sensitive pods that depend on isolated CPUs lose the determinism they were configured for, and the only way to recover is to manually clear the failure counter and restart the service.

## Root Cause

When a pod is admitted with the IRQ-load-balancing-disabled annotation, the cri-o high-performance runtime handler reconfigures interrupt affinity so the pinned cores are removed from the IRQ pool, and then it restarts `irqbalance` so the daemon picks up the new affinity mask. With one or two such pods this is invisible. With ten or more pods admitted in a tight window — for example during a node reboot, a cluster scale-up, or a coordinated workload deploy — the runtime handler issues many `irqbalance` restarts back-to-back.

systemd protects every service against pathological restart loops with two knobs:

- `StartLimitBurst` — how many starts in a row are allowed (default 5).
- `StartLimitIntervalSec` — the time window the burst counter is measured over (default 10 seconds).

A burst of 10 cri-o-driven restarts inside 10 seconds trips the limit. systemd flags the service as `start-limit-hit` and refuses any further restart, including subsequent runtime handler attempts. From that moment the service stays down until an operator clears the failure manually.

The fix is to widen the systemd burst budget for `irqbalance` so the runtime-driven reconfigure storm doesn't trip it.

## Resolution

Drop a per-service systemd `restart-limits.conf` that raises `StartLimitBurst` to a value comfortably above the worst expected restart storm. 100 is generous; pick a number that exceeds the largest bulk pod admission your fleet sees during a single reconcile cycle.

The clean way is through node configuration so the override survives reboots and is consistent across nodes. The example below uses the on-cluster Machine Configuration operator; the file is dropped at the canonical systemd dropin path so the unit picks it up automatically:

```yaml
apiVersion: node.alauda.io/v1
kind: NodeConfig
metadata:
  name: 99-worker-irqbalance-restart-budget
  labels:
    node-role.kubernetes.io/worker: ""
spec:
  systemd:
    units:
      - name: irqbalance.service
        dropins:
          - name: restart-limits.conf
            contents: |
              [Unit]
              StartLimitBurst=100
```

Apply through `kubectl`:

```bash
kubectl apply -f 99-worker-irqbalance-restart-budget.yaml
```

The node configuration roll triggers a worker reboot — schedule it during a maintenance window if the workload tolerates it, or wait for the next planned reboot if the symptom is intermittent.

For a node that is currently in the failed state and cannot wait for a reboot, recover it manually without rebooting. From a debug pod on the affected node:

```bash
kubectl debug node/<node> -it --image=busybox -- \
  chroot /host bash -c "
    mkdir -p /etc/systemd/system/irqbalance.service.d &&
    printf '[Unit]\nStartLimitBurst=100\n' > /etc/systemd/system/irqbalance.service.d/restart-limits.conf &&
    systemctl daemon-reload &&
    systemctl reset-failed irqbalance.service &&
    systemctl start irqbalance.service"
```

This sequence drops the same dropin, reloads systemd, clears the existing failure counter, and starts the daemon. Future cri-o-driven restarts then have headroom before the burst limit kicks in.

For clusters managed through GitOps, treat the restart-budget dropin as part of the per-pool node configuration and ship it through the same pipeline as the other tuning manifests. That way the override is part of the platform, not a one-off rescue patch that nobody remembers to re-apply after a fresh provision.

## Diagnostic Steps

Confirm the failure mode by inspecting the unit's failure log on the node:

```bash
kubectl debug node/<node> -it --image=busybox -- \
  chroot /host journalctl -u irqbalance.service --since "1 hour ago" \
  | grep -E 'start-limit-hit|Failed to start'
```

A `start-limit-hit` entry combined with one or more `Failed to start irqbalance daemon` lines confirms the systemd budget is the constraint, not a configuration error inside `irqbalance` itself.

Count the recent restart attempts to gauge the size of the storm:

```bash
kubectl debug node/<node> -it --image=busybox -- \
  chroot /host journalctl -u irqbalance.service --since "1 hour ago" \
  | grep -c 'Started irqbalance'
```

A count well above the default `StartLimitBurst=5` over a 10-second window is the smoking gun.

After applying the dropin, verify the new value is in effect:

```bash
kubectl debug node/<node> -it --image=busybox -- \
  chroot /host systemctl show irqbalance.service \
    --property=StartLimitBurst,StartLimitIntervalUSec
```

The output should report `StartLimitBurst=100` (or whatever value was dropped). Once the dropin is live, large bulk admissions of pinned-CPU pods no longer trip the burst limit and the daemon stays running.

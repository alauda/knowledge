---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Reverting Cluster Nodes Back to UTC After a Custom Timezone Was Pinned
## Issue

A cluster's nodes were earlier reconfigured to a regional timezone (for example `Africa/Cairo`) through a node-level systemd unit, and the operator now needs them back on UTC for log correlation, scheduled jobs, and audit consistency. Removing the original node-config object alone does **not** undo the change — after a reboot the node still reports the regional zone:

```text
$ kubectl debug node/<node> -- chroot /host ls -l /etc/localtime
lrwxrwxrwx. 1 root root 34 Jan 15 2025 /etc/localtime -> ../usr/share/zoneinfo/Africa/Cairo

$ kubectl debug node/<node> -- chroot /host timedatectl
   Local time: Tue 2025-08-26 15:57:18 EEST
Universal time: Tue 2025-08-26 12:57:18 UTC
      Time zone: Africa/Cairo (EEST, +0300)
```

## Root Cause

The earlier customization called `timedatectl set-timezone <zone>`, which is just a wrapper around the `tzdata` convention of pointing `/etc/localtime` at a zone file under `/usr/share/zoneinfo/`. The symlink is an artefact of the **last** explicit set-timezone call; deleting the configuration that placed it does not roll the symlink back. The system therefore stays on the regional zone until something explicitly writes UTC into `/etc/localtime`.

In a declaratively-managed cluster the right shape is a new node-config object that writes UTC, replacing the previous one. Trying to fix this with a one-shot `chroot` on the node is fragile — the next configuration reconcile or node re-image will revert any out-of-band change.

## Resolution

### Preferred: ACP Immutable Infrastructure / Node Config Surface

ACP exposes node configuration through `configure/clusters/nodes` (in-core) and the **Immutable Infrastructure** extension. Drive the reset through that surface: replace the existing custom-timezone node-config object with a UTC variant, let the controller pause the affected node pool, drain, reboot, and resume. The platform handles ordering across pools, so control-plane and worker reboots do not collide.

### Underlying Mechanics

For environments not yet onboarded to that surface (or for emergency one-cluster fixes), the same outcome can be reached by hand using the equivalent node-config CRDs that ship with the platform:

1. **Pause the affected node pool** so a single reboot wave covers the swap. The label below assumes the original object targeted `master`; adapt for `worker` pools as needed.

   ```bash
   kubectl get mc 99-master-custom-timezone-configuration \
     -o jsonpath='{.metadata.labels}{"\n"}'
   kubectl patch mcp/master --type merge \
     -p '{"spec":{"paused":true}}'
   ```

2. **Remove the previous node-config object** that pinned the regional timezone:

   ```bash
   kubectl delete machineconfig/99-master-custom-timezone-configuration
   ```

3. **Create a replacement node-config object** that runs `timedatectl set-timezone UTC` once at boot via a systemd unit. Write `/etc/localtime` deterministically, regardless of what the previous symlink pointed at:

   ```yaml
   apiVersion: machineconfiguration.k8s.io/v1
   kind: MachineConfig
   metadata:
     labels:
       node-role.kubernetes.io/master: ""
     name: 99-master-custom-timezone-configuration
   spec:
     config:
       ignition:
         version: 3.4.0
       systemd:
         units:
           - name: custom-timezone.service
             enabled: true
             contents: |
               [Unit]
               Description=Reset node timezone to UTC
               After=network-online.target
               [Service]
               Type=oneshot
               ExecStart=/usr/bin/timedatectl set-timezone UTC
               [Install]
               WantedBy=multi-user.target
   ```

4. **Apply it and unpause the pool** so the controller drains, reboots, and re-evaluates each node in order:

   ```bash
   kubectl apply -f 99-master-custom-timezone-configuration.yaml
   kubectl patch mcp/master --type merge \
     -p '{"spec":{"paused":false}}'
   ```

5. **Confirm the result.** Once the rollout completes, every node should report UTC:

   ```text
   $ kubectl debug node/<node> -- chroot /host timedatectl
        Time zone: UTC (UTC, +0000)
      Local time: Tue 2025-08-26 14:39:20 UTC
   Universal time: Tue 2025-08-26 14:39:20 UTC

   $ kubectl debug node/<node> -- chroot /host ls -l /etc/localtime
   lrwxrwxrwx. 1 root root 25 Aug 24 19:19 /etc/localtime -> ../usr/share/zoneinfo/UTC
   ```

## Diagnostic Steps

If a node finishes the rollout but still shows the old timezone, the `timedatectl` unit either did not run or crashed. Inspect the unit status from a debug session:

```bash
NODE=<node>
kubectl debug node/$NODE -it -- chroot /host \
  systemctl status custom-timezone.service --no-pager
kubectl debug node/$NODE -it -- chroot /host \
  journalctl -u custom-timezone.service --no-pager
```

A common failure is the unit running before `/usr/share/zoneinfo/` is writable — keep `After=network-online.target` (or another late-boot target) on the unit and avoid `Type=simple` so the executable is allowed to terminate.

Persistent local-time confusion across pods (containers showing one zone, host showing another) is almost always a missing `TZ` env var or a missing `/etc/localtime` mount in the workload — fix it at the container layer rather than on the node.

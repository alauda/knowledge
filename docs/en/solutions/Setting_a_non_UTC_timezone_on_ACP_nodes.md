---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500176
---

# Setting a non-UTC timezone on ACP nodes

## Issue

On an Alauda Container Platform cluster running Kubernetes server v1.34.5 with systemd-based Ubuntu 22.04 worker and control-plane nodes, operators occasionally need to switch a node's system timezone away from UTC to match a local-time operational policy or to make a single node's on-host logs read in wall-clock time. The node-level timezone is controlled by the underlying host's systemd toolchain — `timedatectl(1)` reports the current local time, universal time, RTC time, configured time zone, system-clock-synchronized status, and NTP service status, and is the canonical surface for both reading and changing the active zone.

## Root Cause

Cluster orchestration does not own per-node timezone state; the active zone is recorded on each host's filesystem as `/etc/localtime`, a symlink that points into `../usr/share/zoneinfo/<zone>` and identifies the currently-selected timezone (for example, `/etc/localtime -> ../usr/share/zoneinfo/UTC`). The zoneinfo database that the symlink resolves into, and that `timedatectl` reads from, is provided by the `tzdata` package shipped on the node OS. Any change to the node timezone therefore has to be made on the host itself — through the systemd surface that owns these files — and applies only to that host.

Operating a non-UTC timezone at the node level is not generally recommended. Once individual nodes report timestamps in differing local-time strings, cluster-wide log aggregation must apply per-source offset processing to align events on a common timeline, which complicates correlation and incident triage. The same divergence is amplified twice a year by daylight saving time transitions, which routinely cause confusion in logs and break applications that assume monotonic, jump-free local time. UTC on every node sidesteps both classes of problem and is the conventional choice for cluster hosts.

## Resolution

When a non-UTC zone is genuinely required on a specific node, change the node's timezone with `timedatectl set-timezone <zone>`, run on the host itself. On the Ubuntu 22.04 substrate this exercises the systemd 249 `timedatectl` interface; the command updates `/etc/localtime` to point at the requested entry under `/usr/share/zoneinfo/` and notifies systemd of the new active zone in a single step.

Apply the change via the host's normal administration path (for example, a direct host shell, the host provisioning tool that manages the node, or — for ad-hoc administration — a `kubectl debug` session that drops into the host's mount namespace). The on-host command is the same regardless of how the shell is obtained:

```bash
sudo timedatectl set-timezone Asia/Shanghai
```

To deliver the change as a unit that survives node re-provisioning, wrap the same call in a systemd oneshot unit whose `ExecStart` invokes `timedatectl set-timezone <zone>`, and install that unit through the host's configuration tooling so it is reapplied on each fresh boot of the node. Apply the unit only to nodes that genuinely require the non-UTC zone, and leave the rest of the cluster on UTC to keep aggregated logs aligned.

## Diagnostic Steps

Verify the live state on the target node by launching a debug pod that mounts the node's root filesystem at `/host` and reading the three systemd-managed surfaces directly from there. The debug pod is the most portable entry point on a cluster of Kubernetes server v1.34.5, and reading through the `/host` mount avoids needing to chroot into the host namespace — `chroot /host` is not admitted on this cluster because the debug pod is created without the `privileged` capability:

```bash
kubectl debug node/<node-name> -it --image=busybox
```

The configured zone name is recorded in `/etc/timezone` on the node OS and is the shortest read for the current setting; from inside the debug pod, read it through the `/host` mount:

```bash
cat /host/etc/timezone
```

Then inspect the underlying symlink to confirm which zoneinfo entry is active; the link target identifies the selected zone directly. Read it through the `/host` mount as well:

```bash
ls -l /host/etc/localtime
```

Finally, confirm that the zoneinfo database backing the symlink and `/etc/timezone` is installed by querying the node's package manager against the host root with `--root=/host` — `tzdata` is the package that provides `/usr/share/zoneinfo/` and the zone definitions both surfaces read from:

```bash
dpkg --root=/host -l tzdata
```

If `timedatectl` reports an unexpected zone or `/etc/localtime` points at the wrong entry, re-run `timedatectl set-timezone <zone>` on the host to bring the symlink and the systemd-tracked active zone back into the desired state.

---
title: Revert ACP cluster nodes to UTC after a custom timezone was applied
component: configure
scenario: troubleshooting
tags: [nodes, timezone, systemd, tzdata, kubectl-debug]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Revert ACP cluster nodes to UTC after a custom timezone was applied

## Issue

A custom non-UTC timezone (for example `Africa/Cairo`) has been applied
to one or more ACP cluster nodes, and the active timezone — reported by
the `Time zone` field of `timedatectl` — now needs to be returned to UTC
for log-correlation consistency across the platform [ev:c2].

On a Linux node, the active timezone is encoded by the `/etc/localtime`
symlink pointing into the `/usr/share/zoneinfo/` tree shipped by the
`tzdata` package; the cluster nodes observed here run kubelet `v1.34.5-1`
on Ubuntu 22.04.1 LTS with systemd 249 and `tzdata 2022f`, and
`/etc/localtime` resolves to `/usr/share/zoneinfo/Etc/UTC` in the
nominal UTC state [ev:c1].

```text
lrwxrwxrwx 1 root root 27 /etc/localtime -> /usr/share/zoneinfo/Etc/UTC
```

`timedatectl` exposes the current timezone state through a fixed field
set — `Local time`, `Universal time`, `RTC time`, `Time zone`,
`System clock synchronized`, `NTP service`, and `RTC in local TZ` — and
the `Time zone` field is the authoritative readout of the current
zone [ev:c2].

## Root Cause

`timedatectl set-timezone <Zone>` changes the active timezone by
re-pointing `/etc/localtime` to `/usr/share/zoneinfo/<Zone>`; the
operation is an in-place symlink rewrite, and the binary is shipped at
`/usr/bin/timedatectl` with the `set-timezone ZONE` subcommand
documented by `timedatectl --help` itself [ev:c3]. Because the symlink
is the only persistent record of the active zone, the timezone state on
a node is exactly the current `/etc/localtime` target — no separate
"desired zone" file exists on disk for a controller or a wrapper to
re-read [ev:c1].

## Resolution

The revert is therefore a forward action: explicitly invoke
`timedatectl set-timezone UTC` on each affected node (or otherwise
re-point `/etc/localtime` to `/usr/share/zoneinfo/UTC`); merely deleting
the wrapper that previously set the non-UTC zone is insufficient
[ev:c5_a]. The destination path is available on the platform's nodes:
`/usr/share/zoneinfo/UTC` is shipped as a symlink to `Etc/UTC` by the
node's `tzdata` package.

A `kubectl debug` host-namespace session is the in-cluster way to run
the revert without arranging direct SSH to every node. The host
filesystem is mounted at `/host` inside the debug container, so the
revert command runs against the node's real `/etc` via `chroot /host`
[ev:c8_b].

```bash
kubectl debug node/<node-name> -it --image=<registry-internal-image> \
  -- chroot /host timedatectl set-timezone UTC
```

Repeat the command for every node that needs to return to UTC; once
the `set-timezone` call returns, the `/etc/localtime` symlink on that
node points at `/usr/share/zoneinfo/UTC` (which itself resolves to
`Etc/UTC`) and `timedatectl` reports the `Time zone` field as
`Etc/UTC (UTC, +0000)` [ev:c2].

## Diagnostic Steps

Use the same `kubectl debug` shape to read the live state on a node
without mutating it; the host root is mounted at `/host`, so the
inspection commands run via `chroot /host` against the node's real
`/etc` and `/usr/share/zoneinfo` [ev:c8_b].

```bash
kubectl debug node/<node-name> -it --image=<registry-internal-image> \
  -- chroot /host timedatectl
```

```bash
kubectl debug node/<node-name> -it --image=<registry-internal-image> \
  -- chroot /host ls -l /etc/localtime
```

The first command prints the seven `timedatectl` status fields,
including the authoritative `Time zone` row [ev:c2]. The second command
prints the `/etc/localtime` symlink target, which encodes the active
zone directly; a `Time zone` row of `Etc/UTC (UTC, +0000)` plus an
`/etc/localtime` target of `/usr/share/zoneinfo/Etc/UTC` confirms a
node is back on UTC [ev:c1].

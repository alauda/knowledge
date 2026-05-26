---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.3.x
---

# Configuring chrony to use a custom NTP server on ACP nodes

## Issue

Alauda Container Platform nodes need their clocks pointed at an operator-supplied NTP source instead of the node OS distribution defaults. The host-level time-sync daemon on every ACP node (verified on Kubernetes `v1.34.5`) is `chronyd`, started under the `chrony.service` systemd unit and enabled via `multi-user.target.wants/chrony.service` linked to `/lib/systemd/system/chrony.service`; the daemon runs as `/usr/sbin/chronyd -F 1` and reads its configuration from `/etc/chrony/chrony.conf`. Replacing the distribution pool entries with one or more `server` lines pointing at the desired NTP host is the supported way to swap sources.

## Resolution

Edit `/etc/chrony/chrony.conf` on each node so that it carries one `server <host> iburst` line per upstream NTP source, with the distribution `pool` lines commented out, and restart `chrony.service`. The configuration must be identical across nodes to keep time drift uniform across the cluster. A working file fragment looks like the following:

```text
# pool ntp.ubuntu.com        iburst maxsources 4
# pool 0.ubuntu.pool.ntp.org iburst maxsources 1
# pool 1.ubuntu.pool.ntp.org iburst maxsources 1
# pool 2.ubuntu.pool.ntp.org iburst maxsources 2

server 192.168.16.4 iburst
server 1307::192:168:16:4 iburst

confdir /etc/chrony/conf.d
sourcedir /etc/chrony/sources.d
```

Both IPv4 and IPv6 addresses are accepted on `server` lines; list each NTP endpoint the cluster should reach. Activate the new configuration by restarting the unit:

```bash
systemctl restart chrony
```

For changes that should land as drop-ins rather than direct edits to `chrony.conf`, the main configuration declares two extension points: `confdir /etc/chrony/conf.d` for additional configuration directives and `sourcedir /etc/chrony/sources.d` for time-source definitions. Files placed under those directories are picked up after the same `systemctl restart chrony` and avoid touching the primary file.

Persistence note: `/etc/chrony/chrony.conf` and the `conf.d` / `sources.d` drop-in directories are on-disk files, so edits survive a node reboot once written; `systemctl restart chrony` only reloads the already-persisted file. Apply the same change on every node — there is no cluster-level controller that propagates it — and re-apply it on any node that is reimaged or re-provisioned, since reprovisioning restores the distribution default `chrony.conf`.

After restarting on each node, confirm chrony has actually accepted the new source and is reaching it; do not rely on the restart succeeding alone. `chronyc sources -v` lists the configured sources with a per-source state column (a leading `^*` marks the currently selected / synchronised server, `^?` an unreachable one), and `chronyc tracking` reports the reference ID, stratum, and offset of the server chrony is currently locked to:

```bash
chronyc sources -v
chronyc tracking
```

Expect the custom NTP host to appear in `chronyc sources -v` and, once reachable, to be selected (`^*`) with `chronyc tracking` showing it as the `Reference ID` and a small, stable offset. A source that stays `^?` means chrony cannot reach it — NTP uses UDP port 123, so verify each node can reach the NTP host on UDP/123 (firewall, security group, and routing all permit it) before assuming a configuration error.

## Diagnostic Steps

Confirm the daemon is the one running, that it is enabled in systemd, and that the active configuration carries the intended `server` lines on every node:

```bash
ps -o pid,cmd -C chronyd
systemctl is-enabled chrony.service
systemctl status chrony.service --no-pager
grep -E '^(server|pool|confdir|sourcedir)\b' /etc/chrony/chrony.conf
ls -l /etc/chrony/conf.d /etc/chrony/sources.d
```

The expected output is a single `chronyd` process invoked as `/usr/sbin/chronyd -F 1`, the unit reporting `enabled` and `active (running)`, and the file showing the operator-supplied `server` entries with the distribution `pool` lines commented out — identical on every node in the cluster.

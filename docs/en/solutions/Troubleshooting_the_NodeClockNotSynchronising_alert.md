---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Troubleshooting the NodeClockNotSynchronising alert
## Issue

The Prometheus monitoring stack fires a `NodeClockNotSynchronising` alert against one or more cluster nodes. The default alert expression is:

```text
alert: NodeClockNotSynchronising
expr:  min_over_time(node_timex_sync_status[5m]) == 0
for:   10m
labels: { severity: warning }
annotations:
  summary: "Clock not synchronising."
  message: "Clock on {{ $labels.instance }} is not synchronising. Ensure NTP is configured on this host."
```

The alert means `node_exporter` has observed the kernel `adjtimex` timex sync status to be zero for longer than the `for:` window. Pods inherit the host clock, so any node that is no longer stepping or slewing its clock to an upstream reference will drift relative to the rest of the cluster — with eventual consequences for etcd leader election, certificate validation and log correlation.

## Root Cause

`node_exporter` exposes the kernel timex status as the `node_timex_sync_status` metric. When the host NTP client (chrony on almost every ACP node) is not actively disciplining the system clock, the kernel reports unsynchronised and the gauge goes to zero. Typical causes:

- The chrony service on the node is stopped or crash-looping.
- All configured NTP sources are unreachable (blocked UDP/123, DNS resolution failure, firewalled out from the NTP pool).
- The configured sources have a worse stratum than `local stratum` and chrony therefore refuses to discipline from them.
- The offset has grown so large that chrony refuses to step without `makestep` being set, leaving it stuck.

## Resolution

The alert is fixed by getting chrony back into a synchronised state on the affected node — pod clocks will follow automatically.

1. Ensure the chrony service is running and has at least one reachable upstream source. From a shell on the node (use `kubectl debug node/<name> --image=<image-with-chrony> --profile=sysadmin -- bash` when you do not have SSH; ACP's cluster PSA rejects `chroot /host`, so the debug pod's `/host` bind-mount is the supported path for reading host files):

   ```bash
   systemctl status chronyd
   chronyc tracking
   chronyc sources -v
   chronyc sourcestats -v
   ```

   `Reference ID` of `00000000` or an empty source list means the daemon has no upstream it can talk to.

2. If the issue is network reachability, verify that outbound UDP/123 to the configured NTP servers is open from the node. A short packet capture during a poll interval confirms whether replies come back:

   ```bash
   tcpdump -n -i any port 123 -vvv -w /tmp/chrony.pcap
   ```

3. If the issue is configuration (wrong server hostnames, stratum too high, no `makestep` at boot), update `/etc/chrony.conf` and push it consistently to every affected node through your node configuration channel rather than editing one host manually. A declarative NTP config belongs with the rest of node OS configuration so that replacement nodes inherit it.

4. For persistent chrony debugging, enable the tracking and measurement logs in `chrony.conf` and then inspect `/var/log/chrony/`:

   ```text
   logdir /var/log/chrony
   log tracking measurements statistics
   ```

Once chrony reports a non-zero stratum and a small offset, `node_timex_sync_status` returns to `1` on the next scrape and the alert clears after the `for:` window.

## Diagnostic Steps

Confirm the cluster actually sees the alert firing, and which instances are affected, by querying Alertmanager and Prometheus directly. Port-forward Alertmanager / Prometheus from the monitoring namespace and query their HTTP APIs:

```bash
kubectl -n cpaas-system port-forward svc/alertmanager-main 9093:9093 &
curl -sk 'http://localhost:9093/api/v2/alerts' | jq '.[].labels'
```

```bash
kubectl -n cpaas-system port-forward svc/prometheus-k8s 9090:9090 &
curl -sk 'http://localhost:9090/api/v1/query?query=node_timex_sync_status' | jq
curl -sk 'http://localhost:9090/api/v1/query?query=node_timex_offset_seconds' | jq
curl -sk 'http://localhost:9090/api/v1/query?query=node_timex_maxerror_seconds' | jq
```

Combine the three to reproduce the alert expression locally and identify noisy nodes:

```text
min_over_time(node_timex_sync_status[5m]) == 0
  and node_timex_maxerror_seconds >= 16
  and (
    (node_timex_offset_seconds > 0.05 and deriv(node_timex_offset_seconds[5m]) >= 0)
    or
    (node_timex_offset_seconds < -0.05 and deriv(node_timex_offset_seconds[5m]) <= 0)
  )
```

On each reported node, collect the full chrony state for support:

```bash
journalctl -u chronyd --since "1 hour ago"
chronyc -N sources -a
chronyc activity -v
chronyc ntpdata
chronyc clients
cat /etc/chrony.conf
```

If `chronyc ntpdata` reports `501 Not authorized`, the `local stratum` line in `chrony.conf` is higher than the stratum of the upstream server, and chrony is refusing to accept it — lower the local stratum below the upstream value. NTP servers specified by hostname must also resolve via the node's `/etc/resolv.conf`; `chronyc activity` showing sources with unknown addresses signals a DNS problem rather than an NTP problem.

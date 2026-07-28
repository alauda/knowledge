---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Diagnose NodeClockNotSynchronising on ACP Ubuntu nodes

## Issue

On an ACP cluster running the `prometheus` ModulePlugin (mainChart `ait/chart-kube-prometheus`, v4.3.x), the `NodeClockNotSynchronising` alert follows the standard upstream kube-prometheus form: a PrometheusRule that triggers on a sustained `node_timex_sync_status == 0` reading from node-exporter, gated by a multi-minute `for` window at warning severity. The rule is not pre-shipped by the ACP chart itself; when the alert is observed on a cluster it has either been authored by the operator on top of the installed PrometheusRule CRD or carried in via the upstream rule set. Operators verifying installation state should not expect to grep a chart-shipped rule with this exact name out of `kubectl get prometheusrule -A`.

Because the underlying metric describes the host kernel's own view of the clock, the alert is not pointing at a Kubernetes object. The diagnosis target is the host-level NTP daemon — on Ubuntu 22.04 nodes that is chrony 4.2, managed by the systemd unit `chrony.service` with configuration in `/etc/chrony/chrony.conf`. Pod clocks track the host clock (there is no per-container clock namespace), so resolving chrony on the affected node also resolves the drift seen from pods on that node.

## Root Cause

`node_timex_sync_status` is produced by node-exporter's `timex` collector. The collector is a thin wrapper around the kernel `adjtimex(2)` syscall and emits `0` whenever the kernel sets the `STA_UNSYNC` status bit on the `timex` struct, i.e. when the kernel itself no longer trusts its clock as synchronised. Two related metrics from the same collector — `node_timex_maxerror_seconds` and `node_timex_offset_seconds` — quantify how far the kernel believes the clock can be off and the most recent offset estimate, and they remain useful for forensic work even after the boolean sync flag flips back to `1`.

A `STA_UNSYNC` reading therefore means one of: chronyd has no reachable, selected upstream source; chronyd is running but its samples are being discarded as out-of-spec; or chronyd is not running on the node at all. The alert does not distinguish between these — that distinction is recovered by the diagnostic steps below.

## Resolution

Drive recovery from the node itself, against chrony. The standard diagnostic set from the chrony client covers the three failure modes above. `chronyc sources -v` lists every configured source with its current state and last sample; `chronyc sourcestats -v` adds regression statistics over the recent sample window; `chronyc tracking` shows the currently selected reference, the estimated offset and skew, and the last update time; `chronyc activity` reports counts of online / offline / unreachable / unknown-address sources; and `chronyc ntpdata <ip-or-hostname>` exposes per-server protocol details. Read together these tell whether chronyd has at least one reachable and selected source, and if not, at which layer it failed:

```bash
chronyc sources -v
chronyc sourcestats -v
chronyc tracking
chronyc activity
chronyc ntpdata <ntp-server-ip>
```

When `chronyc activity` reports a non-zero count under "sources with unknown address", chronyd has not yet resolved one or more configured source hostnames. This counter is independent of the online / offline counts and reflects the state of chronyd's async resolver, which in turn depends on the node's DNS configuration — on Ubuntu nodes, `/etc/resolv.conf`. Treat any non-zero unknown-address count as a DNS-side issue on the node, not as an NTP-side issue.

If the active diagnostic snapshot shows healthy sources yet the clock still drifts, enable continuous logging so the next drift event can be reconstructed after the fact. Adding the following two lines to `/etc/chrony/chrony.conf` and restarting `chrony.service` causes chronyd to write per-measurement and per-tracking-update CSV logs under `/var/log/chrony/`, which retain offset, skew, and source-selection history beyond what the live `chronyc` snapshots show:

```text
logdir /var/log/chrony
log tracking measurements statistics
```

## Diagnostic Steps

Confirm first that the kernel itself reports the clock as unsynchronised — that is the actual condition the alert is reacting to. The metric is produced from `adjtimex(2)` so its value is independent of whether Prometheus is currently scraping; a value of `0` corresponds to the `STA_UNSYNC` bit being set. Reference syntax for the in-cluster query (substitute the installed prometheus pod name and node label):

```bash
kubectl exec -n cpaas-system <prometheus-pod> -c prometheus -- \
 promtool query instant http://localhost:9090 \
 'node_timex_sync_status{instance="<node>"}'
```

Next, inspect chrony directly on the affected node. Because cluster admission drops the `privileged` capability, recipes that `chroot /host` to run host binaries from a debug pod will fail with `Operation not permitted`; on this fleet, read host state through the bind-mounted `/host/proc/...`, `/host/etc/...` paths instead of chrooting. Where chronyc execution is required, run the same five subcommands listed above on the host shell (the bare `chronyc <subcmd>` form, which talks to the local cmdmon Unix socket):

```bash
chronyc sources -v
chronyc tracking
chronyc activity
```

Interpret `chronyc activity` carefully: an online count of zero with a non-zero unknown-address count means chronyd cannot even name-resolve its pool / server entries, and the next thing to verify is `/etc/resolv.conf` on the node and reachability of the listed nameservers. An online count of zero with all sources offline instead means name resolution worked but the configured servers are unreachable on the NTP port — that is a network / firewall question, not a chrony question.

If sources are reachable and selected but the clock still walks outside the expected envelope, persist the data needed to investigate after recovery. With `logdir /var/log/chrony` and `log tracking measurements statistics` in `chrony.conf`, the files `tracking.log`, `measurements.log`, and `statistics.log` accumulate CSV rows that can be correlated against the alert firing window once the next drift event occurs.

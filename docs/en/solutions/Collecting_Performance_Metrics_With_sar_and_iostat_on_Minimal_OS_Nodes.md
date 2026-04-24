---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Troubleshooting a slow node usually starts with `sar`, `iostat`, or `vmstat` to see CPU load, memory pressure, disk throughput, and context-switch rates. On modern container-optimised node OSes these tools are not installed into the host PATH by design — the OS image is intentionally minimal. Running `sar` via SSH returns `command not found`, and operators lose a familiar first-level triage surface.

## Root Cause

ACP nodes typically run an immutable, minimal operating system. These distributions omit discretionary packages (including `sysstat`, which provides `sar`, `iostat`, `mpstat`) to reduce the attack surface and keep the image small. Installing the package directly on the host is either impossible (read-only root) or discouraged (the change is rolled away at the next node reconcile).

The pragmatic replacement is `kubectl debug node`. It schedules a privileged ephemeral pod that shares the node's namespaces, mounts the host's root at `/host`, and runs a toolbox image of your choosing. Anything that would have been installed on the host can live in that image instead, so a node is never modified outside its declarative configuration.

## Resolution

Run `sysstat` inside a debug container rather than on the node. Two patterns work well:

### One-Off Samples

For an ad-hoc look, run a one-shot debug pod that includes the tools. Any image carrying `sysstat` works; the example below uses a public image that ships the package.

```bash
NODE=<node-name>
IMAGE=quay.io/praqma/network-multitool:latest   # includes iproute, sysstat, tcpdump

kubectl debug node/$NODE -it --image=$IMAGE -- chroot /host sh -c '
  sar -q 1 10;    # load average
  sar -r 1 10;    # memory
  sar -u 1 10;    # CPU total
  sar -P ALL 1 10;# CPU per core
  sar -d 1 10;    # block devices
  sar -w 1 10;    # context switches
  iostat -xz 1 10 # extended I/O stats
'
```

If you only need a quick single reading, drop `chroot /host` — the `sysstat` tools read from `/proc` and `/sys`, which the debug pod can see through the host-namespace mount at its own `/proc` when started with the `--profile=sysadmin` flag.

### Continuous Captures

For flaky slowness that only shows up intermittently, dump the sampling to a file on the node and copy it out after the fact. The debug pod exits after the command; write the output to a host path that survives:

```bash
NODE=<node-name>
kubectl debug node/$NODE -it --image=quay.io/praqma/network-multitool:latest \
  -- chroot /host sh -c '
    mkdir -p /var/log/perf-capture
    nohup sar -A -o /var/log/perf-capture/sar-$(date -u +%Y%m%dT%H%M%SZ).dat 10 360 >/dev/null 2>&1 &
    echo "captured PID $!; will run for 1h"
  '
```

Collect the artefact once the window closes:

```bash
kubectl debug node/$NODE -it --image=quay.io/praqma/network-multitool:latest \
  -- chroot /host ls -lh /var/log/perf-capture/
```

Use `kubectl cp` from a temporary sidecar pod that mounts the same host path, or rsync from a DaemonSet that exposes `/var/log/perf-capture` — `kubectl cp` cannot read node paths directly.

### Guardrails

- Always bound the sampling interval: `sar X N` (where `N` is iterations). An unbounded run can pile up gigabytes of samples on a node that is already under pressure.
- Pick the debug image deliberately. Any image you run gains root on the node; stick with a vetted internal registry image when possible.
- Prefer Prometheus-based metrics for long-running diagnosis. `node-exporter` scrapes the same counters that `sar` reports, and keeps historical data available for post-incident analysis without needing to return to the node.

## Diagnostic Steps

Confirm the node supports debug pods and you have permission to start one:

```bash
kubectl auth can-i create pods.ephemeralcontainers --subresource=ephemeralcontainers
kubectl get node <node> -o yaml | grep -A2 -E 'conditions|taints'
```

Verify the debug image you picked actually carries the tools before you rely on it in an incident:

```bash
kubectl debug node/<node> -it --image=<image> \
  -- sh -c 'command -v sar iostat mpstat vmstat && rpm -q sysstat 2>/dev/null || apk info sysstat 2>/dev/null'
```

If `kubectl debug node/` is unavailable (e.g., a hardened PodSecurity admission policy blocks the host-namespace pod), use the platform's node-inspection feature under `observability/inspection` instead. That surface already has debug permissions granted and renders the same counters from a browser.

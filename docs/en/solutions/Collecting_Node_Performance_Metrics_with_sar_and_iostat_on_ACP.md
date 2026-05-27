---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500236
---

# Collecting Node Performance Metrics with sar and iostat on ACP

## Issue

Low-level node performance data — run-queue length, memory pressure, per-device disk I/O, CPU utilization and context-switch rates — is exposed on a Linux host by the `sar` system-activity reporter, which is supplied by the `sysstat` package; a host that lacks that package returns `command not found` when `sar` is invoked. On an Alauda Container Platform node host the package may not be present on the default user path, so collecting these metrics requires reaching the host from a privileged debug context that already carries `sysstat` rather than relying on the binary being installed on the node itself.

## Resolution

Run `sar` and `iostat` against a node from a privileged node-debug pod that bundles the `sysstat` package, then redirect the output to a local file for later analysis. The container-debug image shipped with ACP carries `sysstat` version 12.7.8, which exposes the same `sar`/`iostat` flag set described below. Start the debug pod against the target node and pin the container-debug image so the tools are present:

```bash
kubectl debug node/<NODE> -it --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2
```

Reading host-level performance data requires running the collection command as root; the privileged node-debug container runs as root, satisfying that requirement. The standard output of the debug-node command can be redirected to a file on the operator workstation with `>`, saving the report for later review:

```bash
kubectl debug node/<NODE> --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- sar -q 1 100 > load_report.txt
```

In the `<flag> <interval> <count>` invocation shape, the two trailing integers mean sample every `<interval>` seconds and repeat `<count>` times — so `1 100` samples once per second for one hundred samples. `iostat` accepts the same `interval count` cadence as `sar`.

## Diagnostic Steps

Each `sar` flag targets a different subsystem; the flag set is present in the `sysstat` 12.7.8 build carried by the container-debug image. Use `sar -q` to report system load average and run-queue length. Use `sar -r` to report memory utilization statistics. Use `sar -d` to report per-device block-I/O activity.

For processor activity, `sar -u` reports total CPU utilization across all cores combined, while `sar -P ALL` reports per-core utilization with one row per CPU. Use `sar -w` to report context-switching activity, including process-creation and context-switch rates. The following invocations follow the same `interval count` cadence:

```bash
# memory, sampled once per second, 100 samples
kubectl debug node/<NODE> --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- sar -r 1 100 > mem_report.txt

# per-core CPU
kubectl debug node/<NODE> --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- sar -P ALL 1 100 > cpu_report.txt
```

For combined CPU and per-device disk I/O in a single report, `iostat` reports both in the same `interval count` cadence as `sar`:

```bash
kubectl debug node/<NODE> --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- iostat 1 100 > io_report.txt
```

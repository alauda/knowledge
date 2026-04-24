---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Operators investigating a performance incident on a cluster node need **data over time** — not just a point-in-time snapshot. Tools like `top`, `ps`, and `free` answer "what is happening right now"; they do not answer "how has this node behaved over the last fifteen minutes" or "does this symptom correlate with the CPU, memory, disk, or network axis". For that, the Linux `sar` utility from the `sysstat` package is the right tool: it samples CPU, memory, IO, network, and other axes at a fixed interval and writes a binary log that can be replayed and sliced by dimension after the fact.

The node binary paths in a cluster are read-only from the workload side, and interactive SSH to nodes is usually disallowed by policy, so the collection has to happen through an in-cluster debug session. This article explains how.

## Resolution

The standard Kubernetes way to run a privileged tool against a node filesystem is `kubectl debug node/<node>`. It schedules a debug pod that mounts the node filesystem under `/host` and runs a shell in a container image that has `sar` (and the rest of `sysstat`) available. On ACP, the debug container images ship with `sar` preinstalled; if you bring your own image, pick one that has the `sysstat` package.

### 1. Start a debug session on the target node

```bash
NODE=<node-name>
kubectl debug node/${NODE} -it --image=<debug-image-with-sysstat>
```

Once the shell is up you are inside the debug container, with the node's root filesystem visible under `/host`.

### 2. Run `sar` with an explicit output file

Collect a fixed sample count at a fixed interval, and write the binary log under the node's `/var/tmp` so it survives the debug session ending:

```bash
# From inside the debug container. Capture 100 samples one second apart
# into a binary file under the node's /var/tmp so it is retained on the node.
HOSTNAME=$(chroot /host hostname)
sar -o /host/var/tmp/${HOSTNAME}_sysreport.sar 1 100
```

Interpretation of the two numeric arguments:

- First argument (`1`) is the sample interval in seconds.
- Second argument (`100`) is how many samples to take before `sar` exits.

Scale both knobs to the investigation: tighter interval + short duration for a narrow spike; `2 1800` (one hour at 2-second resolution) when you're letting it run in the background to catch an intermittent issue.

### 3. Retrieve the binary log off the node

Since the file was written into the node's `/var/tmp`, copy it to your workstation. The most reliable path is to spin the debug pod again and `kubectl cp` out:

```bash
# With a debug pod still attached to the node:
kubectl cp <debug-pod-namespace>/<debug-pod-name>:/host/var/tmp/${HOSTNAME}_sysreport.sar \
  ./${HOSTNAME}_sysreport.sar
```

If the site's support workflow accepts binary sar files, attach the file as-is; the format is stable across `sysstat` versions.

### 4. Analyse the collected sar file

Replay the file with `sar -f` and select the axis you care about. Useful flags:

- `-q` — queue length and 1/5/15-minute load averages over the window.
- `-r` — memory utilisation.
- `-n DEV` (or `EDEV`, `SOCK`, etc.) — network stats, per interface or per socket.
- `-d` — per-block-device IO activity.
- `-u` — CPU utilisation (default, but useful to be explicit).

Example — CPU and queue length over the recorded window:

```bash
sar -u -f ./node.sar
sar -q -f ./node.sar
```

### 5. Pair `sar` with per-process tooling

`sar` tells you *which axis* saturated (CPU / memory / IO / network). It does not tell you *which process* was responsible. Once an axis is identified, run a second pass with a per-process tool — `pidstat` from the same `sysstat` package is the natural companion and shares the `sar` data format. Typical workflow: `sar` identifies a sustained CPU saturation window; `pidstat` run over the same window attributes the CPU time to a specific process ID; the process ID correlates back to a container via `/proc/<pid>/cgroup`, which identifies the pod.

## Diagnostic Steps

If `sar` is not available inside the debug container:

```bash
which sar || echo "sysstat not installed"
```

A common reason: the debug image does not include `sysstat`. Pick a debug image that has it, or bring a small sidecar image that does. Do not try to `yum install` / `apt-get install` against the live node — the node filesystem is intentionally immutable.

If `sar` starts but writes a zero-byte file, the path passed with `-o` is probably not the `/host/...`-prefixed form: the debug container's own `/var/tmp` is discarded when the pod exits. Always write through `/host` if the file needs to survive.

Validate the binary is readable before leaving the node:

```bash
sar -u -f /host/var/tmp/${HOSTNAME}_sysreport.sar | head
```

A readable first row of CPU utilisation confirms the file is well-formed and ready to be copied off the node for offline analysis.

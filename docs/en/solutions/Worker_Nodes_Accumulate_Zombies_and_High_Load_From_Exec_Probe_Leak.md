---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A worker node is loaded far above its normal baseline. Common observations:

- thousands of `<defunct>` (zombie) processes are visible in `top` and `ps`;
- the run-queue is saturated and load average is several multiples of the CPU count;
- interactive logins to the node are extremely slow — an SSH session to start a shell can take minutes, not seconds;
- the container runtime (`crio`) and `kubelet` are at the top of the CPU usage list, often together with one or two application processes.

A `top` snapshot from a node hitting this issue typically looks similar to:

```text
PID    USER     %CPU  %MEM   COMMAND
1760   root     314.2  0.3   crio
1810   root      17.2  5.0   kubelet
2522139 1972     99.7  0.0   python3.6
1      root      99.0  0.8   systemd
... (many <defunct> entries below) ...
```

The application pods on the node are still running, but probes are flapping and the kubelet event log shows recurring `Liveness probe failed` / `Readiness probe failed` lines for unrelated workloads, because the runtime cannot keep up with the probe-exec rate.

## Root Cause

The pattern — high load, runaway runtime CPU, and tens of thousands of defunct children whose parent (`PPID`) is a `conmon` instance — is a classic exec-probe leak in the OCI runtime stack.

For each `exec` probe (`livenessProbe.exec`, `readinessProbe.exec`, `startupProbe.exec`) the kubelet asks the runtime to spawn a short-lived process inside the target container. The runtime executes it through `conmon`, which forks the probe binary and is supposed to reap the child once it exits. Under sustained pressure (high probe frequency, slow filesystem, high concurrent exec count) the runtime can lose the reap signal and leave the exited probe as a zombie. With a probe that runs every couple of seconds across many pods, the zombie count grows quickly into the thousands — at which point the runtime spends most of its CPU on bookkeeping, kubelet probe latencies climb, and unrelated probes start failing.

A defining feature of this leak: the parent of each zombie is **not** the application — it is `conmon`, with the runtime as the grandparent. Application code is not the source.

## Resolution

The long-term fix is a runtime-level patch (the leak has been addressed in current releases of the runtime that ACP ships). Confirm the runtime version on the affected node and upgrade if it is below the fixed version; the upgrade is delivered through the platform's node-config / Immutable Infrastructure surface, not through manual rpm operations on the host.

If the node is already on a fixed runtime version and the same symptom recurs, treat it as a fresh investigation rather than the same leak — see the diagnostic steps below to identify the source.

### Tactical: restart the offending pods

Until the node-level fix is in place, the leak can be drained by restarting the pods whose `conmon` parents are accumulating zombies. The pods themselves are healthy; the parent runtime processes that are leaking will be re-created clean when the pod restarts.

1. Identify the pods. Map the `PPID` of zombies back to a `conmon` PID, then back to a container ID, then to a pod (see Diagnostic Steps).
2. Validate that the workload tolerates a single-pod restart. For replicated services this is usually trivial; for singleton workloads, plan a maintenance window.
3. Restart by deleting the pod (the controller re-creates it):

   ```bash
   kubectl -n <ns> delete pod <pod>
   ```

This drops the leaked zombies attached to that pod's `conmon` and resets the leak counter. It does not fix the leak — the same pod will accumulate again.

### Strategic: reduce exec-probe pressure

While the runtime fix rolls out, reducing the amount of exec-probe work that the runtime has to do also pushes the leak rate down:

- **Replace `exec` probes with `httpGet` or `tcpSocket` probes** wherever the application exposes a reachable endpoint. HTTP and TCP probes are handled by the kubelet directly and never spawn a child process.
- **Lengthen `periodSeconds`** on probes whose tight cadence is not actually needed. Going from `1s` to `10s` cuts the spawn rate by a factor of ten.
- **Drop redundant probes.** A startup probe followed by a liveness probe that runs the same command is doing the work twice.

These changes are workload-side and survive any node restart.

### Drain and reboot when the leak is severe

If a node has tens of thousands of zombies, the cleanest recovery is to drain it and reboot — `conmon` cleanup at startup is reliable, and the new boot starts from zero.

```bash
NODE=<worker>
kubectl cordon $NODE
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data
# trigger a reboot via the platform node surface, not via direct host commands
kubectl uncordon $NODE
```

Reboot through the platform's node-config surface so the action is visible in the audit trail; do not `ssh` and `reboot` directly.

## Diagnostic Steps

1. **Confirm the node is loaded and find the top consumers**:

   ```bash
   kubectl debug node/<node> -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host top -bn1 | head -n 30
   ```

   `crio` and `kubelet` near the top with very high `%CPU` is the first clue.

2. **Count zombies and find their parents**. From a debug pod on the node:

   ```bash
   chroot /host bash -c 'ps -elfL | awk "\$2==\"Z\" {print \$5}" | sort | uniq -c | sort -rn | head'
   ```

   The output is `<count> <ppid>`; high counts under a small number of `PPIDs` is the leak signature.

3. **Check that the parents are `conmon`**, not the application itself. A leaking `conmon` is the runtime issue; a leaking application parent is something else.

   ```bash
   chroot /host bash -c 'for ppid in <ppid1> <ppid2>; do echo "--- $ppid ---"; ps -p $ppid -o pid,ppid,comm; done'
   ```

   The `comm` should be `conmon`. The grandparent will be the container runtime.

4. **Map `conmon` back to a pod**. The `conmon` cgroup path encodes the container ID; from there, the pod is one runtime call away:

   ```bash
   chroot /host bash -c 'cat /proc/<conmon-pid>/cgroup'
   chroot /host crictl ps --no-trunc | grep <container-id-prefix>
   chroot /host crictl inspect <container-id> | jq '.info.config.labels'
   ```

   The labels include `io.kubernetes.pod.namespace` and `io.kubernetes.pod.name`.

5. **Inspect the pod's probes** to see whether they are `exec`-based and how often they run:

   ```bash
   kubectl -n <ns> get pod <pod> -o yaml \
     | yq '.spec.containers[].livenessProbe, .spec.containers[].readinessProbe, .spec.containers[].startupProbe'
   ```

   `exec` probes with very small `periodSeconds` are the workloads most likely to be feeding the leak.

6. **Cross-check across the cluster** to find every pod with the same probe pattern, so the workaround can be applied at the source rather than per-pod:

   ```bash
   kubectl get pods -A -o json \
     | jq -r '.items[]
              | select(.spec.containers[]?.livenessProbe.exec)
              | "\(.metadata.namespace)/\(.metadata.name)"'
   ```

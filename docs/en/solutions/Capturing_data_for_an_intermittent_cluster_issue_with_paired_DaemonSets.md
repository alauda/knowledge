---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Some cluster failures are by nature intermittent: a DNS resolution times out occasionally, an in-cluster service request fails sporadically, packet loss appears once every several minutes. Reproducing the failure on demand is impractical, and waiting for it to happen with no instrumentation in place leaves no usable post-mortem.

What is needed is a low-overhead, always-on observer pinned to the affected nodes that:

1. Continuously probes for the symptom and notices the moment it occurs.
2. Captures, at that moment, the runtime context (network counters, sockets, and a packet trace) that will let the on-call engineer attribute the failure.

This article shows a reusable pattern based on **two paired DaemonSets** — a non-privileged probe and a privileged collector — that solves both halves at once. The example is written for an intermittent in-cluster DNS failure but the same shape works for any scenario where the symptom can be expressed as a one-line shell test.

## Resolution

The procedure deploys two DaemonSets, both gated on a node label so that the observer only runs where it is wanted:

- **Probe** (non-privileged, `SYS_PTRACE` only): runs the symptom test in a tight loop. When the test fails, it triggers the collector.
- **Collector** (privileged, hostNetwork): on trigger, captures node-level packet traces and host counters. Stays passive otherwise, which keeps overhead near zero on healthy nodes.

### 1. Mark the nodes to observe

Apply a label to every node where the issue has been reported:

```bash
kubectl label node <node-1> example-debug-enable=true
kubectl label node <node-2> example-debug-enable=true
```

Both DaemonSets below pin themselves to this label via `nodeSelector`, so adding or removing the label is enough to control where the observers run.

### 2. Deploy the probe DaemonSet

The probe runs `getent hosts` (or any other one-line test) every 5 seconds. When the test exits non-zero, it writes a trigger file to a shared `emptyDir`, which the collector watches.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: intermittent-probe
  namespace: kube-debug
spec:
  selector:
    matchLabels: { app: intermittent-probe }
  template:
    metadata:
      labels: { app: intermittent-probe }
    spec:
      nodeSelector:
        example-debug-enable: "true"
      containers:
        - name: probe
          image: <utility-image-with-coreutils-and-strace>
          securityContext:
            capabilities:
              add: ["SYS_PTRACE"]
          command:
            - /bin/sh
            - -c
            - |
              set -u
              while true; do
                if ! getent hosts kubernetes.default.svc.cluster.local >/dev/null 2>&1; then
                  ts=$(date -u +%Y%m%dT%H%M%SZ)
                  # Local context: process-level strace + curl probe
                  strace -Tttyvvvf -s 8192 \
                    -o "/share/strace-${ts}.out" \
                    curl -k --max-time 5 https://kubernetes.default.svc.cluster.local/livez
                  # Mark the trigger so the collector dumps node-level state
                  date -u +%Y-%m-%dT%H:%M:%SZ > "/share/trigger-${ts}"
                fi
                sleep 5
              done
          volumeMounts:
            - { name: share, mountPath: /share }
      volumes:
        - { name: share, emptyDir: {} }
```

`SYS_PTRACE` lets `strace` attach to the in-pod `curl` process without elevating the whole pod to privileged. Everything else stays inside the pod's namespaces.

### 3. Deploy the collector DaemonSet

The collector watches the same shared directory for trigger files. When a new trigger appears it dumps node-level state into a timestamped subdirectory and clears the trigger.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: intermittent-collector
  namespace: kube-debug
spec:
  selector:
    matchLabels: { app: intermittent-collector }
  template:
    metadata:
      labels: { app: intermittent-collector }
    spec:
      hostNetwork: true
      hostPID: true
      nodeSelector:
        example-debug-enable: "true"
      containers:
        - name: collector
          image: <utility-image-with-tcpdump>
          securityContext:
            privileged: true
          command:
            - /bin/sh
            - -c
            - |
              set -u
              # Long-running rotating capture on the node's interfaces.
              # 20 MiB ring, last 4 files retained — keeps disk bounded.
              tcpdump -B 20480 -s 260 -nni any \
                -C 20 -W 4 -w /share/node.pcap \
                'port 53 or port 5353 or icmp or arp' &
              while true; do
                for trig in /share/trigger-*; do
                  [ -e "$trig" ] || continue
                  ts=$(basename "$trig" | sed 's/^trigger-//')
                  out=/share/node-state-${ts}
                  mkdir -p "$out"
                  nstat -zas      > "$out/nstat.txt"
                  cat /proc/net/snmp > "$out/snmp.txt"
                  ss -anp           > "$out/ss.txt"
                  top -H -b -n 1    > "$out/top.txt"
                  rm -f "$trig"
                done
                sleep 2
              done
          volumeMounts:
            - { name: share, mountPath: /share }
      volumes:
        - { name: share, emptyDir: {} }
```

The collector deliberately stays passive most of the time. The expensive packet capture is bounded by file rotation; the per-event dumps run only when the probe finds a problem, so the total overhead on a healthy node is negligible.

### 4. Adapt the probe to other scenarios

The shape generalises by replacing the probe loop's symptom test:

| Scenario | Probe test |
|---|---|
| Intermittent DNS failure | `getent hosts <name>` |
| Sporadic 5xx from in-cluster service | `curl -fsS --max-time 5 http://<svc>.<ns>/healthz` |
| Sudden TCP RSTs against an external host | `nc -zv -w 5 <host> 443` |
| API server unreachable from a node | `curl -k https://kubernetes.default/livez` |

The collector does not need to change between scenarios — it just dumps everything that might be relevant when something has already failed.

### 5. Tear down once the failure is captured

When the issue has been reproduced and the artifacts copied off the affected nodes, remove the workload and the node label:

```bash
kubectl delete daemonset -n kube-debug intermittent-probe intermittent-collector
kubectl label node <node-1> example-debug-enable-
```

Leaving the DaemonSets running long-term is wasteful even though the steady-state cost is small; treat them as temporary instrumentation, not standing infrastructure.

## Diagnostic Steps

1. Confirm both DaemonSets are scheduled on every targeted node:

   ```bash
   kubectl -n kube-debug get pod -o wide \
     -l 'app in (intermittent-probe,intermittent-collector)'
   ```

2. Tail the probe pod on a node where the symptom is expected. A successful probe loop is silent until something fails, then prints the trigger timestamp:

   ```bash
   kubectl -n kube-debug logs -f <probe-pod>
   ```

3. After a trigger has fired, copy the captured artifacts out of the collector pod for offline analysis:

   ```bash
   kubectl -n kube-debug cp <collector-pod>:/share /tmp/capture-<node>/
   ls /tmp/capture-<node>/
   ```

4. Inspect the captured state. The pairing — process-level `strace` from the probe and a node-level `tcpdump` from the collector, both timestamped — is what makes attribution possible: the probe shows what the application saw, the collector shows what was on the wire, and the timestamps line them up.

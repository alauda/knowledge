---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Collecting Worker Node CPU, Memory, Interrupt, and Network Metrics via DaemonSet
## Issue

Worker nodes are showing CPU load spikes, memory pressure, or interrupt storms and the platform-native monitoring stack does not capture the sub-second kernel-level signals needed to diagnose the root cause. Typical scenarios:

- A workload triggers a hot path inside the kernel (softirq flood, contended spinlock) that Prometheus scrape intervals of 30–60 seconds cannot resolve.
- Host-level tooling output (`sar`, `pidstat`, `/proc/interrupts`, `/proc/softirqs`) needs to be collected simultaneously on every node over the window the problem reproduces, then consolidated into a tarball for offline analysis.
- A network-level investigation (HAProxy, conntrack, qdisc stats, per-interface counters) needs the same timed snapshots.

Running these tools ad-hoc inside a single debug shell on one node does not scale to a fleet-wide incident. The solution is a DaemonSet that launches a privileged pod on every targeted node, runs the collection scripts under a shared ConfigMap, and leaves behind an extractable archive per node.

## Resolution

### Step 1 — namespace and privileges

Create a dedicated namespace for the collection pods and give its default service account the privileges required to run the collector as root on the host with `hostPID`, `hostNetwork`, and `hostIPC`. This grant is scoped to the diagnostic namespace only.

```bash
kubectl create namespace metrics-debug
```

Attach whatever privileged PodSecurity / Pod Security Admission configuration your cluster uses to this namespace so the collector pods can run as root with host namespaces. The exact label depends on the policy enforced — for a cluster using the upstream PSA labels:

```bash
kubectl label namespace metrics-debug \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/audit=privileged \
  pod-security.kubernetes.io/warn=privileged
```

### Step 2 — ConfigMap with the collector scripts

The first ConfigMap carries two scripts: an install script that pulls in the required packages inside the container, and a collector that starts the snapshot loops in the background, writes the outputs to `/metrics`, and tars the result at the end.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: metrics-scripts
  namespace: metrics-debug
data:
  install-requirements.sh: |
    #!/bin/bash
    dnf install -y procps-ng perf psmisc hostname iproute sysstat iotop
  collect-metrics.sh: |
    #!/bin/bash
    INTERVAL=1
    DURATION=${DURATION:-inf}
    mkdir -p /metrics && rm -rf /metrics/*
    uname -n > /metrics/hostname.txt
    pidstat -ruwh ${INTERVAL} > /metrics/pidstat.txt &
    sar -A ${INTERVAL} > /metrics/sar.txt &
    bash -c "while true; do date; free -m; sleep ${INTERVAL}; done" > /metrics/free.txt &
    bash -c "while true; do date; cat /proc/softirqs; sleep ${INTERVAL}; done" > /metrics/softirqs.txt &
    bash -c "while true; do date; cat /proc/interrupts; sleep ${INTERVAL}; done" > /metrics/interrupts.txt &
    echo "collection started; running for ${DURATION}"
    sleep "${DURATION}"
    pkill -P $$ || true
    sync
    tar -czf /metrics.tar.gz /metrics
    echo "done"
```

Apply it:

```bash
kubectl -n metrics-debug apply -f metrics-scripts-configmap.yaml
```

Tune `INTERVAL` (sample period in seconds) and `DURATION` (total collection window, or `inf` for until the pod is deleted) to the investigation window. One-second sampling is fine for short bursts; raise it for multi-hour captures or the archive balloons.

### Step 3 — DaemonSet that mounts the scripts and runs them on every worker

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: metrics-daemonset
  namespace: metrics-debug
  labels:
    app: metrics-daemonset
spec:
  selector:
    matchLabels:
      app: metrics-daemonset
  template:
    metadata:
      labels:
        app: metrics-daemonset
    spec:
      nodeSelector:
        node-role.kubernetes.io/worker: ""
      hostPID: true
      hostIPC: true
      hostNetwork: true
      containers:
        - name: metrics-daemonset
          image: fedora:latest
          command:
            - /bin/bash
            - -c
            - bash /entrypoint/install-requirements.sh && bash /entrypoint/collect-metrics.sh && sleep infinity
          securityContext:
            runAsUser: 0
            runAsGroup: 0
            privileged: true
          volumeMounts:
            - name: entrypoint
              mountPath: /entrypoint
      volumes:
        - name: entrypoint
          configMap:
            name: metrics-scripts
```

Remove the `nodeSelector` stanza to run on every node instead of only workers; change the label key to target a specific node pool.

```bash
kubectl -n metrics-debug apply -f metrics-daemonset.yaml
kubectl -n metrics-debug get pod -l app=metrics-daemonset -o wide
kubectl -n metrics-debug logs -l app=metrics-daemonset --prefix --timestamps --tail=50
```

Once the collector scripts print `done` (or you have decided the current window is enough and are terminating a `DURATION=inf` run), copy the per-node archives to a local directory, using both pod name and node name in the destination filename so it is unambiguous which tarball came from where:

```bash
mkdir -p metrics-out
for pod in $(kubectl -n metrics-debug get pod -l app=metrics-daemonset -o name); do
  node=$(kubectl -n metrics-debug get "$pod" -o jsonpath='{.spec.nodeName}')
  name=${pod##*/}
  kubectl -n metrics-debug cp "${name}:/metrics.tar.gz" "metrics-out/metrics.${name}.${node}.tar.gz"
done
tar -czf metrics.tar.gz metrics-out
```

### Step 4 — network-focused companion DaemonSet

For network latency, conntrack leaks, or packet-drop investigations, ship a second ConfigMap with a `monitor.sh` that collects `ss`, `ip`, `tc`, `ethtool`, `conntrack`, `/proc/net/*`, and `/proc/softirqs` at a configurable delay and iteration count, plus a matching DaemonSet. The structure mirrors the general-metrics one; the container also needs `NET_ADMIN` capability to run `conntrack -L` and `tc -s`:

```yaml
securityContext:
  capabilities:
    add: ["NET_ADMIN"]
```

When the workload under investigation is a specific service on the host — for example an ingress controller — the network collector can also enter that process's network namespace with `nsenter -n -t <pid>` to capture per-service socket state and conntrack entries, by resolving the PID inside the collector script at runtime.

Tear everything down when the capture is complete so the cluster stops carrying privileged pods:

```bash
kubectl delete namespace metrics-debug
```

## Diagnostic Steps

Confirm the DaemonSet actually scheduled on every targeted node — a node that was cordoned or had a matching taint without the DaemonSet tolerating it silently drops out:

```bash
kubectl -n metrics-debug get pod -l app=metrics-daemonset \
  -o custom-columns=POD:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
kubectl get node -o name | wc -l
```

The pod count should match the node count (or node-selector count). Mismatches usually mean either a taint without a matching toleration, or insufficient privileges (container fails `CrashLoopBackOff` during the privileged `dnf install` step).

Check progress on a single node by tailing its collector output while it runs:

```bash
kubectl -n metrics-debug exec -it metrics-daemonset-<random> -- \
  bash -c 'ls -la /metrics && head /metrics/sar.txt'
```

Verify the tarball is well-formed before ending the window:

```bash
tar -tf metrics-out/metrics.<pod>.<node>.tar.gz | head
```

For long-running captures, watch the archive grow on the pod filesystem — a non-growing size usually means one of the background samplers has died and the container is writing to a stale file descriptor:

```bash
kubectl -n metrics-debug exec -it metrics-daemonset-<random> -- \
  bash -c 'du -sh /metrics; wc -l /metrics/*.txt'
```

If the container itself is being killed by the kubelet for running out of memory during collection (the `sar` / `pidstat` log files grow indefinitely), lower the `INTERVAL`, shorten `DURATION`, or add `resources.limits.memory` on the DaemonSet Pod spec and use log rotation inside the collector.

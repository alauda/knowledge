---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Collecting host-level performance and network telemetry via privileged DaemonSets on ACP

## Issue

On Alauda Container Platform clusters where the first-party monitoring stack is not yet deployed, operators still need raw, per-node kernel telemetry — CPU, memory, IRQ/softirq, process tables, block I/O, and full network state — to diagnose worker-node performance problems. The standard delivery vehicle is a per-node DaemonSet running a privileged container with `hostPID: true`, `hostIPC: true`, `hostNetwork: true`, and `securityContext.runAsUser: 0` plus `privileged: true`, mounting two ConfigMaps (`install-requirements.sh`, `collect-metrics.sh`) at `/entrypoint`, then running `bash /entrypoint/install-requirements.sh && bash /entrypoint/collect-metrics.sh && sleep infinity`.

ACP first-party monitoring is delivered by the `prometheus-operator` PackageManifest (displayName `Alauda build of Prometheus`), with the higher-level descriptors `Alauda Container Platform Monitoring for Prometheus` and `Alauda Container Platform Monitoring for VictoriaMetrics`. On a freshly-installed cluster without that operator (no `prometheuses.monitoring.coreos.com` CRD and no node-exporter pod present), the DaemonSet pattern below is the only available host-level telemetry path.

## Root Cause

Inside a `hostPID: true` privileged pod, processes on the underlying node are visible to in-container tooling: `ps`, `pidstat -ruwh`, and `top` enumerate node-wide processes, and `/proc/interrupts` plus `/proc/softirqs` reflect the host kernel's per-CPU IRQ/softirq counters rather than the container's PID-1 subview. The behavior is exercised on this cluster against Linux kernel 5.15 with containerd 2.2.1 as the node runtime. That direct host-namespace access is what makes a single DaemonSet pod sufficient to capture genuine node-level signal without an in-cluster monitoring agent.

ACP does not ship a vendor-specific pod-security-constraints CRD chain; pod admission is governed exclusively by Kubernetes PodSecurity Admission (PSA), and the cluster-wide default policy is configured at `warn` level against the `baseline` profile. A privileged hostPID/hostIPC/hostNetwork pod is therefore admitted with a `PodSecurity baseline:latest` warning and runs without any cluster-side security-policy grant on the target namespace.

## Resolution

Use a namespace with no PSA `enforce` label (the cluster default of warn-only `baseline` admits the workload). The pod image must be reachable from the cluster — either a base image (e.g. `alpine` or `ubuntu`) mirrored into the internal registry, or a tool image such as `registry.alauda.cn:60080/3rdparty/kubectl:v4.3.1` extended with the diagnostic toolchain. The DaemonSet target set is the node group of interest; on this ACP cluster topology worker nodes carry no `node-role.kubernetes.io/worker` label (only the control-plane node carries `node-role.kubernetes.io/*` role labels), so omit the nodeSelector entirely to land on every node, or scope to non-control-plane nodes with `affinity.nodeAffinity` using a `node-role.kubernetes.io/control-plane DoesNotExist` requirement.

DaemonSet skeleton (substitute `<image>` with an internally-pullable base image carrying `bash`, `tar`, and a package manager; the ConfigMaps below carry the actual collection scripts):

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: metrics-daemonset
  namespace: metrics-debug
spec:
  selector:
    matchLabels:
      app: metrics-daemonset
  template:
    metadata:
      labels:
        app: metrics-daemonset
    spec:
      hostPID: true
      hostIPC: true
      hostNetwork: true
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node-role.kubernetes.io/control-plane
                operator: DoesNotExist
      containers:
      - name: collector
        image: <image>
        securityContext:
          runAsUser: 0
          privileged: true
        command: ["/bin/bash", "-c"]
        args:
        - "bash /entrypoint/install-requirements.sh && bash /entrypoint/collect-metrics.sh && sleep infinity"
        volumeMounts:
        - name: entrypoint
          mountPath: /entrypoint
      volumes:
      - name: entrypoint
        configMap:
          name: collector-scripts
          defaultMode: 0755
```

The `collect-metrics.sh` ConfigMap collects five mandatory host-level performance streams in parallel, each as a background process writing into `/metrics/`: `pidstat -ruwh ${INTERVAL}` to `pidstat.txt`, `sar -A ${INTERVAL}` to `sar.txt`, a `while` loop emitting `date; free -m; sleep ${INTERVAL}` to `free.txt`, the same loop pattern dumping `/proc/softirqs` to `softirqs.txt` and `/proc/interrupts` to `interrupts.txt`, plus two optional streams `ps aux | sort -nrk 3,3 | head -n 20` and `iotop -Pobt`. After `${DURATION}` the script kills the children, calls `sync`, then `tar -czf /metrics.tar.gz /metrics`.

For network-layer capture, deploy a second DaemonSet (`monitor-daemonset`) sharing the same privileged hostPID/hostIPC/hostNetwork shape but running a `monitor.sh` ConfigMap that, every `${DELAY}` seconds for `${ITERATIONS}` iterations, collects `ss`, `nstat`, `netstat -s`, `ip address/route/neigh`, `tc -s qdisc`, `cat /proc/interrupts`, `/proc/net/softnet_stat`, `/proc/vmstat`, `ps -alfe`, `mpstat`, `top -c -b -n1`, `numastat`, `cat /proc/softirqs`, `cat /proc/net/sockstat`, `/proc/net/dev`, `ethtool -S <dev>`, and per-interface `/sys/.../statistics/*` into `${HOSTNAME}-network_stats_${now}/`. Independently `conntrack -L -n` runs in a background loop. The final archive is `/network-metrics.tar.gz`.

## Diagnostic Steps

Once a collection run finishes, extract the bundle from each pod and verify the archive:

```bash
kubectl cp -n metrics-debug <pod>:/metrics.tar.gz metrics.<pod>.<node>.tar.gz
tar -tf metrics.<pod>.<node>.tar.gz
```

The bundle contents — `metrics/pidstat.txt`, `metrics/sar.txt`, `metrics/interrupts.txt`, `metrics/softirqs.txt`, `metrics/free.txt`, optional `metrics/ps.txt`, `metrics/iotop.txt` — are independent of any in-cluster monitoring stack and represent raw kernel telemetry directly off the node.

For the network DaemonSet, retrieve `/network-metrics.tar.gz` the same way:

```bash
kubectl cp -n metrics-debug <pod>:/network-metrics.tar.gz network-metrics.<pod>.<node>.tar.gz
```

Inspect the per-iteration subdirectories for `ss`, `nstat`, `ethtool -S`, conntrack snapshots, and per-interface counters to correlate kernel-level network state with the host-OS performance streams from the first DaemonSet.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500167
---

# Collecting per-node diagnostics for intermittent issues via node-labeled DaemonSets on ACP

## Issue

Intermittent, node-local symptoms — sporadic DNS resolution failures, transient packet loss, occasional thread spikes — are hard to catch with one-shot probes because the symptom may have cleared by the time an operator opens a shell on the suspect node. On Alauda Container Platform (Kubernetes v1.34.5, containerd 2.2.1-5 on Linux kernel 5.15.0-56), a practical pattern is to pre-stage two DaemonSets gated by a custom node label so that nothing runs until an operator opts a specific node in, then label the target node when the symptom is observed so collection starts immediately on that node only. The DaemonSet controller is the same upstream primitive ACP uses for its own platform agents and reliably honors label-based scheduling for user workloads.

## Root Cause

A diagnostic workload that must capture host-namespace traffic, inspect host threads, or run trace-style probes needs elevated Pod settings — `securityContext.privileged: true`, `hostNetwork: true`, `hostPID: true`, or `securityContext.capabilities.add: [SYS_PTRACE]`. The settings are not interchangeable: `hostNetwork: true` puts the container in the host network namespace (so a packet capture sees host-side traffic), while `hostPID: true` puts it in the host PID namespace (so `top -H` / `ps` see host processes and threads rather than only the container's own). Capturing host threads therefore requires `hostPID: true` specifically — `privileged: true` alone does not join the host PID namespace. On ACP the admission gate for these settings is Pod Security Admission applied via namespace labels rather than a per-ServiceAccount security primitive: the namespace's `pod-security.kubernetes.io/enforce` level determines whether such a Pod is admitted. Submitting the manifests against an unlabeled namespace such as `default` materializes the object (the API server returns the object on `kubectl create --dry-run=server`) but the apiserver emits a baseline-level `Warning` for the elevated fields; a namespace whose enforce label is set to a restrictive level would reject the same Pod outright.

## Resolution

Stage the two DaemonSets in a namespace whose Pod Security Admission level admits privileged Pods. Label the target namespace so PSA does not reject the elevated Pod spec, then submit the manifests. Until a node carries the activation label, the DaemonSet controller schedules zero pods, so the workload is dormant by default.

```bash
kubectl label namespace <ns> \
 pod-security.kubernetes.io/enforce=privileged --overwrite
```

The non-privileged "tester" DaemonSet runs a tight polling loop — `getent hosts <name>` every 5 seconds — to record when DNS resolution intermittently fails, and is granted the `SYS_PTRACE` Linux capability via `securityContext.capabilities.add: [SYS_PTRACE]` so it can run trace-style probes on its own processes without escalating to full privileged. The capability is a standard core/v1 Pod-spec field; the kubelet applies it via the OCI runtime once the namespace's PSA level admits the Pod.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-diag-tester
spec:
  selector:
    matchLabels:
      app: node-diag-tester
  template:
    metadata:
      labels:
        app: node-diag-tester
    spec:
      nodeSelector:
        node-diag-enable: "true"
      containers:
        - name: tester
          image: <diagnostic-image>
          securityContext:
            capabilities:
              add: ["SYS_PTRACE"]
          command: ["/bin/sh", "-c"]
          args:
            - |
              while true; do
                getent hosts kubernetes.default.svc.cluster.local \
                  || echo "$(date -Is) resolve-failed" >> /var/log/tester.log
                sleep 5
              done
```

The privileged "collector" DaemonSet runs with `securityContext.privileged: true`, `hostNetwork: true`, and `hostPID: true` so it can perform host-level packet capture and process / thread inspection. Under those Pod settings the collector container can carry standard Linux diagnostic tools — packet capture, socket-statistics, syscall trace — and run them against the host network and PID namespaces; the exact tool inventory is image-dependent and chosen by the operator at build time. `hostNetwork: true` places the container in the host network namespace, so an in-pod packet capture observes host-namespace traffic rather than only pod-side interfaces; `hostPID: true` places it in the host PID namespace, so `top -H` / `ps` enumerate host processes and threads rather than only the container's. Omitting `hostPID: true` is the common mistake here — without it, `top -H` reports only the collector container's own threads and the host-thread snapshot is empty of node processes.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-diag-collector
spec:
  selector:
    matchLabels:
      app: node-diag-collector
  template:
    metadata:
      labels:
        app: node-diag-collector
    spec:
      nodeSelector:
        node-diag-enable: "true"
      hostNetwork: true
      hostPID: true
      containers:
        - name: collector
          image: <diagnostic-image>
          securityContext:
            privileged: true
          volumeMounts:
            - name: capture
              mountPath: /capture
      volumes:
        - name: capture
          hostPath:
            path: /var/log/node-diag
            type: DirectoryOrCreate
```

Activate collection on a target node by applying the label; the DaemonSet controller schedules the tester and collector pods onto exactly the labeled node(s) on its next sync. The label key is operator-chosen — use any short, case-scoped key consistent with the rest of the recipe (`node-diag-enable` below is one example) — but it must match the `nodeSelector` in both DaemonSet manifests. Before any node carries the label, no pods are scheduled and the workload has zero footprint.

```bash
kubectl label node <node> node-diag-enable=true
```

To stop collection on a node, remove the activation label; once no node matches the DaemonSet's `nodeSelector`, the controller schedules no pods onto that node.

```bash
kubectl label node <node> node-diag-enable-
```

## Diagnostic Steps

At node scope, the privileged collector additionally runs a longer `tcpdump` filtered to name-resolution and link traffic to capture DNS flows from the host network namespace, and snapshots host-level threads with `top -H -b -n 1`. The `tcpdump` capture relies on `hostNetwork: true` + `privileged: true`; the `top -H` host-thread snapshot additionally relies on `hostPID: true` (without it, `top -H` sees only the container's own threads). All three settings must be admitted by the namespace's PSA enforce level.

```bash
tcpdump -B 20480 -s 260 -i any -w /capture/<node>-$(date +%s).pcap \
 port 53 or port 5353 or icmp or arp
top -H -b -n 1 > /capture/<node>-top-$(date +%s).out
```

Before labeling a node, confirm zero nodes currently match the activation label — the node-side check is the load-bearing one for label-gating correctness, and it should return "No resources found" until the operator opts a target node in.

```bash
kubectl get nodes -l node-diag-enable=true
```

After labeling, verify a pod from each DaemonSet has landed on the target node and is running:

```bash
kubectl get pods -o wide -l app=node-diag-tester
kubectl get pods -o wide -l app=node-diag-collector
```

Artifacts produced by the host-level captures (pcap files from `tcpdump`, the `strace` output, and the `top -H` snapshot) are written under the collector's hostPath mount on the labeled node and can be retrieved with `kubectl cp` from the collector pod or pulled directly from the node filesystem out-of-band.

---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500001
---
## Overview

Kubernetes records every meaningful state change as an `Event` object. An event holds context about who created or mutated a resource, what controller acted on it, and why; together they are the primary breadcrumb trail for debugging scheduling, image pulls, probe failures, OOMs, and reconciliation loops. Because every reconciliation cycle of every controller can emit one or more events, the event volume far outpaces ordinary resource churn — often by an order of magnitude on a busy cluster.

To keep etcd from filling up, the apiserver garbage-collects events after a fixed time-to-live. Operators frequently ask three questions about this: how long are events retained, can the retention be tuned, and what to do when 24 hours of event history is needed for forensic work. This article answers each.

## Resolution

### Default retention

The apiserver flag that controls event lifetime is `--event-ttl`. Its default in upstream Kubernetes is **one hour**. Many platform-managed apiservers raise this to **three hours** during cluster bring-up; the resulting behaviour — every event silently disappearing about three hours after it was created — is what most cluster engineers observe in practice.

Confirm the effective value on a running cluster:

```bash
kubectl -n kube-system get pod -l component=kube-apiserver \
  -o jsonpath='{.items[0].spec.containers[0].command}' \
  | tr ',' '\n' | grep -E 'event-ttl|--event-ttl'
```

If `--event-ttl` is absent the apiserver is using the upstream default. A `--event-ttl=3h` flag indicates a three-hour retention.

### Tuning the retention window

The flag is a static apiserver argument, so changing it requires re-rolling the apiserver pods. On a self-managed cluster (kubeadm or comparable installer), set the flag in the apiserver manifest and let the kubelet restart the static pod:

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml on each control-plane node
spec:
  containers:
    - name: kube-apiserver
      command:
        - kube-apiserver
        - --event-ttl=24h
        # ... other flags ...
```

On a platform whose apiserver is managed by an operator, the value is exposed through the operator's CR rather than the manifest. The legal range is **5 minutes to 180 minutes (3 hours)** under most platform-managed apiservers — bumping above that is rejected because event volume × extended retention can outgrow the etcd compaction budget and trigger 5xx responses on writes.

Before raising `--event-ttl`, size etcd accordingly:

- Storage: events typically sit in the 0.5–2 KiB range; a busy cluster easily generates 50 events / second, which means tripling retention from 3 h to 9 h adds roughly 1 GiB of etcd payload.
- Compaction: events keep history until compaction passes them; a longer TTL pushes the compaction lag and increases peak `etcd_db_total_size_in_bytes`.

### When 3 hours is not enough — forward events to a log store

The supported pattern for arbitrarily long event history is **not** to keep events in etcd, but to ship them to the cluster's log store the same way logs are shipped. Two common shapes:

1. **eventrouter** — a small Deployment that watches the events API and writes structured log lines to stdout. Pair it with the cluster log forwarder so its stdout ends up in Loki / Elasticsearch / S3 alongside container logs.
2. **kube-events-exporter** (or any controller that writes to a Loki-compatible push API) — direct ship from the events API to the log backend.

Sample eventrouter Deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: eventrouter
  namespace: cpaas-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: eventrouter
  template:
    metadata:
      labels:
        app: eventrouter
    spec:
      serviceAccountName: eventrouter
      containers:
        - name: eventrouter
          image: registry.example.com/cpaas/eventrouter:v0.4
          args:
            - --v=2
            - --logtostderr
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
```

Bind it to a ClusterRole that permits `events:list,watch` cluster-wide:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: eventrouter
rules:
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: eventrouter
roleBinding:
subjects:
  - kind: ServiceAccount
    name: eventrouter
    namespace: cpaas-system
roleRef:
  kind: ClusterRole
  name: eventrouter
  apiGroup: rbac.authorization.k8s.io
```

Once the eventrouter pod is running, its stdout carries one JSON object per Kubernetes event; the cluster log collector picks those up as `infrastructure` logs (or whichever stream the platform routes the `cpaas-system` namespace into) and they land in the long-term log store with the same retention policy as the rest of the platform telemetry.

### Manually purging events

When etcd is overwhelmed by an event storm — typically a controller in tight loop emitting per-second warnings — the events accumulate faster than `--event-ttl` can clear them, etcd grows quickly, and writes start to slow. Manual cleanup is reasonable while the root cause is still being identified:

```bash
# Delete events in a single namespace
kubectl -n busy-namespace delete events --all

# Delete events older than a specific timestamp across all namespaces
THRESHOLD=$(date -u -d '6 hours ago' +%Y-%m-%dT%H:%M:%SZ)
kubectl get events --all-namespaces --sort-by=.lastTimestamp \
  -o json \
  | jq -r --arg t "$THRESHOLD" \
       '.items[] | select(.lastTimestamp < $t) |
        "\(.metadata.namespace) \(.metadata.name)"' \
  | while read NS NAME; do
      kubectl -n "$NS" delete event "$NAME" --ignore-not-found
    done
```

Both forms are safe: events have no controller side-effects when deleted; they exist purely as audit history.

## Diagnostic Steps

Confirm the apiserver's effective `--event-ttl`:

```bash
kubectl -n kube-system get pod -l component=kube-apiserver \
  -o yaml | yq '.items[0].spec.containers[0].command'
```

Inspect how many events currently sit in etcd, broken down by namespace:

```bash
kubectl get events -A --sort-by=.lastTimestamp \
  -o custom-columns=NS:.metadata.namespace \
  | sort | uniq -c | sort -rn | head -20
```

A lopsided distribution (one namespace producing the bulk) is the cue to throttle the noisy controller before changing retention.

If events appear to outlive `--event-ttl` (events from yesterday still visible after restart), the underlying etcd lease counters may not be advancing — TTL is enforced via etcd leases, and frequent etcd leader changes reset the lease counters locally. Look for leader churn:

```bash
kubectl -n kube-system logs ds/etcd -c etcd --tail=500 | grep -E 'leader|elected'
```

If leader elections are firing more than once an hour, fix the etcd health (disk latency, heartbeat budget) before debugging event retention.

For a deeper look at event volume over time, the apiserver `apiserver_request_total{resource="events"}` counter shows how many event writes the apiserver is taking — useful to size `--event-ttl` against expected steady-state load:

```bash
kubectl -n cpaas-monitoring exec deploy/prometheus-cluster-monitoring -- \
  promtool query instant http://localhost:9090 \
  'sum by (verb) (rate(apiserver_request_total{resource="events"}[5m]))'
```

If event-creation rate × `--event-ttl` exceeds available etcd headroom, raising the TTL is the wrong fix — fan out to the log store via eventrouter instead.

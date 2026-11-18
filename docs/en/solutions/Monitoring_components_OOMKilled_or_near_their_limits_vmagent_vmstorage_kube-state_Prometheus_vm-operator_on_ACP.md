---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12.x
  - 3.14.x
  - 3.16.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Monitoring components OOMKilled or near their limits: vmagent, vmstorage, kube-state, Prometheus, vm-operator on ACP

## Issue

A platform monitoring component in `cpaas-system` runs out of memory or stays near its limit:

- `vmagent-agent` restarts with `OOMKilled` / exit code `137`, ends in `CrashLoopBackOff` (`1/2` Ready), or fails its readiness probe so charts have gaps. Critical `cpaas-deployment-rules` alerts fire for `vmagent-agent`, and some nodes or the whole cluster have no data.
- `vmstorage-cluster` sits above 90% CPU or memory on one or every replica, or restarts with `OOMKilled`, and the page says some monitoring cannot be displayed (`部分监控无法显示`).
- `kube-prometheus-exporter-kube-state` is `OOMKilled`, and the Deployment CPU and memory trend panels are empty, or an inspection flags it as abnormal.
- The `prometheus` container is `OOMKilled` and monitoring data stops.
- `vm-operator` restarts on OOM and cluster monitoring is abnormal.

Sizes set directly on the live Deployment, StatefulSet or VictoriaMetrics object are often written back. The persistent place is the monitoring plugin configuration: Marketplace > Cluster Plugins > update the monitoring plugin > choose a custom scale and set the component quota. It is stored on the plugin's ModuleInfo as `spec.config.components.<component>.resources` (for example `vmagent`, `vmstorage`, `vmselect`, `kubeStateExporter`, `prometheus`).

## Root Cause

### Cause 1: vmagent is undersized for the scrape and remote-write load

`kubectl describe pod` shows `Last State: Terminated`, `Reason: OOMKilled`, `Exit Code: 137`, often with thousands of restarts. The log shows a normal start (`kubernetes_sd_configs: added targets: <n>`) and the kill a minute or two later, and after a restart:

```text
queue/... size (... bytes) is bigger than writer offset (... bytes); this may be the case on unclean shutdown (OOM, kill -9, hardware reset)
```

That line is a consequence of the OOM, not a second fault. The agent cache, scraping, and temporary remote-write buffers together exceed the limit (for example about 1.2Gi of cache plus about 200MB of scraping against a 2Gi limit). Triggers seen: a global `vmagent` at 1 CPU / 1Gi; a monitoring configuration change in the plugin; bulk, high-frequency calls to the platform API for container metrics, which also restart `vmselect`; and failed or timed-out scrapes cached in memory. Restarts that look causeless are still OOM: 15s samples are aggregated over 60s, so charts and the 90% alert can miss the peak. When the agent is near its limit without being killed, readiness probe failures show up as chart gaps instead of restarts.

A `vmagent` that restarts with `remote_write` `502 Bad Gateway` and is not `OOMKilled` is query overload from a very large `certificate_expires_time` series, and more memory does not fix it. Read the limit of the `vmagent` container, not of the `config-reloader` sidecar in the same Pod.

### Cause 2: vmstorage memory or CPU limit is too small for the stored series

Restart count is 0 and usage stays above 90%: the limit itself caps the component (for example memory request `1000Mi` / limit `2000Mi`, or a 4-core CPU limit on all three replicas). Tuning the VMCluster cache-hit setting and restarting does not lower CPU.

When the limit is far below the working set, one replica OOM-restarts (`OOMKilled`, exit `137`, memory at 155.80% of its limit, hundreds of restarts). That case is misleading: `vmagent` logs that it cannot write, restarting `vmagent` brings data back for a while, and the gap returns. The real failure is in `vminsert` and `vmstorage`:

```text
# vmagent
sending a block with size 258764 bytes to "2:secret-url" was rejected (skipping the block): status code 400; response body: duplicate sample for timestamp
# vminsert
cannot make a copy #2 out of 2 copies according to -replicationFactor=2 ... since a part of storage nodes is temporarily unavailable
cannot dial storageNode "vmstorage-cluster-0.vmstorage-cluster.cpaas-system:8400": ... connect: connection refused
```

`successfully dialed -storageNode` follows each time the replica returns, so the gap looks intermittent.

### Cause 3: kube-state-metrics is sized by /pod_nanny

The container command is `/pod_nanny` with `--container=exporter-kube-state`, `--cpu`, `--extra-cpu`, `--memory`, `--extra-memory`, `--threshold` and `--deployment=kube-prometheus-exporter-kube-state`. The addon resizer sets CPU from `--cpu` plus `--extra-cpu` per node and memory from `--memory` plus `--extra-memory` per node, so a patch to `resources` loses to the next nanny loop. Starting flags `--cpu=100m`, `--extra-cpu=5m`, `--memory=130Mi`, `--extra-memory=20Mi`, `--threshold=5` had already resized the Pod to `540m` / `1890Mi` and it still OOMed. On 3.12.2 the visible symptom was empty Deployment trend panels while kube-state restarted with `OOMKilled`.

### Cause 4: the Prometheus container limit is too small

The `prometheus` container is `OOMKilled` / exit `137` (for example `prometheus-kube-prometheus-0-0` at `Running (3/4)` with limits `cpu: 2` / `memory: 8000Mi`), and the business cluster's data stops, including in the global views. Doubling the limit let it stay up; 4 CPU / 16Gi stopped the restarts of an `8000Mi` instance.

### Cause 5: vm-operator is OOMKilled

After the cluster recovered from an outage, global monitoring dashboards were abnormal and `vm-operator` on the business cluster restarted with `OOMKilled`. Hosts near 100% memory at the same time are a separate problem to handle on the nodes.

## Resolution

### Cause 1: vmagent is undersized for the scrape and remote-write load

1. Confirm `137` / `OOMKilled` and read the real `vmagent` container limit:

   ```bash
   kubectl -n cpaas-system describe pod <vmagent-agent-pod> | grep -E 'Exit Code|Reason|OOMKilled'
   kubectl -n cpaas-system get pod <vmagent-agent-pod> -o jsonpath='{range .spec.containers[*]}{.name}{" req="}{.resources.requests.memory}{" lim="}{.resources.limits.memory}{"\n"}{end}'
   ```

2. Raise `vmagent` memory in the plugin configuration (custom scale). Sizes that stopped the restarts: `1000Mi` or 1Gi to 2Gi; 2Gi to 4Gi; `6000Mi`; 2 CPU / `2000Mi` where readiness failed above 80% memory. Under bulk API pulls, double CPU and memory of both `vmagent` and `vmselect`, then watch for another OOM.

3. If the plugin cannot be updated, edit the VMAgent object as a stop-gap:

   > **Warning:** Editing VMAgent `agent` restarts `vmagent`; scraping and remote write pause until the new Pod is Ready, and a size the nodes cannot hold leaves it Pending. Precondition: the last termination is `OOMKilled`, or readiness failures coincide with memory near the limit. Rollback: `kubectl apply -f /tmp/vmagent-agent.yaml`. Carry the value into the plugin configuration afterwards, or a reconcile writes it back.

   ```bash
   kubectl -n cpaas-system get vmagent agent -o yaml > /tmp/vmagent-agent.yaml
   kubectl -n cpaas-system edit vmagent agent
   ```

4. Confirm the running Pod shows the new limit and stops restarting. Do not delete the remote-write queue directory; `vmagent` repairs the queue on its next clean start.

### Cause 2: vmstorage memory or CPU limit is too small for the stored series

1. When `vmagent` restarts only help for a while, read `vmstorage` and `vminsert` first:

   ```bash
   kubectl -n cpaas-system describe pod <vmstorage-pod> | grep -E 'Reason|Exit Code|Restart Count'
   kubectl -n cpaas-system logs <vmagent-pod> -c vmagent --tail=300 | grep -E 'duplicate sample for timestamp|was rejected'
   kubectl -n cpaas-system logs <vminsert-pod> --tail=300 | grep -E 'cannot make a copy|cannot dial storageNode|broken pipe'
   ```

2. Raise the `vmstorage` limit in the plugin configuration, not with `kubectl edit sts vmstorage-cluster` (the plugin page stays read-only until the scale is switched to custom). Changes that cleared the alert: memory limit `2000Mi` to `4000Mi`; CPU limit 4 to 5 cores; CPU `1000m` to `2000m` where only gaps were seen. Without a better measurement, double the current limit and watch.

   > **Warning:** Changing `vmstorage` resources rolls the replicas one by one; writes and queries to a restarting replica fail over to the others, and with replication factor 2 a second failure during the roll can leave gaps. Rollback: set the previous values in the same form.

3. Confirm the new limit on the Pods:

   ```bash
   kubectl -n cpaas-system get pod | grep vmstorage
   kubectl -n cpaas-system get pod <vmstorage-pod> -o jsonpath='{.spec.containers[0].resources}{"\n"}'
   ```

An `OOMKilled` `vmstorage` is fixed by more `vmstorage` memory, not by another `vmagent` restart.

### Cause 3: kube-state-metrics is sized by /pod_nanny

1. Print the nanny flags:

   ```bash
   kubectl -n cpaas-system get deploy kube-prometheus-exporter-kube-state -o yaml | grep -n -E 'pod_nanny|--cpu|--memory|extra-cpu|extra-memory|threshold'
   ```

2. Raise both the base and the per-node extra so the result lands above the OOM working set (for example from `130Mi` / `20Mi` upwards).

   > **Warning:** Changing `--memory` or `--cpu` makes `/pod_nanny` resize and restart `exporter-kube-state`; kube-state series pause during the restart. Precondition: the four old flag values are noted. Rollback: set them back. If the old args return within a minute, the flags are chart-owned: set the Kube State Exporter quota in the plugin configuration instead.

   ```bash
   kubectl -n cpaas-system edit deploy kube-prometheus-exporter-kube-state
   ```

3. The limits on the new Pod follow the nanny formula, not numbers typed under `resources`. Empty Deployment trend panels return as soon as the exporter stays up.

### Cause 4: the Prometheus container limit is too small

1. Confirm the termination reason and rule out a corrupt WAL:

   ```bash
   kubectl -n cpaas-system describe pod <prometheus-pod> | grep -E 'Reason|Exit Code|OOMKilled'
   kubectl -n cpaas-system logs <prometheus-pod> -c prometheus --previous --tail=100 | grep -E 'invalid magic number|checksum mismatch|WAL'
   ```

   `invalid magic number` or `checksum mismatch` is a damaged segment that more memory does not repair. A long WAL replay with `Startup probe failed: HTTP probe failed with statuscode: 503` is covered in [Prometheus WAL replay slow or pod restarts before replay finishes on ACP](Prometheus_WAL_replay_slow_or_pod_restarts_before_replay_finishes_on_ACP.md).

2. Double the Prometheus limit in the plugin configuration (for an `8000Mi` instance, 4 CPU / 16Gi stopped the restarts).

   > **Warning:** The new limit rolls the Prometheus Pod; queries stop until it is Ready, and a size that does not fit the node leaves it Pending. Precondition: the last termination is `OOMKilled` and the log shows no corrupt segment. Rollback: set the previous limit in the same form.

### Cause 5: vm-operator is OOMKilled

```bash
kubectl -n cpaas-system get pod | grep vm-operator
kubectl -n cpaas-system describe pod <vm-operator-pod> | grep -E 'Reason|Exit Code|OOMKilled'
```

> **Warning:** Raising `vm-operator` resources restarts the operator; VictoriaMetrics objects are not reconciled while it is down, while running `vmagent`, `vmselect` and `vmstorage` keep serving. Recreating the other monitoring Pods afterwards interrupts queries and scraping until each is Ready. Precondition: `vm-operator` is restarting with `OOMKilled`. Rollback: set the previous resources in the same form.

Raise the `vm-operator` resources in the plugin configuration, then recreate the other monitoring Pods in `cpaas-system` one component at a time. Cluster monitoring displays normally afterwards.

## Diagnostic Steps

1. Describe the restarting Pod. `OOMKilled` on `vmagent`, with or without the queue-offset line, is Cause 1:

   ```bash
   kubectl -n cpaas-system get pod | grep -E 'vmagent|vmstorage|vminsert|vmselect|kube-state|prometheus|vm-operator'
   kubectl -n cpaas-system describe pod <pod> | grep -E 'Reason|Exit Code|Restart Count'
   ```

2. High but stable usage on `vmstorage` with 0 restarts, or an `OOMKilled` `vmstorage` behind a `vmagent` that recovers only after restarts, is Cause 2.

3. For kube-state, print the `/pod_nanny` flags before touching `resources` (Cause 3).

4. When `vmagent` restarts with `502` on remote write and is not `OOMKilled`, count the certificate series in vmui before adding memory:

   ```promql
   count({__name__="certificate_expires_time"})
   ```

   A very large count is query overload, not this article.

5. `prometheus` `OOMKilled` with no WAL checksum line is Cause 4. `vm-operator` `OOMKilled` is Cause 5.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500305
---

# Recovering Prometheus from TSDB head-chunk and WAL corruption on ACP

## Issue

On Alauda Container Platform, the monitoring stack ships kube-prometheus through the prometheus ModulePlugin in the `cpaas-system` namespace, where the Prometheus CR `kube-prometheus-0` owns the single-replica StatefulSet `prometheus-kube-prometheus-0`. The container runs upstream Prometheus 3.11.3 (image tag `prometheus:v3.11.3-v4.3.4`), so its on-disk TSDB head-chunk and Write-Ahead Log (WAL) format — and the corruption behavior described below — match the generic Prometheus mechanism. When Prometheus reads a TSDB head-chunk file whose recorded checksum does not match the data on disk, it reports a line of the form `corruption in head chunk file <path>: checksum mismatch`, and the affected instance cannot complete startup.

With the head chunk unreadable, the rule manager component inside the prometheus container fails to evaluate its recording and alerting rules and logs `Evaluating rule failed`. Because the failed instance also stops scraping its targets, freshness-based alerts such as the apiserver-health and `up`-style availability rules can fire while scraping is interrupted, even though the scraped components themselves remain healthy.

## Root Cause

The corruption typically follows an ungraceful shutdown of the Prometheus pod, elevated latency on the underlying storage, or a node failure — any of which can leave a head-chunk file partially written so its stored checksum no longer matches its contents. On ACP the TSDB data PVC `prometheus-kube-prometheus-0-db-prometheus-kube-prometheus-0-0` (a `topolvm-hdd` volume) is mounted at `/prometheus`, the path passed as `--storage.tsdb.path`, so the live head-chunk directory `/prometheus/chunks_head/` and the WAL directory `/prometheus/wal/` are the on-disk structures that get damaged. With a 7-day local retention, the persisted TSDB blocks under `/prometheus` are the long-term store, while the head chunk and WAL hold only the most recent, not-yet-flushed samples.

## Resolution

Recovery is to remove the corrupted head-chunk files under `/prometheus/chunks_head/` and the WAL files under `/prometheus/wal/` on the TSDB volume, then bring Prometheus back up so it replays a clean head. The `prometheus` container image is distroless and carries no shell or coreutils, so the deletion cannot be performed with a plain `kubectl exec ... rm`; instead, stop the running Prometheus so the volume is released, then mount the same PVC into a short-lived debug or init container that does have a shell to remove the two directories before Prometheus is brought back up.

The StatefulSet `prometheus-kube-prometheus-0` is not managed directly — it is owned by the prometheus-operator (ownerRef Prometheus/`kube-prometheus-0`, controller), which continuously reconciles its replica count from the Prometheus CR's `spec.replicas`. Scaling the StatefulSet with `kubectl scale statefulset ... --replicas=0` is therefore reverted back up by the operator, which re-attaches the RWO PVC and races the repair. Stop Prometheus by operating on the **Prometheus CR** instead: either set `spec.paused: true` (a valid field on the Prometheus CR) or set its `spec.replicas: 0`. This tears down the running pod and releases the PVC without the operator fighting back.

```bash
# Stop Prometheus via the operator-managed Prometheus CR (not the StatefulSet).
kubectl -n cpaas-system patch prometheus kube-prometheus-0 \
  --type=merge -p '{"spec":{"paused":true,"replicas":0}}'
```

```yaml
# Mount the released PVC into a throwaway pod that has a shell, then
# delete the corrupt head-chunk and WAL directories under /prometheus.
apiVersion: v1
kind: Pod
metadata:
  name: tsdb-repair
  namespace: cpaas-system
spec:
  restartPolicy: Never
  containers:
    - name: repair
      # Any shell-capable image available from your cluster's registry.
      image: <a-shell-capable-image-from-your-registry>
      command: ["sh", "-c", "rm -rf /prometheus/chunks_head/* /prometheus/wal/* && echo done"]
      volumeMounts:
        - name: db
          mountPath: /prometheus
  volumes:
    - name: db
      persistentVolumeClaim:
        # volumeClaimTemplate-generated PVC name for the StatefulSet's data volume.
        claimName: prometheus-kube-prometheus-0-db-prometheus-kube-prometheus-0-0
```

After the corrupt files are removed, re-enable Prometheus through the same CR by clearing the pause and restoring the replica count; the operator then recreates the pod, and on startup Prometheus replays a clean head and resumes scraping and rule evaluation.

```bash
kubectl -n cpaas-system patch prometheus kube-prometheus-0 \
  --type=merge -p '{"spec":{"paused":false,"replicas":1}}'
```

Removing the head-chunk and WAL files discards the most recent in-memory samples that had not yet been flushed to a persisted TSDB block, so a gap of recent metrics around the time of the corruption is expected. The long-term data already written to TSDB blocks under `/prometheus` is unaffected and remains queryable after recovery.

## Diagnostic Steps

Confirm the corruption by inspecting the prometheus container logs for the checksum-mismatch line; the presence of `corruption in head chunk` identifies a damaged head chunk as the reason the instance will not start.

```bash
kubectl -n cpaas-system logs prometheus-kube-prometheus-0-0 -c prometheus \
  | grep -i "corruption in head chunk"
```

A matching log line, together with the `Evaluating rule failed` entry from the rule manager, confirms that the failure is TSDB head-chunk corruption rather than a configuration or scheduling problem, and that the file-removal recovery above is the appropriate remediation.

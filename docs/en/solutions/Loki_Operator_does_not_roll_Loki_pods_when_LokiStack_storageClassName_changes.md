---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On an ACP cluster using the Loki-based logging stack, an operator changes the `spec.storage.schemas` or (more commonly) the `storageClassName` field on a `LokiStack` Custom Resource in the hope of migrating Loki's persistent storage to a different `StorageClass`. The update applies cleanly at the API level — the `LokiStack` object shows the new value — but the Loki ingester/index-gateway/compactor StatefulSet pods are not rolled, and the underlying `PersistentVolumeClaim`s continue to reference the old `StorageClass`. As a result, the new volumes that the user expected to be provisioned on the target `StorageClass` never appear, and the logging data path keeps running on the pre-existing storage.

The expected behaviour — the Loki Operator reconciles the storage-class change, scales the Loki pods down in a WAL-safe order, drops the old PVCs, creates fresh PVCs against the new `StorageClass`, and scales back up — does not happen.

## Root Cause

The Loki Operator does not currently implement a storage-class migration pipeline. A `StorageClass` change on an existing `LokiStack` is not a supported in-place transition because a safe migration would require:

- Flushing each ingester's write-ahead log (WAL) so no un-acknowledged log samples are lost during the pod recycle.
- Coordinating scale-down / PVC deletion / scale-up across ingesters, compactor, index-gateway, and any store-gateway such that the cluster's replica set does not lose quorum.
- Rewriting the object-store pointers that the index references once fresh block storage comes up.

Without that orchestration, the operator intentionally ignores the delta on the `storageClassName` field — silently tolerating the edit is safer than tearing down stateful Loki components and risking data loss on what the operator does not know how to sequence. The field change therefore has no effect until the operator ships explicit support for storage-class transitions.

## Resolution

There is no direct "edit the field and wait" solution at present. Switching the Loki persistence to a new `StorageClass` has to be done by rebuilding the `LokiStack` — either by re-creating it fresh on the target `StorageClass`, or by driving the rollover manually while keeping a controlled downtime window.

Two practical paths are available.

1. **Recreate the LokiStack on the target StorageClass.** Acceptable when historical log data up to the cutover can be either abandoned, or is already flushed to the configured object store for long-term retention (S3/MinIO/Ceph-RGW — object storage is not affected by the `StorageClass` of the Loki pods).

   Steps:

   ```bash
   # 1. Stop ingestion by pausing the log forwarders / collectors.
   kubectl -n <logging-namespace> scale deployment/<log-collector> --replicas=0
   # (or pause the ClusterLogForwarder CR if one is in use)

   # 2. Delete the LokiStack. The operator cleans up the StatefulSets and PVCs.
   kubectl -n <logging-namespace> delete lokistack <name>

   # 3. Re-apply the LokiStack manifest with the new storageClassName.
   kubectl -n <logging-namespace> apply -f lokistack.yaml

   # 4. Wait for the new StatefulSets to become Ready, then resume ingestion.
   kubectl -n <logging-namespace> scale deployment/<log-collector> --replicas=<N>
   ```

   `lokistack.yaml` carries the storage section with the target class, for example:

   ```yaml
   apiVersion: loki.grafana.com/v1
   kind: LokiStack
   metadata:
     name: <name>
     namespace: <logging-namespace>
   spec:
     size: 1x.small
     storage:
       schemas:
         - version: v13
           effectiveDate: "2024-01-01"
       secret:
         name: <object-store-secret>
         type: s3
     storageClassName: <new-storage-class>
   ```

2. **Rotate persistent volumes component by component, preserving WAL.** Acceptable when the new `StorageClass` is equivalent to the old one (same access mode, at least the same size) and ingestion can be paused briefly per component.

   The sequence is performed once per Loki component StatefulSet (ingester, index-gateway, compactor, ruler):

   ```bash
   # 1. Scale the component to zero so its WAL is flushed.
   kubectl -n <logging-namespace> scale sts <loki-component> --replicas=0

   # 2. Delete the PVCs the StatefulSet was using.
   kubectl -n <logging-namespace> delete pvc -l app.kubernetes.io/component=<component>

   # 3. Patch the LokiStack to the new StorageClass (and re-apply).
   # 4. Scale the StatefulSet back to its original replica count.
   kubectl -n <logging-namespace> scale sts <loki-component> --replicas=<N>
   ```

   Because the operator does not react to the `storageClassName` edit, the PVC delete in step 2 is what forces the StatefulSet to recreate PVCs against whichever `StorageClass` is currently referenced when the pods come back up.

Either path results in a period where queries against recent in-memory log data will be thin — once the object store handoff completes for long-term chunks, steady-state queries recover. Record the cutover time so that the observability team can explain the gap to downstream consumers.

## Diagnostic Steps

1. Check whether the `LokiStack` object really carries the new `storageClassName`:

   ```bash
   kubectl -n <logging-namespace> get lokistack <name> \
     -o jsonpath='{.spec.storageClassName}{"\n"}'
   ```

2. Compare with the `StorageClass` the Loki PVCs are actually bound to:

   ```bash
   kubectl -n <logging-namespace> get pvc \
     -o custom-columns=NAME:.metadata.name,STORAGECLASS:.spec.storageClassName,STATUS:.status.phase
   ```

   A mismatch between the `LokiStack` field and the PVC column confirms the operator has not reconciled the change.

3. Inspect the Loki Operator logs for a reconcile-skipped / unsupported-field message:

   ```bash
   kubectl -n <loki-operator-namespace> logs deployment/loki-operator \
     | grep -Ei "storageClass|unsupported|skip"
   ```

4. Verify the ingester WAL is flushed before any storage rotation. Request the per-ingester `loki_ingester_wal_disk_full`, `loki_ingester_wal_replay_duration_seconds` and `loki_wal_samples_flushed` series from Prometheus, or exec into an ingester pod and check `/loki/wal`:

   ```bash
   kubectl -n <logging-namespace> exec -it <loki-ingester-pod> -- \
     ls -lah /var/loki/wal /var/loki/chunks
   ```

   An empty WAL directory (or only the current-segment checkpoint) is the signal that the component can be safely scaled down without data loss.

5. After the cutover, verify ingestion has resumed and new PVCs are bound:

   ```bash
   kubectl -n <logging-namespace> get pvc
   kubectl -n <logging-namespace> get sts
   ```

   All Loki component StatefulSets should report their desired replica count as Ready, and the PVCs should carry the new `StorageClass` name.
</content>
</invoke>
---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Log-collector pods (Vector) show repeated errors indicating the on-disk buffer file is unreadable. Two shapes of error appear:

```text
ERROR sink{component_kind="sink" component_id=<output_id> component_type=loki}:
  vector_buffers::variants::disk_v2::writer:
  Last written record was unable to be deserialized. Corruption likely.
  reason="invalid structure: pointer out of bounds: base 0x... offset -28 not in range 0x...0x..."
```

and:

```text
ERROR sink{...}: vector_buffers::internal_events:
  Error encountered during buffer read.
  error=The reader detected that a data file contains a partially-written record.
  error_code="partial_write"
  error_type="reader_failed"
```

The collector cannot serialize new events past the corrupted record, and its queue to the sink (typically Loki) stops draining. Downstream, log messages stop arriving at the sink until the corruption is cleared.

## Root Cause

`ClusterLogForwarder` configurations that set `deliveryMode: AtLeastOnce` enable Vector's **on-disk buffer** for outputs. The collector writes every event to `/var/lib/vector/<ns>/<clf-cr>/buffer/v2/<output>/<data-file>` before forwarding; the disk buffer lets the collector survive pod restarts and backpressure without losing events that have not yet been acknowledged by the sink.

Two things can corrupt a buffer file on disk:

1. **The collector pod was OOMKilled mid-write.** The kernel kills the process at an arbitrary point; if that point is in the middle of writing a record to the buffer, the next time the collector reads the file it finds a record with a missing or truncated tail. The `partial_write` error is the direct symptom.
2. **The underlying node filesystem had a fault.** A node that ran out of disk, was improperly power-cycled, or has a CSI-layer issue may have delivered the last write incompletely. The `pointer out of bounds` error is the direct symptom.

Once any record in the buffer is corrupted, Vector's reader stops at that record — it cannot skip ahead because it does not know where the next valid record begins. The whole buffer is effectively frozen. Fresh events queue up behind it; the sink sees nothing.

The fix is to delete the specific corrupted buffer file so the reader can start fresh from whatever valid record follows (or start over entirely). Vector does not repair the file in place.

## Resolution

### Step 1 — identify the corrupted buffer output

The error message includes `component_id=<output>`. That is the name of the `ClusterLogForwarder` output whose buffer is corrupted. Record it — you need it in Step 2.

```bash
NS=cpaas-logging       # or wherever the collector runs
CR=collector           # the name of the ClusterLogForwarder CR

for pod in $(kubectl -n "$NS" get pod -l app.kubernetes.io/instance="$CR" -o name); do
  echo "--- $pod ---"
  kubectl -n "$NS" logs "$pod" --tail=500 | \
    grep -oE 'component_id=[^ ]+' | sort -u | head -5
done
```

Also identify which pods are affected — not every collector on every node necessarily has the same corruption.

### Step 2 — delete the corrupted buffer files

For each affected pod, remove the buffer directory for the specific output. The files live at a predictable path inside the pod:

```text
/var/lib/vector/<ns>/<cr>/buffer/v2/<output>/
```

Run the cleanup via `kubectl exec`:

```bash
NS=cpaas-logging
CR=collector
POD=<affected-pod>
OUTPUT=<output_id_from_step1>

kubectl -n "$NS" exec "$POD" -- sh -c "
  rm -rf /var/lib/vector/$NS/$CR/buffer/v2/$OUTPUT/*
"
```

The command removes the record files; Vector will create a fresh buffer on its next write.

### Step 3 — restart the collector pod

Vector caches file handles; a pod that has already opened a corrupted file may not notice the files are gone. Delete the pod so the DaemonSet recreates it:

```bash
kubectl -n "$NS" delete pod "$POD"
```

The fresh pod starts, initialises a new buffer at the same path, and begins writing new events. The sink starts receiving events again within one or two scrape-send cycles.

Repeat Step 2 and Step 3 for every affected pod.

### Step 4 — accept the data loss

Any events that were in the corrupted region of the buffer are gone. Sinks configured for `AtLeastOnce` delivery rely on the buffer to replay after a restart; a buffer that was deleted cannot be replayed. For most observability workloads, the log-data loss window is seconds to a few minutes — acceptable in exchange for getting delivery working again.

If the loss window is unacceptable, preserve the file before deleting:

```bash
# Before Step 2:
kubectl -n "$NS" cp "$POD":/var/lib/vector/$NS/$CR/buffer/v2/$OUTPUT /tmp/corrupted-buffer-$POD
```

Store the captured file for forensic / audit purposes; nothing automated can recover usable events from a corrupted Vector buffer today.

### Step 5 — address the root cause

Deleting the buffer is symptomatic relief; the thing that caused the corruption may recur. Check which root cause is in play:

- **OOMKill**: `kubectl get pod -n "$NS" <pod> -o yaml | grep -E 'OOMKilled|reason'`. Repeated `OOMKilled` terminations on collector pods need a `limits.memory` raise or a reduction in event volume. See the sibling note on collector-pod OOM kills for the triage steps — raising limits without first investigating the upstream (blocked sink, cold-start replay, chatty namespace) may only delay the next OOM.
- **Node filesystem fault**: `kubectl describe node <node>` for `DiskPressure`, `KubeletHasDiskPressure`. Check the node's journal for filesystem errors (`ext4_error`, `XFS corruption`, CSI driver `write error`). Address at the node / CSI layer.

Without fixing the root cause, buffer corruption keeps recurring; the cleanup becomes a routine operation, and eventually the events missed during each cleanup add up to a visible gap in the data.

## Diagnostic Steps

Confirm which output's buffer is corrupted and which pods need the fix:

```bash
NS=cpaas-logging
CR=collector

for pod in $(kubectl -n "$NS" get pod -l app.kubernetes.io/instance="$CR" -o name); do
  hit=$(kubectl -n "$NS" logs "$pod" --tail=500 | \
        grep -c -E 'vector_buffers.*Corruption likely|partial_write')
  if [ "$hit" -gt 0 ]; then
    echo "$pod  corruption errors: $hit"
  fi
done
```

Pods with non-zero hits are the candidates for Step 2 + 3.

Verify the corruption is tied to a `deliveryMode: AtLeastOnce` output (if it is `AtMostOnce`, Vector does not buffer on disk and the error shape is different):

```bash
kubectl -n "$NS" get clusterlogforwarder "$CR" -o yaml | \
  yq '.spec.outputs[] | {name, tuning}'
```

The output whose `component_id` appeared in the error should have `tuning.deliveryMode: AtLeastOnce`.

After applying Step 2 + 3, watch the collector's sink-side metrics for the queue to drain:

```bash
kubectl -n "$NS" exec "$POD_NEW" -- \
  wget -qO- http://localhost:8686/metrics 2>/dev/null | \
  grep -E 'vector_buffer_events_total|vector_buffer_byte_size'
```

The buffer size should trend down (the sink acknowledges events as they are forwarded). Error counts for `vector_buffer_errors_total` should stop incrementing.

If the same pod's buffer re-corrupts shortly after cleanup, the root cause (Step 5) has not been addressed; the cycle will repeat.

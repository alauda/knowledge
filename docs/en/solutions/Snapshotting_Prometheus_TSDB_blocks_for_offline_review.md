---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Snapshotting Prometheus TSDB blocks for offline review
## Issue

When a metric anomaly is reported well after the fact, or when the cluster team and the diagnosing engineer are on different sides of an air-gap, querying live Prometheus is not an option. The cluster operator needs to lift a slice of the time-series database off the running Prometheus pod, ship the resulting tarball, and let the analyst replay queries against the same data on a workstation that has no access to the source cluster.

The native Prometheus TSDB layout (`block ULID/`, `chunks/`, `index`, `meta.json`, `tombstones`, plus the in-memory `chunks_head` and `wal/` for recent samples) makes this practical: each completed block is self-contained and can be lifted with `kubectl cp`. The recipe below produces an extractable tarball from any namespace running the Prometheus operator (in-cluster monitoring, user-workload monitoring, or a standalone Prometheus instance).

## Resolution

### Identify the Prometheus pod and namespace

Variable shorthand for the rest of the procedure:

```bash
# On ACP the platform Prometheus runs in cpaas-system, packaged as the
# kube-prometheus chart. Pod names follow the StatefulSet replica naming
# convention <statefulset>-<replica>; verify the actual pod name with
# `kubectl -n cpaas-system get statefulset` before substituting.
NS=cpaas-system                       # namespace running the Prometheus pod
POD=prometheus-kube-prometheus-0-0    # the StatefulSet replica being snapshotted
CONTAINER=prometheus                  # container name inside that pod
```

`kubectl -n $NS get statefulset` lists the available Prometheus instances. Snapshotting the `replica-0` pod is enough — replicas hold identical data when the StatefulSet is healthy.

### Option A — full snapshot via tar

If the Prometheus container ships `tar`, the simplest path is to stream the entire `/prometheus` directory through `kubectl exec`. Compress in flight to keep the on-cluster footprint small:

```bash
ARTIFACT_DIR=$PWD/metrics
mkdir -p "$ARTIFACT_DIR"
kubectl -n "$NS" exec "$POD" -c "$CONTAINER" -- \
  tar cz -C /prometheus . > "$ARTIFACT_DIR/prometheus.tar.gz"
```

Capture the active scrape-target metadata at the same time — it is required to re-create the same label set when replaying offline:

```bash
kubectl -n "$NS" exec "$POD" -c "$CONTAINER" -- \
  curl -sG http://localhost:9090/api/v1/targets/metadata \
  --data-urlencode 'match_target={instance!=""}' \
  > "$ARTIFACT_DIR/prometheus-target-metadata.json"
```

This is fast but fragile: the WAL and `chunks_head` files mutate while `tar` is still reading them. The resulting archive sometimes fails to extract on the analyst's workstation. Use Option B for any case where the snapshot has to be reliable.

### Option B — block-by-block snapshot

A robust snapshot copies completed blocks one at a time, then captures the WAL and `chunks_head` separately. Completed blocks are immutable, so the copy is consistent.

List the available blocks and their time windows:

```bash
kubectl -n "$NS" exec "$POD" -c "$CONTAINER" -- \
  promtool tsdb list -r /prometheus
```

Output resembles:

```text
BLOCK ULID                  MIN TIME                       MAX TIME                       DURATION    NUM SAMPLES   NUM CHUNKS   NUM SERIES   SIZE
01GGQV2KWQ7DX0RAHWZZFPCNTM  2022-10-31 17:17:39 +0000 UTC  2022-10-31 18:00:00 +0000 UTC  42m20.389s  15306022      215664       215457       46MiB
01GGRRZ7B4VMK4PGENCKC642FK  2022-10-31 18:00:00 +0000 UTC  2022-11-01 00:00:00 +0000 UTC  5h59m59.811s 133853179    1122268      195484       162MiB
...
```

Pick the ULIDs covering the incident window and pull each block's directory. Some Prometheus images do not bundle `tar` — fall back to `cat` per file in that case:

```bash
DEST=./prometheus-snapshot
mkdir -p "$DEST"
BLOCKS="01GGQV2KWQ7DX0RAHWZZFPCNTM 01GGRRZ7B4VMK4PGENCKC642FK"

for ulid in $BLOCKS; do
  mkdir -p "$DEST/$ulid/chunks"
  for f in index meta.json tombstones; do
    kubectl -n "$NS" exec "$POD" -c "$CONTAINER" -- \
      cat "/prometheus/$ulid/$f" > "$DEST/$ulid/$f"
  done
  # Each block has one or more chunk files numbered sequentially.
  for cf in $(kubectl -n "$NS" exec "$POD" -c "$CONTAINER" -- \
              ls "/prometheus/$ulid/chunks"); do
    kubectl -n "$NS" exec "$POD" -c "$CONTAINER" -- \
      cat "/prometheus/$ulid/chunks/$cf" > "$DEST/$ulid/chunks/$cf"
  done
done

# WAL + chunks_head + queries.active are needed so recent samples
# (the unsealed last 2-3 hours) survive into the offline replay.
kubectl -n "$NS" cp "$POD:chunks_head" "$DEST/chunks_head" -c "$CONTAINER"
kubectl -n "$NS" cp "$POD:wal" "$DEST/wal" -c "$CONTAINER"
kubectl -n "$NS" cp "$POD:queries.active" "$DEST/queries.active" -c "$CONTAINER" || true
```

A "file changed as we read it" warning on `wal/` is harmless — the active segment is being appended to by the live process. The block files (which are sealed) have no such concern.

Compress and verify:

```bash
tar -C "$DEST" -czf prometheus-db.tar.gz .
tar -tzf prometheus-db.tar.gz | head
```

The expected layout is:

```text
./01GGQV2KWQ7DX0RAHWZZFPCNTM/index
./01GGQV2KWQ7DX0RAHWZZFPCNTM/meta.json
./01GGQV2KWQ7DX0RAHWZZFPCNTM/tombstones
./01GGQV2KWQ7DX0RAHWZZFPCNTM/chunks/000001
./01GGRRZ7B4VMK4PGENCKC642FK/...
./chunks_head/...
./wal/00000000
./queries.active
```

Missing `index`, `meta.json`, `tombstones` for any block makes that block unparseable; re-fetch them explicitly.

### Replay the snapshot offline

On the analyst's workstation, expand the tarball into a host directory and run a Prometheus container against it. Match the Prometheus version to the one that produced the data — a major-version mismatch can refuse to load older block formats:

```bash
DATA=$HOME/Downloads/prometheus-db
mkdir -p "$DATA"
tar -C "$DATA" -xzf prometheus-db.tar.gz

PROM_IMAGE=quay.io/prometheus/prometheus:v2.51.0   # match the source instance

docker run --rm -it \
  -u "$(id -u):$(id -g)" \
  -p 9090:9090 \
  -v "$DATA":/data:Z \
  "$PROM_IMAGE" \
  --storage.tsdb.path=/data \
  --storage.tsdb.retention.time=999d \
  --config.file=/dev/null
```

Browse to `http://localhost:9090/graph` and run a coarse query first — `sum(kube_node_status_condition{condition="Ready",status="true"}==1)` over the full window confirms data is loaded. Highlighting the populated time window in the graph view restricts subsequent queries to the snapshotted range.

### Cleanup

The snapshot tarball can be large (hundreds of MiB per day). Remove it from the cluster after upload:

```bash
rm -rf ./prometheus-snapshot prometheus-db.tar.gz
```

If the snapshot was taken inside a debug pod or a temporary workstation, also wipe the local copies once the analysis is complete.

## Diagnostic Steps

If `promtool tsdb list -r` reports no blocks, the Prometheus pod has not yet sealed a block — typical for a freshly restarted instance. Wait at least two hours after the restart, or capture the live WAL with Option A and accept the consistency risk.

If `kubectl cp` fails with `tar: not found`, the destination Prometheus image has no `tar`. Use the per-file `cat` form shown in Option B; it is slower but works against any image.

If the offline replay shows no metrics for the period of interest, confirm the snapshot covers the right blocks:

```bash
kubectl -n "$NS" exec "$POD" -c "$CONTAINER" -- \
  promtool tsdb list -r /prometheus | awk 'NR==1 || /2026-04-21/'
```

A block whose `MAX TIME` predates the incident is the wrong one. Re-pull with the correct ULID list.

If the offline Prometheus container fails to start with `mmap of <…>: cannot allocate memory`, the host is running out of address space — common on small workstations holding multi-day snapshots. Either increase `vm.max_map_count` (`sysctl -w vm.max_map_count=262144`) or replay smaller block subsets.

For the in-cluster monitoring stack that runs through the platform's monitoring operator, the namespace and pod names depend on the deployment. Discover them dynamically:

```bash
kubectl get pods -A -l app.kubernetes.io/name=prometheus
```

The same procedure applies for any Prometheus instance — user-workload monitoring, a stand-alone Prometheus operator instance, or a per-team monitoring stack.

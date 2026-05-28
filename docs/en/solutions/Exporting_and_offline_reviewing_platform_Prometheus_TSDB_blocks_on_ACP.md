---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Exporting and offline-reviewing platform Prometheus TSDB blocks on ACP

## Issue

On Alauda Container Platform the platform Prometheus runs as a StatefulSet pod named `prometheus-kube-prometheus-0-0` in the `cpaas-system` namespace, fronted by a single `kube-prometheus-0` Prometheus CR; the on-disk TSDB lives under `/prometheus` (the `--storage.tsdb.path=/prometheus` argument backed by the PVC mount `prometheus-kube-prometheus-0-db`, with `--storage.tsdb.retention.time=7d`). Capturing a full snapshot by exec'ing into that pod and tarring `/prometheus` is supported — the container ships `tar` (busybox 1.36.1) — but tarring while Prometheus is actively writing those files can produce an archive that fails to extract, so a live tar is best treated as best-effort.

## Resolution

The reliable way to capture a consistent set of blocks is to tar the storage directory from inside the pod and extract the wanted blocks, or to pull individual blocks out with `kubectl cp`. Tar-streaming the whole directory works directly from the pod:

```bash
kubectl exec -n cpaas-system prometheus-kube-prometheus-0-0 -c prometheus -- \
  tar -cf - -C / prometheus > prometheus-tsdb.tar
```

To pull a single block out instead, copy its ULID directory with `kubectl cp`, which streams the directory as a tar under the hood and lands `chunks/`, `index`, `meta.json`, and `tombstones` locally:

```bash
kubectl cp cpaas-system/prometheus-kube-prometheus-0-0:/prometheus/<block-ulid> ./<block-ulid> \
  -c prometheus
```

The exported data can then be reviewed offline by running a matching-version Prometheus image under podman with `--storage.tsdb.path=/data` and browsing the local instance at `localhost:9090`. The matching image is the same one the platform Prometheus container runs, read directly from the running pod — on this environment `registry.alauda.cn:60080/3rdparty/prometheus/prometheus:v3.11.3-v4.3.4`. The on-disk block format is governed by the Prometheus binary version (`v3.11.3`), so an offline `promtool`/Prometheus of that version matches the exported data's format.

```bash
kubectl get pod prometheus-kube-prometheus-0-0 -n cpaas-system \
  -o jsonpath='{.spec.containers[?(@.name=="prometheus")].image}'

podman run --rm -p 9090:9090 \
  -v "$(pwd)/data:/data" \
  registry.alauda.cn:60080/3rdparty/prometheus/prometheus:v3.11.3-v4.3.4 \
  --storage.tsdb.path=/data
```

## Diagnostic Steps

Before extracting, enumerate which blocks cover the desired time range. The Prometheus image ships `promtool` (v3.11.3), and `promtool tsdb list -r /prometheus` lists each TSDB block ULID with its min/max time, duration, and sample, chunk, and series counts — which identifies the block covering a given window.

```bash
kubectl exec -n cpaas-system prometheus-kube-prometheus-0-0 -c prometheus -- \
  promtool tsdb list -r /prometheus
```

```text
BLOCK ULID                  MIN TIME                       MAX TIME                       DURATION  NUM SAMPLES  NUM CHUNKS  NUM SERIES  SIZE
01KSANN0Y7VYSNNXC68H0VJNZ6  2026-05-23 15:00:04 +0000 UTC  2026-05-23 15:00:55 +0000 UTC  51.001s   33338        642         642         117KiB
```

Each block is a ULID directory containing `chunks/`, `index`, `meta.json`, and `tombstones`; on this `v3.11.3` image a freshly written block was observed to carry exactly those four members, and a block cannot be parsed if `index`, `meta.json`, or `tombstones` is missing — so collect all four for every block selected. Parsing the exported blocks offline also requires the `chunks_head`, `wal`, and `queries.active` data that sit at the root of `/prometheus` alongside the block directories; copy them along with the blocks.

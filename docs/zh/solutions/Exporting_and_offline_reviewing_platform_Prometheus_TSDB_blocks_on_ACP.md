---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500516
sourceSHA: 6f76040313eb34de4ea844944905b060301b0365734ce5305942ed8728f01d57
---

# 在 ACP 上导出和离线审查平台 Prometheus TSDB 块

## 问题

在 Alauda Container Platform 上，平台 Prometheus 作为一个名为 `prometheus-kube-prometheus-0-0` 的 StatefulSet pod 运行于 `cpaas-system` 命名空间，由一个单独的 `kube-prometheus-0` Prometheus CR 前端；磁盘上的 TSDB 存放在 `/prometheus` 下（`--storage.tsdb.path=/prometheus` 参数由 PVC 挂载 `prometheus-kube-prometheus-0-db` 支持，`--storage.tsdb.retention.time=7d`）。通过进入该 pod 并打包 `/prometheus` 来捕获完整快照是支持的——容器中包含 `tar`（busybox 1.36.1）——但在 Prometheus 正在写入这些文件时打包可能会生成无法解压的归档，因此实时打包最好视为尽力而为。

## 解决方案

捕获一致的块集的可靠方法是从 pod 内部打包存储目录并提取所需的块，或者使用 `kubectl cp` 提取单个块。直接从 pod 中对整个目录进行打包流式传输：

```bash
kubectl exec -n cpaas-system prometheus-kube-prometheus-0-0 -c prometheus -- \
  tar -cf - -C / prometheus > prometheus-tsdb.tar
```

如果要提取单个块，可以使用 `kubectl cp` 复制其 ULID 目录，该命令在后台以 tar 格式流式传输目录，并将 `chunks/`、`index`、`meta.json` 和 `tombstones` 本地化：

```bash
kubectl cp cpaas-system/prometheus-kube-prometheus-0-0:/prometheus/<block-ulid> ./<block-ulid> \
  -c prometheus
```

导出的数据可以通过在 podman 下运行匹配版本的 Prometheus 镜像并使用 `--storage.tsdb.path=/data` 来离线审查，同时在 `localhost:9090` 浏览本地实例。匹配的镜像与平台 Prometheus 容器运行的镜像相同，直接从运行中的 pod 中读取——在此环境中为 `registry.alauda.cn:60080/3rdparty/prometheus/prometheus:v3.11.3-v4.3.4`。磁盘上的块格式由 Prometheus 二进制版本（`v3.11.3`）决定，因此离线的 `promtool`/Prometheus 版本与导出的数据格式匹配。

```bash
kubectl get pod prometheus-kube-prometheus-0-0 -n cpaas-system \
  -o jsonpath='{.spec.containers[?(@.name=="prometheus")].image}'

podman run --rm -p 9090:9090 \
  -v "$(pwd)/data:/data" \
  registry.alauda.cn:60080/3rdparty/prometheus/prometheus:v3.11.3-v4.3.4 \
  --storage.tsdb.path=/data
```

## 诊断步骤

在提取之前，列出覆盖所需时间范围的块。Prometheus 镜像中包含 `promtool`（v3.11.3），并且 `promtool tsdb list -r /prometheus` 列出每个 TSDB 块的 ULID 及其最小/最大时间、持续时间、样本、块和系列计数——这可以识别覆盖给定时间窗口的块。

```bash
kubectl exec -n cpaas-system prometheus-kube-prometheus-0-0 -c prometheus -- \
  promtool tsdb list -r /prometheus
```

```text
BLOCK ULID                  MIN TIME                       MAX TIME                       DURATION  NUM SAMPLES  NUM CHUNKS  NUM SERIES  SIZE
01KSANN0Y7VYSNNXC68H0VJNZ6  2026-05-23 15:00:04 +0000 UTC  2026-05-23 15:00:55 +0000 UTC  51.001s   33338        642         642         117KiB
```

每个块都是一个 ULID 目录，包含 `chunks/`、`index`、`meta.json` 和 `tombstones`；在此 `v3.11.3` 镜像中，观察到新写入的块恰好包含这四个成员，如果缺少 `index`、`meta.json` 或 `tombstones`，则无法解析该块——因此为每个选择的块收集所有四个。离线解析导出的块还需要位于 `/prometheus` 根目录下的 `chunks_head`、`wal` 和 `queries.active` 数据；将它们与块一起复制。

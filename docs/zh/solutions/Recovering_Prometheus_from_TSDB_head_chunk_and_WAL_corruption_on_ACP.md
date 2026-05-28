---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500305
sourceSHA: 2cf9d869f28ab2909cde28e5f9f037180dd608f53cb96e62378891da6a3bb531
---

# 从 ACP 的 TSDB 头块和 WAL 损坏中恢复 Prometheus

## 问题

在 Alauda 容器平台上，监控栈通过 `cpaas-system` 命名空间中的 prometheus ModulePlugin 部署 kube-prometheus，其中 Prometheus CR `kube-prometheus-0` 拥有单副本的 StatefulSet `prometheus-kube-prometheus-0`。该容器运行的是上游的 Prometheus 3.11.3（镜像标签 `prometheus:v3.11.3-v4.3.4`），因此其磁盘上的 TSDB 头块和预写日志（WAL）格式，以及下面描述的损坏行为，均与通用的 Prometheus 机制相匹配。当 Prometheus 读取一个记录的校验和与磁盘上的数据不匹配的 TSDB 头块文件时，它会报告一行形式为 `corruption in head chunk file <path>: checksum mismatch` 的信息，受影响的实例无法完成启动。

由于头块不可读，prometheus 容器内部的规则管理组件无法评估其记录和警报规则，并记录 `Evaluating rule failed`。因为失败的实例也停止抓取其目标，所以基于新鲜度的警报，例如 apiserver-health 和 `up` 风格的可用性规则，可能会在抓取中断时触发，即使被抓取的组件本身仍然健康。

## 根本原因

损坏通常发生在 Prometheus pod 非正常关闭、底层存储延迟升高或节点故障时——任何一种情况都可能导致头块文件部分写入，从而使其存储的校验和与内容不再匹配。在 ACP 中，TSDB 数据 PVC `prometheus-kube-prometheus-0-db-prometheus-kube-prometheus-0-0`（一个 `topolvm-hdd` 卷）挂载在 `/prometheus`，该路径作为 `--storage.tsdb.path` 传递，因此实时头块目录 `/prometheus/chunks_head/` 和 WAL 目录 `/prometheus/wal/` 是受损的磁盘结构。在 7 天的本地保留期内，持久化的 TSDB 块位于 `/prometheus` 下，是长期存储，而头块和 WAL 仅保存最近的、尚未刷新到持久化 TSDB 块的样本。

## 解决方案

恢复方法是删除 TSDB 卷下 `/prometheus/chunks_head/` 中损坏的头块文件和 `/prometheus/wal/` 中的 WAL 文件，然后重新启动 Prometheus，以便它重新播放一个干净的头块。`prometheus` 容器镜像是无发行版的，不包含 shell 或 coreutils，因此无法通过普通的 `kubectl exec ... rm` 执行删除；相反，停止正在运行的 Prometheus，以便释放卷，然后将相同的 PVC 挂载到一个短暂的调试或初始化容器中，该容器具有 shell，以在 Prometheus 重新启动之前删除这两个目录。

StatefulSet `prometheus-kube-prometheus-0` 并不是直接管理的——它由 prometheus-operator 所拥有（ownerRef Prometheus/`kube-prometheus-0`，控制器），该控制器持续根据 Prometheus CR 的 `spec.replicas` 进行副本计数的协调。因此，通过 `kubectl scale statefulset ... --replicas=0` 扩展 StatefulSet 会被 operator 还原，operator 会重新附加 RWO PVC 并竞速修复。通过操作 **Prometheus CR** 停止 Prometheus：要么设置 `spec.paused: true`（这是 Prometheus CR 上的有效字段），要么将其 `spec.replicas: 0`。这将拆除正在运行的 pod，并释放 PVC，而不必担心 operator 的干扰。

```bash
# 通过 operator 管理的 Prometheus CR 停止 Prometheus（而不是 StatefulSet）。
kubectl -n cpaas-system patch prometheus kube-prometheus-0 \
  --type=merge -p '{"spec":{"paused":true,"replicas":0}}'
```

```yaml
# 将释放的 PVC 挂载到一个临时 pod 中，该 pod 具有 shell，然后
# 删除 /prometheus 下的损坏头块和 WAL 目录。
apiVersion: v1
kind: Pod
metadata:
  name: tsdb-repair
  namespace: cpaas-system
spec:
  restartPolicy: Never
  containers:
    - name: repair
      # 从您的集群注册表中可用的任何支持 shell 的镜像。
      image: <a-shell-capable-image-from-your-registry>
      command: ["sh", "-c", "rm -rf /prometheus/chunks_head/* /prometheus/wal/* && echo done"]
      volumeMounts:
        - name: db
          mountPath: /prometheus
  volumes:
    - name: db
      persistentVolumeClaim:
        # 为 StatefulSet 的数据卷生成的 volumeClaimTemplate PVC 名称。
        claimName: prometheus-kube-prometheus-0-db-prometheus-kube-prometheus-0-0
```

在删除损坏文件后，通过相同的 CR 重新启用 Prometheus，清除暂停并恢复副本计数；然后 operator 会重新创建 pod，并在启动时 Prometheus 会重新播放一个干净的头块并恢复抓取和规则评估。

```bash
kubectl -n cpaas-system patch prometheus kube-prometheus-0 \
  --type=merge -p '{"spec":{"paused":false,"replicas":1}}'
```

删除头块和 WAL 文件会丢弃最近的内存样本，这些样本尚未刷新到持久化的 TSDB 块，因此在损坏发生时会预期出现最近指标的缺口。已经写入 TSDB 块的长期数据在 `/prometheus` 下不受影响，并在恢复后仍然可以查询。

## 诊断步骤

通过检查 prometheus 容器日志中的校验和不匹配行来确认损坏；出现 `corruption in head chunk` 表明损坏的头块是实例无法启动的原因。

```bash
kubectl -n cpaas-system logs prometheus-kube-prometheus-0-0 -c prometheus \
  | grep -i "corruption in head chunk"
```

匹配的日志行，以及规则管理器中的 `Evaluating rule failed` 条目，确认故障是 TSDB 头块损坏，而不是配置或调度问题，并且上述文件删除恢复是适当的补救措施。

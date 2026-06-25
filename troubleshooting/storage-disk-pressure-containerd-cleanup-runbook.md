---
title: storage-disk-pressure-containerd-cleanup-runbook
type: runbook
status: draft
domain: storage
related_domains: [workload-runtime, cluster-lifecycle, observability]
product: acp
tags: [storage, disk-pressure, containerd, docker, kubelet, cleanup, runbook]
updated: 2026-06-24
source: [ticket-assist-mvp, historical-cases]
case_state: drafting
customer_visible: false
risk_level: high
confidence: medium
---

# 节点磁盘压力 / containerd 空间占用排查 Runbook

## 适用场景

适用于内部处理以下现象：

- 节点根盘或 `/var` 分区空间不足
- kubelet 报 `DiskPressure`
- Pod 创建、镜像拉取、容器启动失败，怀疑与磁盘空间有关
- `/var/lib/containerd`、`/var/lib/docker`、`/var/log`、业务目录占用异常
- 节点上存在大量历史镜像、容器日志或残留目录

不适用于：

- 已明确是业务 PVC 后端容量不足的场景
- Ceph / TopoLVM / NFS 后端自身故障
- 未确认目录用途就准备删除数据的场景

## 核心原则

> 先确认“满的是哪一层”，再决定能不能清理。不要看到大目录就删。

常见层次：

1. 节点根盘 / 系统分区
2. 容器运行时目录：`/var/lib/containerd` 或 `/var/lib/docker`
3. kubelet 目录：`/var/lib/kubelet`
4. 容器日志：`/var/log/containers`、`/var/log/pods`
5. 业务数据目录
6. PVC / PV 后端目录
7. 存储系统后端：Ceph / TopoLVM / NFS 等

## 最小取证清单

先收集：

```bash
df -h
lsblk
mount | grep -E 'containerd|docker|kubelet|var|data|cpaas'
du -xh --max-depth=1 / 2>/dev/null | sort -h | tail -20
du -xh --max-depth=1 /var 2>/dev/null | sort -h | tail -20
du -xh --max-depth=1 /var/lib 2>/dev/null | sort -h | tail -20
```

如果怀疑 containerd：

```bash
du -xh --max-depth=1 /var/lib/containerd 2>/dev/null | sort -h | tail -20
crictl images 2>/dev/null | head
crictl ps -a 2>/dev/null | head
journalctl -u containerd --since '2 hours ago' --no-pager | tail -200
journalctl -u kubelet --since '2 hours ago' --no-pager | tail -200
```

如果怀疑 docker：

```bash
du -xh --max-depth=1 /var/lib/docker 2>/dev/null | sort -h | tail -20
docker system df 2>/dev/null
journalctl -u docker --since '2 hours ago' --no-pager | tail -200
```

Kubernetes 侧：

```bash
kubectl get node -o wide
kubectl describe node <node-name>
kubectl get pod -A -o wide --field-selector spec.nodeName=<node-name>
kubectl get events -A --sort-by=.lastTimestamp | tail -100
```

## 判断路径

### 1. 判断是否真实 DiskPressure

看：

- `kubectl describe node <node>` 是否有 `DiskPressure=True`
- kubelet 是否有 eviction、image gc、container gc 失败日志
- `df -h` 是否显示关键分区满
- 是否只是监控口径或挂载点识别问题

### 2. 判断大目录来源

常见来源：

| 目录 | 可能原因 | 处理方向 |
|------|----------|----------|
| `/var/lib/containerd` | 镜像层、snapshot、残留容器 | 先用 crictl/nerdctl 判断，不直接删目录 |
| `/var/lib/docker` | 镜像、容器层、build cache | 先 docker system df，再评估 prune 风险 |
| `/var/log/pods` / `/var/log/containers` | 容器日志暴涨 | 找到具体 Pod，优先处理日志源和 logrotate |
| `/var/lib/kubelet/pods` | Pod volume、emptyDir、挂载残留 | 核对 Pod/PVC，不能直接删活跃 Pod 数据 |
| 业务目录 | 应用数据、缓存、导出文件 | 必须由业务确认 |
| PV 后端目录 | 持久化数据 | 高风险，禁止直接清理 |

### 3. containerd 场景

只读确认：

```bash
crictl images
crictl ps -a
crictl stats 2>/dev/null | head
```

可考虑的低风险方向：

- 确认 kubelet image GC 是否正常
- 清理不再使用的镜像前，先确认节点上运行中 Pod 依赖
- 优先通过 CRI/运行时命令清理，不直接删除 snapshot 目录
- 如果 GC 失败，先查 containerd/kubelet 日志中的具体错误

高风险动作：

- 删除 `/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/*`
- 删除 `/var/lib/containerd` 整体目录
- 未 drain 节点直接重启 containerd/kubelet

这些必须人工确认影响范围和回滚方案。

### 4. 容器日志暴涨场景

确认：

```bash
du -xh --max-depth=2 /var/log/pods 2>/dev/null | sort -h | tail -30
du -xh --max-depth=2 /var/log/containers 2>/dev/null | sort -h | tail -30
```

处理方向：

- 找到具体 namespace/pod/container
- 确认是否应用异常刷日志
- 检查 kubelet/container log rotate 配置
- 优先修应用或日志策略，而不是只删日志

### 5. PVC / PV 相关场景

确认：

```bash
kubectl get pvc -A
kubectl describe pvc -n <ns> <pvc>
kubectl describe pv <pv>
kubectl get storageclass
```

注意：

- PVC 满和节点根盘满是两类问题
- PV 后端目录不能当普通缓存目录清理
- 删除 PVC/PV/finalizer 属于高风险操作

## 客户可先提供的信息

对外回复时建议索要：

- 受影响节点/Pod/PVC 名称
- `df -h` 输出
- 大目录初步 `du` 输出
- `kubectl describe node` 中 DiskPressure 相关片段
- 相关 Pod event
- kubelet/containerd/docker 近 2 小时日志
- 最近是否大量拉取镜像、发布应用、导入数据、升级或扩容

## 不要直接建议客户做的动作

- 删除 `/var/lib/containerd` 或 `/var/lib/docker`
- 删除 PV 后端目录或业务数据目录
- 批量 `rm -rf` 大目录
- 未确认影响范围就重启 containerd/kubelet
- 未确认数据归属就删除 PVC/PV/finalizer

## 内部回复草稿

您好，目前需要先确认空间占用发生在哪一层。请协助提供受影响节点、Pod/PVC 名称、完整报错、`df -h`、关键目录 `du` 占用、`kubectl describe node` 中 DiskPressure 相关信息，以及 kubelet/containerd/docker 近 2 小时日志。请先不要直接删除 `/var/lib/containerd`、`/var/lib/docker`、PV 后端目录或业务数据目录，我们会根据占用来源确认安全处理方式。

## 重复工单补充：巡检磁盘告警与 containerd 目录咨询

近期重复工单主要落在两类：

- 巡检发现 `/var`、`/var/lib/docker`、`/cpaas` 超过 80%：先用 `df` + 分层 `du` 定位真实大目录，再区分是 Docker overlay、日志索引、`/cpaas/log` 还是业务文件。
- `/var/lib/containerd` 下 content / snapshot 目录超过 100G：不要直接删除目录；先用 `crictl images`、`crictl ps -a` 判断镜像与容器引用，再考虑 `crictl rmi --prune` 等运行时级清理。

经验边界：`docker system prune -a`、`crictl rmi --prune`、清理 `/cpaas/log/*` 都需要先确认影响范围；如果目录来自日志索引、业务数据或 PV 后端，不能套用镜像清理口径。

## 关联工单

- TICKET-1264894414：`/var/lib/kubelet` 与 `/var/lib/docker` 目录用途咨询，适合补充分层目录解释。
- TICKET-1271872834：`/cpaas` 使用率高，定位为日志索引占用并按保留策略清理。
- TICKET-1286324154：巡检发现 `/var/lib/docker` 超过 80%，建议先识别未使用镜像/容器与本地临时存储。
- TICKET-1309366154：根目录与 `/cpaas` 日志缓存清理咨询。
- TICKET-1319463324 / TICKET-1333164104：多节点 `/var/lib/docker`、`/cpaas` 告警，强调驱逐风险、异常大文件定位与扩容/清理边界。
- TICKET-1337093894：节点存储使用率高，按逐级 `du` 定位服务占用。
- TICKET-1328845144：`/var/lib/containerd` content/snapshot 目录过大，明确不能直接删目录。
- TICKET-1293660274 / TICKET-1328442894：containerd 数据目录用途、迁移和窗口期风险咨询。


## 重复工单补充：/cpaas ClickHouse 日志增长与 NFS 协议边界（2026-06-24）

- `/cpaas` 目录满不一定是容器运行时或普通日志问题。低版本 ClickHouse 场景可能存在慢查询日志/ClickHouse 日志无法定期清理、PV 落在业务集群 master 宿主机导致空间持续增长的情况。临时清理前必须先确认组件停机窗口、数据类型和可丢弃范围。
- PVC 创建失败若底层是 NFS，需确认 NFS 协议版本与客户端/StorageClass 支持情况；已有样本中从 NFS v4 改为 v3 后重新创建 PVC 成功。

### 处理边界

- 删除 ClickHouse 目录数据属于高风险动作，只能在确认“不需要历史慢查询/日志数据”、停止相关组件并有备份/回滚方案后执行。
- NFS v4 到 v3 的调整属于存储接入兼容性处理，不应与 PVC 容量不足、权限不足或 TopoLVM 问题混为一类。

### 关联工单补充

- TICKET-1355002634：`/cpaas` 满，低版本 ClickHouse 慢查询日志/日志无法定期清理，临时方案涉及停组件后清理 CK 目录历史数据。
- TICKET-1354793894：PVC 创建失败，底层 NFS 不支持 v4，改为 v3 后重新创建成功。

### Deep-case 信号补充

- 当前判断：可选。
- 原因：目录满和 NFS 协议不匹配是重复运维模式；但删除 CK 历史数据、PV 落盘位置和存储协议变更都有较高变更风险。
- 还缺什么证据：CK Pod/PV/YAML、目录 `du`、慢查询/日志保留配置、业务是否需要历史数据、NFS server/client 版本、StorageClass 参数、PVC event。

## Deep-case 信号

- 当前判断：可选。
- 原因：多数是重复运维处理模式，适合 runbook；只有清理后仍不释放、GC 失败或导致 Pod 异常时才需要 deep-case。
- 还缺什么证据：节点 `df/du` 全量输出、运行时镜像/容器引用、kubelet/containerd GC 日志、清理动作前后占用曲线、是否涉及业务/PV 数据。

## 相关链接

- [[storage-symptom-runbook]]
- [[workload-runtime-symptom-runbook]]
- [[observability-symptom-runbook]]
- [[platform-managed-command-audit-quick-card]]

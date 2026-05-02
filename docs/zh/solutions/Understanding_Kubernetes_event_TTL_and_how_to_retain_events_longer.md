---
kind:
  - Information
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500001
sourceSHA: 938f51d63096c7e6e23267ca336ddac92cd0c49fa15186aaa3ba971e0c46afe4
---

# 理解 Kubernetes 事件 TTL 及如何延长事件保留时间

## 概述

Kubernetes 将每一个重要的状态变化记录为一个 `Event` 对象。事件包含关于谁创建或修改了资源、哪个控制器对其进行了操作以及原因的上下文；它们共同构成了调试调度、镜像拉取、探针失败、OOM 和协调循环的主要线索。由于每个控制器的每个协调周期都可以发出一个或多个事件，因此事件的数量远远超过普通资源的变动——在繁忙的集群中，通常是一个数量级。

为了防止 etcd 被填满，apiserver 会在固定的生存时间后进行事件的垃圾回收。操作员经常会问三个问题：事件保留多长时间，保留时间是否可以调整，以及当需要 24 小时的事件历史进行取证工作时该怎么办。本文将逐一解答这些问题。

## 解决方案

### 默认保留时间

控制事件生命周期的 apiserver 标志是 `--event-ttl`。在上游 Kubernetes 中，它的默认值是 **一小时**。许多平台管理的 apiservers 在集群启动期间将其提高到 **三小时**；这种行为——每个事件在创建后大约三小时内静默消失——是大多数集群工程师在实践中观察到的。

确认正在运行的集群上的有效值：

```bash
kubectl -n kube-system get pod -l component=kube-apiserver \
  -o jsonpath='{.items[0].spec.containers[0].command}' \
  | tr ',' '\n' | grep -E 'event-ttl|--event-ttl'
```

如果 `--event-ttl` 缺失，则 apiserver 正在使用上游默认值。`--event-ttl=3h` 标志表示三小时的保留时间。

### 调整保留窗口

该标志是一个静态的 apiserver 参数，因此更改它需要重新滚动 apiserver pods。在自管理集群（kubeadm 或类似安装程序）上，在 apiserver 清单中设置该标志，并让 kubelet 重新启动静态 pod：

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml 在每个控制平面节点上
spec:
  containers:
    - name: kube-apiserver
      command:
        - kube-apiserver
        - --event-ttl=24h
        # ... 其他标志 ...
```

在由操作员管理的 apiserver 的平台上，该值通过操作员的 CR 而不是清单进行暴露。大多数平台管理的 apiservers 下，合法范围是 **5 分钟到 180 分钟（3 小时）**——超过该范围将被拒绝，因为事件数量 × 延长保留时间可能会超出 etcd 压缩预算，并在写入时触发 5xx 响应。

在提高 `--event-ttl` 之前，相应地调整 etcd 的大小：

- 存储：事件通常在 0.5–2 KiB 范围内；繁忙的集群轻松生成每秒 50 个事件，这意味着将保留时间从 3 小时增加到 9 小时大约增加 1 GiB 的 etcd 负载。
- 压缩：事件在压缩通过之前保持历史；更长的 TTL 推迟了压缩堆积量，并增加了峰值 `etcd_db_total_size_in_bytes`。

### 当 3 小时不够时——将事件转发到日志存储

支持的任意长事件历史的模式 **不是** 将事件保留在 etcd 中，而是将它们以与日志相同的方式发送到集群的日志存储。两种常见形式：

1. **eventrouter** — 一个小型 Deployment，监视事件 API 并将结构化日志行写入 stdout。将其与集群日志转发器配对，以便其 stdout 最终进入 Loki / Elasticsearch / S3，与容器日志一起。
2. **kube-events-exporter**（或任何写入 Loki 兼容推送 API 的控制器）——直接从事件 API 发送到日志后端。

示例 eventrouter Deployment：

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

将其绑定到允许 `events:list,watch` 的 ClusterRole：

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

一旦 eventrouter pod 运行，其 stdout 每个 Kubernetes 事件携带一个 JSON 对象；集群日志收集器将其作为 `infrastructure` 日志（或平台将 `cpaas-system` 命名空间路由到的任何流）拾取，并以与平台其他遥测相同的保留策略存储在长期日志存储中。

### 手动清除事件

当 etcd 被事件风暴压倒时——通常是一个控制器在紧密循环中每秒发出警告——事件的积累速度超过了 `--event-ttl` 的清除速度，etcd 快速增长，写入开始变慢。在根本原因仍在识别时，手动清理是合理的：

```bash
# 删除单个命名空间中的事件
kubectl -n busy-namespace delete events --all

# 删除所有命名空间中早于特定时间戳的事件
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

这两种形式都是安全的：删除事件不会对控制器产生副作用；它们仅作为审计历史存在。

## 诊断步骤

确认 apiserver 的有效 `--event-ttl`：

```bash
kubectl -n kube-system get pod -l component=kube-apiserver \
  -o yaml | yq '.items[0].spec.containers[0].command'
```

检查当前在 etcd 中存在多少事件，按命名空间分类：

```bash
kubectl get events -A --sort-by=.lastTimestamp \
  -o custom-columns=NS:.metadata.namespace \
  | sort | uniq -c | sort -rn | head -20
```

不均匀的分布（一个命名空间产生大部分事件）是限制噪声控制器的信号，然后再更改保留时间。

如果事件似乎超出了 `--event-ttl`（昨天的事件在重启后仍然可见），则底层 etcd 租约计数器可能没有前进——TTL 是通过 etcd 租约强制执行的，频繁的 etcd 领导者更换会在本地重置租约计数器。查找领导者更换：

```bash
kubectl -n kube-system logs ds/etcd -c etcd --tail=500 | grep -E 'leader|elected'
```

如果领导者选举每小时触发超过一次，请在调试事件保留之前修复 etcd 健康（磁盘延迟，心跳预算）。

要深入了解事件数量随时间的变化，apiserver 的 `apiserver_request_total{resource="events"}` 计数器显示 apiserver 正在处理多少事件写入——这对于根据预期的稳态负载调整 `--event-ttl` 非常有用：

```bash
kubectl -n cpaas-monitoring exec deploy/prometheus-cluster-monitoring -- \
  promtool query instant http://localhost:9090 \
  'sum by (verb) (rate(apiserver_request_total{resource="events"}[5m]))'
```

如果事件创建速率 × `--event-ttl` 超过可用的 etcd 头部空间，则提高 TTL 是错误的修复——而是通过 eventrouter 将其转发到日志存储。

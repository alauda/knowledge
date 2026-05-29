---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500424
sourceSHA: 12595f8fe08ae8b032f09fa95536ebb7b98f5765dc39344809998545a7e3ca2b
---

# kube-apiserver Secret watch-cache LIST 在累计 Secret 字节超过 apiserver-etcd 消息大小时失败，出现 gRPC ResourceExhausted 错误

## 问题

在运行 Kubernetes `v1.34.5` 的 Alauda 容器平台上（kube-apiserver 镜像 `tkestack/kube-apiserver:v1.34.5`，etcd 镜像 `tkestack/etcd:v3.5.28-260325`），kube-apiserver pod 是 kubeadm 风格的静态 pod，位于 `kube-system` 命名空间，并通过 TLS gRPC 通道以 `https://127.0.0.1:2379` 连接到单成员 etcd，使用 `apiserver-etcd-client` 证书；apiserver 内部的 watch-cache 子系统（`cacher.go`）对 etcd 发出初始 LIST 请求以获取所有 `*core.Secret` 对象，响应作为单个 gRPC 消息通过该 apiserver-etcd 连接返回。

当该单个 LIST 响应的大小超过 gRPC 客户端的最大接收消息大小时，kube-apiserver Secret watch-cache 无法初始化，cacher 发出 `unexpected ListAndWatch error: failed to list *core.Secret: rpc error: code = ResourceExhausted desc = grpc: trying to send message larger than max (<actual-bytes> vs. <limit-bytes>)` 的行自 `cacher.go`；在此构建的 ACP kube-apiserver 日志中观察到相同的 `cacher.go:<line>]` 发射器格式。当 cacher 在此状态下卡住重新初始化时，通常会从 kube-apiserver Secret watch-cache 提供的 Secret LIST 和 WATCH 请求无法成功完成。

## 根本原因

此构建中的 apiserver-to-etcd 连接使用普通的上游 gRPC，且 kube-apiserver 不提供标志以提高其 gRPC 客户端侧的 `MaxRecvMsgSize` 用于 etcd 通道；此构建中的 kube-apiserver 命令行仅携带 `--etcd-cafile` / `--etcd-certfile` / `--etcd-keyfile` / `--etcd-servers` 标志，而没有 gRPC 消息大小覆盖，因此上游 gRPC 默认值 `math.MaxInt32`（2147483647 字节，约 2 GiB）适用于 apiserver-etcd 通道。

导致此故障的条件是结构性的：存储在 etcd 中 `/kubernetes.io/secrets/` 前缀下的所有 `core/v1` Secret 对象的累计磁盘大小必须超过正在使用的 gRPC 最大接收消息大小（在默认情况下约为 2 GiB），以使携带每个 Secret 的单个 LIST 响应溢出 gRPC 消息限制并产生上述 `ResourceExhausted` 错误。在检查的集群中，当前的占用为 122 个 Secret，整体约为 1.1 MB 的 apiserver JSON，远低于默认上限；故障模式在结构上是可能的，但在此环境中并未激活。

## 解决方案

删除那些组合大小使累计 `/kubernetes.io/secrets/` 占用在 etcd 中回落到 gRPC 最大接收消息大小以下的 `core/v1` Secret 对象；这恢复了 kube-apiserver Secret watch-cache 完成其初始 LIST 的能力，并再次提供 Secret LIST/WATCH 请求。ACP 上的 Secret 删除路径是通过 kube-apiserver 的标准上游 `core/v1` Secret 删除，并将前缀降低到 \~2 GiB gRPC 上限恢复 cacher 初始化。

首先针对最大的 Secrets，使用下面的诊断操作步骤识别，并优先删除那些由其控制器重新创建的 Secrets（例如，重新生成的 TLS 材料）或明显未使用的 Secrets，然后再删除任何无法重建内容的 Secret：

```bash
kubectl delete secret <name> -n <namespace>
```

请注意，ACP etcd 进程以 `--max-request-bytes=3145728`（3 MiB）和 `--quota-backend-bytes=8589934592`（8 GiB）启动；这些是服务器端 etcd 限制，与控制 LIST 响应的 apiserver 侧 gRPC `MaxRecvMsgSize` 上限不同，因此对这些 etcd 标志的更改不会改变此故障模式触发的 apiserver 侧上限。

## 诊断步骤

确认 `kube-system` 中 kube-apiserver pod 的 cacher 发射；当故障处于活动状态时，`*core.Secret` 的 watch-cache 初始化周围的 `cacher.go` 行会携带 `ResourceExhausted` 形状：

```bash
kubectl -n kube-system get pods -l component=kube-apiserver
kubectl -n kube-system logs <kube-apiserver-pod> | grep -E 'cacher\.go|ResourceExhausted|\*core\.Secret'
```

直接从 etcd 枚举每个 Secret 的磁盘大小，以识别对 `/kubernetes.io/secrets/` 前缀的最大贡献者。ACP 上的 etcd 镜像在容器中提供 `etcdctl` 版本 `3.5.28`（API 3.5），并且可以通过 `kubectl exec` 访问 `kube-system` 中的 etcd 静态 pod，集群 CA 和客户端证书标志挂载在标准 kubeadm 路径下：

```bash
kubectl -n kube-system exec etcd-<node> -- \
  etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    get --prefix --keys-only /kubernetes.io/secrets/
```

对于返回的每个键，值的 protobuf 字节长度给出每个 Secret 的磁盘大小；将每个键的 `etcdctl get <key> -w protobuf` 包裹在对键列表的循环中，并通过 `wc -c` 管道其响应，生成一个 `<size> <key>` 的统计，可以按降序排序以排名最大的 Secrets，并识别删除候选：

```bash
kubectl -n kube-system exec etcd-<node> -- sh -c '
  for key in $(etcdctl \
      --endpoints=https://127.0.0.1:2379 \
      --cacert=/etc/kubernetes/pki/etcd/ca.crt \
      --cert=/etc/kubernetes/pki/etcd/server.crt \
      --key=/etc/kubernetes/pki/etcd/server.key \
      get --prefix --keys-only /kubernetes.io/secrets/); do
    size=$(etcdctl \
      --endpoints=https://127.0.0.1:2379 \
      --cacert=/etc/kubernetes/pki/etcd/ca.crt \
      --cert=/etc/kubernetes/pki/etcd/server.crt \
      --key=/etc/kubernetes/pki/etcd/server.key \
      get "$key" -w protobuf | wc -c)
    echo "$size $key"
  done | sort -rn
'
```

将每个 Secret 的 protobuf 字节长度在整个 `/kubernetes.io/secrets/` 前缀中相加，以估算累计占用，并与 \~2 GiB 默认 gRPC 上限进行比较；这是 cacher LIST 响应在单个 gRPC 消息中携带的数量，也是必须低于上限以使 watch-cache 初始化再次成功的数字。

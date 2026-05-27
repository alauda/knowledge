---
kind:
  - Information
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
sourceSHA: b46e32f172e449a70ee0d5c619c5e890f25a1ed25661e58091b607a77965d893
---

# 在 ACP 上 etdc "拒绝连接"（服务器名称与证书不匹配）

## 问题

在运行 etcd 的 Alauda Container Platform 集群中，作为 kubeadm 风格的静态 Pod（`kube-system` 中的 `etcd-<control-plane-IP>`，镜像 `registry.alauda.cn:60080/tkestack/etcd:v3.5.28-260325`，kube `v1.34.5`），etcd Pod 日志包含警告，其 `msg` 为 `rejected connection on client endpoint`。每一行都是由 etcd 自身的嵌入包发出的，并以结构化的 JSON 记录形式显示，包含 `level=warn`、`caller=embed/config_logging.go:177`、连接对等体的 `remote-addr`、`server-name` 字段，以及描述为何在交换任何应用字节之前丢弃入站连接的 `error`。

一个典型的日志条目如下所示：

```text
{"level":"warn","caller":"embed/config_logging.go:177","msg":"rejected connection on client endpoint","remote-addr":"127.0.0.1:33772","server-name":"","error":"..."}
```

`remote-addr` 字段记录了连接对等体的源 IP 和源端口，以 `ip:port` 形式表示，这使其成为识别谁发起了丢弃连接的主要依据。

## 根本原因

该警告由 etcd 自身生成，发生在其 TLS 监听器的 `embed` 包中，当一个传入的 TCP+TLS 连接在服务器能够读取任何应用数据之前被关闭时。此类行上的空 `server-name=""` 字段表明连接的 TLS 客户端在其 ClientHello 中未发送服务器名称指示（SNI）扩展 — etcd 记录它收到的 SNI（如果没有提供则为空字符串），并将其包含在拒绝日志中，以便操作员可以查看连接客户端在握手时提供的内容。

在这个 ACP 控制平面中，etcd 的主要 TLS 客户端是作为静态 Pod 运行的 kube-apiserver（`kube-system` 中的 `kube-apiserver-<control-plane-IP>`）；每个控制平面节点运行一个 kube-apiserver 静态 Pod，而该 apiserver 是 etcd 的 CRUD 和监视流量的客户端。在单控制平面集群中，`remote-addr` 值返回为 `127.0.0.1:<ephemeral-port>`；在多主节点集群中，警告通常携带对等控制平面节点的 IP，反映来自其他主节点上 kube-apiserver 实例的连接。

请注意，`remote-addr=127.0.0.1` 仅表明连接源自 *同一主机* 上的进程 — 它本身并不能证明源是 kube-apiserver。任何本地客户端（健康探针、备份作业、`etcdctl` 调用、监控侧车）打开到 `127.0.0.1:2379` 的 TLS 连接，然后在完成握手之前关闭它，都会产生相同格式的行。kube-apiserver 是控制平面节点上预期的主要本地客户端，因此是第一个候选者，但应通过关联源端口与拥有进程来确认归属（参见诊断步骤），而不是仅仅从回环地址推断。

## 解决方案

当此警告单独存在时 — 即 etcd 没有活动警报且其端点健康状况保持良好 — 该警告本身不需要操作员采取行动，也不会降低集群性能。在测试环境中，即使 etcd 日志中存在 121 条 `rejected connection` 警告，`etcdctl alarm list` 也返回了零行，且端点报告健康，提交提案延迟约为 11.6 毫秒，完全在正常范围内。

在将这些警告视为可操作之前，先进行快速健康检查：

```bash
kubectl -n kube-system exec etcd-<control-plane-IP> -- etcdctl \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  --endpoints=https://127.0.0.1:2379 \
  endpoint health
```

```bash
kubectl -n kube-system exec etcd-<control-plane-IP> -- etcdctl \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  --endpoints=https://127.0.0.1:2379 \
  alarm list
```

如果端点健康为 `is healthy` 且 `alarm list` 返回零行，则 `rejected connection` 警告是信息性的，集群可以继续在没有干预的情况下运行。

## 诊断步骤

直接从 `kube-system` 中的 etcd 容器日志中检索警告，并过滤出字面上的 `rejected connection` 字符串。etcd 静态 Pod 名为 `etcd-<control-plane-IP>`（每个控制平面节点一个） — 将节点 IP 替换为正在检查的集群：

```bash
kubectl logs -n kube-system etcd-<control-plane-IP> | grep 'rejected connection'
```

例如，在控制平面 IP 为 `192.168.135.152` 的单主节点 ACP 测试集群中：

```bash
kubectl logs -n kube-system etcd-192.168.135.152 | grep -i 'rejected connection'
```

每个匹配的行都是一个结构化的 JSON 记录；用于分类的主要字段是 `remote-addr`、`server-name` 和 `error`。

检查 `remote-addr` 以识别连接对等体。该值遵循 `ip:port` 格式。在单控制平面集群中，值为 `127.0.0.1:<ephemeral-port>`，这将源缩小到同一主机上的进程 — 最有可能是本地 kube-apiserver，但仅从地址本身无法证明。在多主节点集群中，非回环 IP 映射到另一个控制平面节点，指向该对等体上的 kube-apiserver 静态 Pod（`kube-apiserver-<control-plane-IP>` 在 `kube-system` 中）。

要确认哪个本地进程拥有回环连接，而不是假设它是 kube-apiserver，请将 `remote-addr` 中的源端口与节点上的拥有进程进行关联。在控制平面节点上打开主机 shell（例如通过 `kubectl debug node/<name>` 或平台的节点访问路径），并将连接的源端口与 PID 和命令匹配：

```bash
ss -tnp | grep ':2379'
```

与 `remote-addr` 端口匹配的本地/对等端口的行显示了 `users:(("<comm>",pid=<pid>,...))` 字段中的拥有进程；常规控制平面流量应期望为 `kube-apiserver`，将任何其他命令视为该行的实际来源。由于源端口是短暂的，因此在连接处于活动状态时运行此命令，而不是事后运行。

当给定记录的 `server-name` 是空字符串时，连接客户端在其 ClientHello 中打开 TLS 握手时未提供 SNI 值 — 这对于 etcd 的内部客户端流量是正常的，并由 etcd 的嵌入监听器逐字报告。

交叉检查 etcd 健康状况，以排除伪装成嘈杂日志的真实故障：

```bash
kubectl -n kube-system exec etcd-<control-plane-IP> -- etcdctl \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  --endpoints=https://127.0.0.1:2379 \
  endpoint health
```

健康的端点没有活动警报，配合这些 `rejected connection` 警告，与解决方案中描述的良性状态一致。

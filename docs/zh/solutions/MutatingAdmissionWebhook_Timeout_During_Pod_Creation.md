---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500015
sourceSHA: 58f9029a93d20a2b29f28daf28991e63e88fe4e0d0b8aa82b08ed3af820a5fac
---

# ACP 上的 MutatingAdmissionWebhook 申请超时 — webhook、网络和 etcd 作为原因

## 问题

在 Alauda 容器平台上（在 Kubernetes `v1.34.5` 和上游 etcd v3 静态 Pod 控制平面上验证），kube-apiserver 运行上游 Kubernetes 申请链，任何未能在其配置的每次调用超时内返回的注册变更 webhook 会导致 apiserver 失败整个申请决策。调用者（控制器和 `kubectl` 客户端）会观察到 `Internal error occurred: admission plugin "MutatingAdmissionWebhook" failed to complete mutation in <N>s` 的响应，其中字面量 `<N>s` 值是 webhook 配置在调用时声明的超时。由于申请拒绝是同步的，因此每个经过缓慢 webhook 的工作负载创建路径 — 由控制器创建的 Pod、直接 `kubectl apply`、生成子对象的 CR 协调 — 都会出现相同的错误，并停止对受影响对象的进展。

该症状并不局限于一个组件，因此相同的错误字符串可以出现在任何通过申请驱动对象创建的控制平面或工作负载控制器的日志中。消息的形状由上游 Kubernetes apiserver 固定；只有超时值和失败的 webhook 身份在不同的出现之间变化。

## 根本原因

超时本身并不能确定 webhook 调用的哪一方是缓慢的。Webhook 通过读取和写入集群状态来响应申请请求，而在 apiserver 端，这一往返过程落在 etcd 上；如果链中的任何环节 — webhook Pod、apiserver 和 webhook 服务之间的网络路径，或 webhook Pod 依赖的 etcd 后端 — 足够缓慢以将请求推过声明的超时，则申请将以相同的措辞失败。反之亦然：一个处于 `Running` 状态且在其自身日志中未报告错误的 webhook Pod 仍然可能是原因，因为申请吞吐量受请求路径中最慢步骤的限制，而不仅仅是 Pod 的就绪状态。

因此，etcd 性能是一个候选根本原因，但它并不是唯一的原因，也不是首先要调查的原因。在调查转向 etcd 之前，必须排除 webhook Pod 侧的故障（webhook 进程作为进程是健康的，但自身缓慢、在其自身依赖上死锁，或对请求速率来说规模不足）和 apiserver Pods 与 webhook 服务之间的 Pod 到 Pod 网络问题。

## 解决方案

按照证据权重指示的顺序处理原因。首先，确认 webhook Pod 的健康状况超出简单的就绪性：支持失败的 webhook 服务的 Pods 可能处于 `Running` 状态并且自身未发出错误，而通过它们的申请请求仍然超时，因此仅仅是存活性并不能解除怀疑。直接检查 webhook Pods — 列出它们所在的命名空间，读取所有副本的日志，并确认它们实际上正在提供 `MutatingWebhookConfiguration` 指向的申请端点。

识别失败的 webhook 及其 Pods：

```bash
kubectl get mutatingwebhookconfiguration -o yaml \
  | grep -E 'name:|service:|namespace:|timeoutSeconds:' | head -40
kubectl get pods -A -l <webhook-app-label>
kubectl logs -n <webhook-ns> <webhook-pod> --previous --tail=200
```

其次，排除 apiserver 和 webhook 服务之间的 Pod 到 Pod 网络问题。apiserver 通过集群服务网络拨打 webhook，因此往返延迟、对 webhook 服务的 DNS 解析以及该路径上的任何 CNI 级别丢失都影响预算。

第三 — 仅在前两个清洁后 — 转向 etcd。验证集群的 etcd 是否满足适用于该平台的文档后端性能要求。etcd 后端性能是上游发布的 fsync / 提交延迟的标准，必须在任何控制平面组件被期望表现出可预测性之前清除；同样的后端标准适用于 ACP，因为控制平面运行上游 etcd v3 二进制文件。使用 Prometheus 绘制 etcd 指标，以评估实际性能与该标准的对比，使用 etcd 二进制文件在其指标端点上导出的标准上游 etcd 直方图。抓取这些系列的 Prometheus 实例是位于 `cpaas-system` 命名空间中的 kube-prometheus 堆栈；每个实例的仪表板遵循上游 etcd 仪表板的形状。

如果指标显示后端已超出其磁盘封装，进行 etcd 的碎片整理以减少磁盘上的数据库大小是值得尝试的补救措施。碎片整理回收由墓碑和历史修订释放的空间，并缩小 `db` 文件；它是按成员逐个执行的，以避免使法定人数下降。该操作使用与相同 etcd v3 版本一起分发的 etcdctl 客户端，针对每个成员的本地客户端 URL 调用，使用成员自己的对等/客户端 TLS 证书 — 精确的证书路径来自 etcd 容器自身的命令行标志，这些标志在服务器端设置 `--cert-file`、`--key-file` 和 `--trusted-ca-file`，并要求匹配客户端侧的 `--cacert / --cert / --key` 参数，以便针对 TLS 仅监听客户端 URL 的任何 etcdctl 调用。

无论最初出现超时的工作负载组件是哪个，均适用相同的先 webhook 后网络再 etcd 的顺序 — 创建 Pods 的控制器、CR 协调器和临时 `kubectl` 调用者都共享单一的申请链，因此恢复最慢链接的修复将恢复它们所有。

## 诊断步骤

从错误字符串本身开始。apiserver 发出的消息 `admission plugin "MutatingAdmissionWebhook" failed to complete mutation in <N>s` 是注册的变更 webhook 出现故障的规范信号；捕获字面超时值和任何调用方侧的包装上下文（哪个控制器 / 哪个对象）来自出现的日志行。

列举注册的变更 webhook 及其托管的命名空间：

```bash
kubectl get mutatingwebhookconfiguration -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.webhooks[*].clientConfig.service.namespace}/{.webhooks[*].clientConfig.service.name}{"\n"}{end}'
```

对于每个候选 webhook，检查支持的 Pods，并确认“Pod 运行”不是唯一依赖的信号；将请求量和 webhook 导出的任何内部延迟与申请超时的时间窗口相关联。一个进程存活但在其自身后端上停滞的 webhook Pod 是这种故障最常见的形态，并且对就绪探测是不可见的。

当 webhook Pods 和 apiserver 与 webhook 之间的网络路径均未显示问题时，在宣布原因未知之前扩大范围以检查 etcd 性能。验证 etcd 是否符合文档中规定的后端性能要求，加上在 Prometheus 中绘制 etcd 直方图，为 etcd 侧的缓慢是否使本应健康的 webhook 超出其申请预算提供了一个有力的答案。如果该调查显示后端增长是一个因素，则每个成员的碎片整理过程是针对性的补救措施。

---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500161
sourceSHA: 418cc8a8058d078b656a52ca52b29697e5bfba7a04ffa66e503a9015406d23bf
---

# 节点状态为 NotReady，且 ACP 上存在高负载平均和 D 状态进程

## 问题

在 Alauda Container Platform（Kubernetes `v1.34.5`，节点运行 Ubuntu 22.04.1 LTS，内核为 `5.15.0-56-generic`，并使用默认的上游 sunrpc / NFS 客户端模块）上，节点可能会在 `kubectl get nodes` 中显示 `STATUS=NotReady`，而同一主机上的 `uptime` 报告的 1/5/15 分钟负载平均值大致等于大量进程卡在 `D`（不可中断睡眠）任务状态，且实际 CPU 消耗微不足道。Linux 内核在负载平均计算中包含不可中断睡眠任务，因此一波被阻塞的任务即使没有进程在 CPU 上运行，也会抬高负载数字。节点对象的 Ready 条件遵循 ACP 上游的 `.status.conditions[?(@.type=='Ready')]` 结构，因此健康的节点打印 `reason=KubeletReady` / `status=True` / `message=kubelet is posting ready status`；当 kubelet 的主机无法向前推进时，NotReady 转换会在同一字段中显现。

## 根本原因

被阻塞的任务在内核 sunrpc 客户端中处于睡眠状态。使用 `ps -elfL` 采样每个线程的状态，可以看到每个线程的 `WCHAN` 列，`rpc_wa`（内核符号 `rpc_wait_bit_killable` 的截断）标记了一个线程，该线程停在 sunrpc 客户端中等待 RPC 回复。处于 `rpc_wait_bit_killable` 中的线程通常在等待 NFS 服务器的响应。无响应的 NFS 服务器会在节点的内核环形缓冲区中打印匹配的行：`nfs: server <ip> not responding, timed out` 和 `nfs: server <ip> not responding, still trying` 是挂载停滞的典型内核日志字符串。随着更多应用线程触及挂起的挂载，更多线程进入 D 状态，负载平均值与积压成正比上升，主机最终承载了足够的不可中断工作，导致 kubelet 的 Ready 条件从 `True` 变为 NotReady。

堆积的持续性是 NFS 硬挂载语义的一个特性：在硬挂载（默认情况下）下，等待服务器的线程无法被任何信号中断，因此对卡在 `rpc_wait_bit_killable` 中的 D 状态线程执行 `kill -9` 没有任何效果。使用 `soft` 选项挂载 NFS 会导致客户端在 `retrans` 重传后返回错误给调用应用，而不是无限期阻塞；这种权衡是当请求到达服务器但被报告为失败时，可能会导致静默数据损坏，这就是为什么 `hard` 是上游默认值的原因。

## 解决方案

首先修复底层的 NFS 服务器 / 网络故障——这些步骤在集群外部进行（恢复 NFS 服务器，修复网络路径，或取消导出卷）。由于硬挂载会无限期重试而不是失败，因此停在 `rpc_wait_bit_killable` 中的线程在服务器回答其未完成的 RPC 后恢复，因此一旦服务器再次可达，D 状态的部分积压通常会在没有进一步操作的情况下自行清除。仅在确认服务器可达后，线程仍然卡在 `D` 状态时，或当积累的积压已经使节点变为 NotReady，并且您需要迅速将其恢复到服务状态时，才重启受影响的节点；在这种情况下，严格在故障修复后重启，否则在下次挂载访问时会重新构建相同的积压。排空节点，重启它，并通过正常的隔离 / 解除隔离流程将其返回。

对于可以容忍应用可见错误而不是无限期等待的工作负载，使用 `soft` 选项重新挂载受影响的 NFS 卷，以便客户端在 `retrans` 重传后返回到用户空间；接受这会使工作负载暴露于部分完成写入时的静默数据损坏，这就是 `hard` 是上游默认值的原因。相同的 `hard`/`soft`/`retrans` 语义在该平台上的 NFS 支持的 PV 上均适用：目录中提供了一个 NFS CSI ModulePlugin（`chart-csi-driver-nfs`，默认通道 `v4.4.0-beta.7`），它通过标准的 Linux NFS 客户端进行挂载，因此内核侧的挂载选项在 Kubernetes `v1.34.5` 集群中保持不变。

## 诊断步骤

首先从集群侧确认节点级症状。`kubectl get nodes` 显示受影响节点的 `STATUS=NotReady`，而 `.status.conditions[?(@.type=='Ready')]` 上的 Ready 条件包含上游 NodeCondition 字段（`type`、`status`、`reason`、`message`、`lastHeartbeatTime`、`lastTransitionTime`）；健康的对等节点打印 `reason=KubeletReady` / `message=kubelet is posting ready status`，因此与任何 Ready 对等节点的比较是最快的合理性检查：

```bash
kubectl get nodes
kubectl get node <node-name> -o jsonpath="{.status.conditions[?(@.type=='Ready')]}{'\n'}"
```

通过集群的标准节点访问方法在受影响的节点上打开主机级 shell——通常是 `kubectl debug node/<name>` 调试 pod，直接从安装主机 SSH，或平台文档中记录的任何节点管理员路径；主机侧的诊断命令（`uptime`、`ps -elfL`、`dmesg`）在所有入口路径中保持不变。从该主机 shell 中，检查负载平均值和 D 状态线程的计数 / WCHAN。负载平均值远高于可运行进程计数，并结合 `ps -elfL` 行的状态列为 `D`，且 `WCHAN` 列读取为 `rpc_wa`，确认线程被阻塞在 sunrpc 客户端中：

```bash
uptime
ps -elfL | awk '{if($2~"D"){print $13}}' | sort | uniq -c
```

读取内核环形缓冲区以获取 NFS 服务器超时消息——`nfs: server <ip> not responding, timed out` 和 `nfs: server <ip> not responding, still trying` 行识别出哪个服务器停滞：

```bash
dmesg -T | grep -E 'nfs: server .* not responding'
```

尝试通过信号清除积压是预期会失败的：向在 NFS 硬挂载上卡在 `rpc_wait_bit_killable` 的线程发送 `SIGKILL` 不会中断睡眠，因此对这样的线程执行 `kill -9 <pid>` 会使其保持在 `D` 状态。一旦底层 NFS 故障已被修复，重启节点以排空积累的 D 状态任务。

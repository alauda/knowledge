---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500587
sourceSHA: 0a30d21624a4d7fc8251df598a11d601f48022c993c3acf6cd86a155cff1993d
---

# ACP 工作节点上的 Pod CrashLoopBackOff，绑定地址已在使用中

## 问题

在运行 Kubernetes v1.34.5 的 ACP 工作节点上，当 Pod 的容器在启动时无法获取所需的 TCP 监听端口时，Pod 可能会进入 `CrashLoopBackOff` 状态，且 kubelet 会在每次失败尝试后不断重启该容器。随着重启循环的继续，kubelet 会针对该 Pod 发出 `BackOff` 事件，这些事件在 `kubectl describe pod` 输出中与其他重复的容器故障以相同方式显示。

容器自己的日志流通常以运行时写入的 `bind: address already in use` 行结束，当应用程序的 `bind(2)` 调用被拒绝时。紧接在该行之前的应用程序级消息是特定于应用程序的——例如 `error received after stop sequence was engaged` 或 `failed to start metrics server: failed to create listener`——因此它本身并不是一个可靠的跨应用程序诊断信号。跨应用程序的稳定信号是容器日志中的尾部 `bind: address already in use` 子字符串。

## 根本原因

当容器的 `bind(2)` 以这种方式失败时，标准的 k8s 侧表现是 kubelet 针对失败容器的 `BackOff` 事件，底层的 `bind: address already in use` 套接字绑定失败保留在容器日志中。`EADDRINUSE` 的通用 POSIX/Linux 意义是另一个进程已附加到相同的网络命名空间并持有目标端口，因此新容器的 `bind(2)` 无法成功。当被占用的端口恰好是新容器所需的端口时，每次重启尝试都会以相同的方式失败，Pod 将无限期保持在 `CrashLoopBackOff` 状态；在实践中，持有者通常是主机侧进程或集群内的第三方智能体（例如不属于 ACP 平台的安全、监控或审计智能体），它之前打开了该端口并且在 Pod 重启时未释放。

## 诊断步骤

确认 Pod 正在循环重启，并检查 kubelet 针对失败容器的 `BackOff` 事件，这些事件在 kubelet 的重启循环处于活动状态时出现在 `kubectl describe pod` 的 `Events:` 部分：

```bash
kubectl -n <namespace> get pod <pod> -o wide
kubectl -n <namespace> describe pod <pod>
```

查看容器自己的日志以获取绑定错误。尾部的 `bind: address already in use` 子字符串是主要信号；其上方的行因应用程序而异：

```bash
kubectl -n <namespace> logs <pod> -c <container>
kubectl -n <namespace> logs <pod> -c <container> --previous
```

如果日志显示绑定错误，原因是同一网络命名空间中的另一个进程已持有目标端口。在受影响的工作节点上，识别绑定到该端口的内容（例如使用 `ss -ltnp` 或 `lsof -iTCP:<port> -sTCP:LISTEN` 从节点调试会话）以确定持有者是主机侧进程还是另一个集群内智能体。

## 解决方案

停止持有端口的进程或智能体，以便新容器的 `bind(2)` 能够成功。当持有者是一个第三方集群内智能体（未与 ACP 捆绑的安全、监控或审计智能体）并且在 Pod 重启期间保留了该端口时，请在重启工作负载之前禁用或停止该智能体。

在停止了有问题的持有者后，重新创建受影响的 Pods，以便 kubelet 启动新的容器，这些容器可以绑定其端口并退出 `CrashLoopBackOff`：

```bash
kubectl -n <namespace> delete pod <pod>
```

如果在怀疑的持有者停止后端口仍然被占用——例如因为工作节点上仍有孤立进程拥有该套接字——请重启受影响的工作节点以清除孤立的端口持有者，此后重新调度的 Pods 可以正常绑定其端口。

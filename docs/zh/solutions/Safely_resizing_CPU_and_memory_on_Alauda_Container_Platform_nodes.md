---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500218
sourceSHA: 6bca0ec18bf49c78286099452801d79b067940735dd20d0c8ca9ede9e606fe31
---

# 安全地调整 Alauda Container Platform 节点的 CPU 和内存

## 问题

在 Alauda Container Platform（Kubernetes 服务器 `v1.34.5`）上，有时需要在不干扰正在运行的工作负载的情况下增加工作节点或控制平面节点的 CPU 或内存容量。这种更改的安全方式是一次通过集群移动一个节点，以便其余节点继续托管被驱逐的 Pod，同时对单个节点进行修改。将此操作视为每个节点的循环——而不是一次性驱逐多个节点——可以保持集群容量可用，并限制调整大小过程中任何错误的影响范围。

## 解决方案

对于每个节点，在触及底层机器之前，先将节点标记为不可调度并驱逐其工作负载。`cordon` 子命令对单个节点参数操作，并将节点设置为不可调度状态，以便调度程序停止在其上放置新 Pod：

```bash
kubectl cordon <node-name>
```

然后驱逐同一节点上的 Pod，以便将其重新调度到剩余节点上。`kubectl drain` 首先对节点进行 cordon 操作，然后在其上运行 Pod 的驱逐循环，这是节点维护的标准准备步骤：

```bash
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
```

驱逐命令暴露了 `--delete-emptydir-data` 标志，用于驱逐由 `emptyDir` 卷支持的 Pod；较旧的 `--delete-local-data` 标志在当前的 `kubectl` 版本中不再存在，必须避免使用。每当存在由 DaemonSet 管理的 Pod 时，`--ignore-daemonsets` 标志是必需的，因为如果没有它，驱逐将拒绝继续；设置该标志后，驱逐循环会跳过 DaemonSet Pod，只有声明没有控制器的 Pod 会阻止驱逐。

一旦驱逐完成，现已空闲的节点可以进行底层的调整大小。在机器上执行底层调整大小，并在更改完成后将其恢复为服务。由于之前的 `cordon` 在 Node API 对象上设置了 `spec.unschedulable=true`，该 spec 字段继续驱动 `kubectl get node -o wide` 显示的 `SchedulingDisabled` 列，而不管节点的 `Ready` 状态，因此节点在显式取消 cordon 之前将保持不可调度状态，无论何时重新加入集群：

```bash
kubectl get node <node-name> -o wide
```

使用 `uncordon` 将节点恢复为活动服务，这是 `cordon` 的逆操作，并再次标记节点为可调度，以便调度程序可以在其上放置新 Pod：

```bash
kubectl uncordon <node-name>
```

对下一个节点重复 cordon → drain → resize → uncordon 的顺序，保持一次只处理一个节点，以便集群始终保留足够的容量来吸收被驱逐的工作负载。

## 诊断步骤

在每个周期步骤中，使用 `kubectl get node -o wide` 检查节点的状态。当节点被 cordoned 时，Node 对象报告 `Ready` 以及 `SchedulingDisabled`，因为 `Ready` 状态通过 `.status.conditions[type=Ready]` 报告，而 `SchedulingDisabled` 列由 Node API 上的 `spec.unschedulable` 驱动：

```bash
kubectl get node -o wide
```

在 `uncordon` 运行后，`spec.unschedulable` 字段被清除，节点返回到普通的 `Ready` 状态，确认在下一个节点进入维护之前，可以在其上调度工作负载。

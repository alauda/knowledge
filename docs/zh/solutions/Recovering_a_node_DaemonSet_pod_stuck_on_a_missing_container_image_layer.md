---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500172
sourceSHA: bbfe36602a7400155fd18eaab1b575a87799e9ee4469720ea9c7b28623f7fdc2
---

# 恢复因缺失容器镜像层而卡住的节点 DaemonSet Pod

## 问题

在运行 `containerd://2.2.1-5` 运行时的 Alauda 容器平台工作节点上，由 `apps/v1` DaemonSet 所拥有的 Pod 可能无法启动，表现为 Pod 状态列中的容器创建或镜像拉取等待原因（例如 `CreateContainerError`、`ImagePullBackOff` 或 `ErrImagePull`），通过 `kubectl get pods -n <namespace>` 返回。该情况是节点本地的——只有调度到受影响节点的 Pod 进入等待状态，而其他节点上相同 DaemonSet 的副本继续正常启动。

## 根本原因

受影响节点上的 DaemonSet Pod 无法通过容器创建/镜像拉取阶段，因此 kubelet 在每次重试时都持续报告相同的等待原因（`CreateContainerError`、`ImagePullBackOff` 或 `ErrImagePull`）在 Pod 状态列中。由于 DaemonSet 控制器在每个节点上固定一个 Pod，因此在该节点上的重试循环将持续进行，直到本地条件被清除，而其他节点上的 DaemonSet Pod 不受影响。

## 解决方案

使用 `kubectl debug node/<node>` 在受影响节点上打开一个 shell，并对本地 CRI 套接字运行 `crictl rmi --prune`——`crictl` 客户端与 containerd 安装一起提供，`--prune` 子命令是 CRI 通用的，因此它会从运行时中删除未使用和悬挂的镜像，而不管使用的是哪种 CRI 实现。在清理完成后，kubelet 的下一个容器创建尝试会重新拉取镜像并干净地重建层，这在一般情况下足以清除等待状态。

```bash
# 从具有 kubectl 访问集群的工作站
kubectl debug node/<node> -it --image=<debug-image>

# 在调试 Pod 内
crictl rmi --prune
```

如果 `crictl rmi --prune` 本身返回套接字错误，则节点上的 containerd 守护进程未运行，CLI 无法访问 CRI 套接字（`containerd.sock`）；首先通过重新启动运行时来解决此问题，然后再重试清理。对于任何其他与运行时通信的 `crictl` 子命令也适用相同的依赖关系。

当无法在原地重新启动运行时且节点必须离线修复时，首先使用 `kubectl drain --ignore-daemonsets --delete-emptydir-data <node>` 驱逐工作负载——如果没有 `--ignore-daemonsets`，则驱逐将拒绝进行，因为 DaemonSet 管理的 Pod 默认不可驱逐；使用该标志，驱逐将节点标记为不可调度，并驱逐非 DaemonSet Pod，以便对节点进行处理。在运行时恢复正常后，使用 `kubectl uncordon <node>` 将节点返回给调度器，以便它再次接受新 Pod。

```bash
kubectl drain --ignore-daemonsets --delete-emptydir-data <node>
# 修复节点上的运行时，然后：
kubectl uncordon <node>
```

## 诊断步骤

通过列出 DaemonSet 的 Pod 并从状态列中读取等待原因来确认故障是节点范围的——健康节点上的 Pod 状态为 `Running`，而受影响节点上的 Pod 保持在等待状态，如 `ImagePullBackOff` 或 `ErrImagePull`：

```bash
kubectl get pods -n <namespace> -o wide -l <daemonset-selector>
```

从使用 `kubectl debug node/<node>` 打开的节点 shell 中，验证运行时是否可达，然后再尝试任何清理；如果 `crictl` 命令因套接字错误而失败，则 containerd 守护进程已关闭，必须先恢复，因为每个 `crictl` 操作都依赖于该 CRI 套接字处于活动状态。一旦 `crictl` 有响应，`crictl rmi --prune` 是最不具侵入性的下一步，优于任何磁盘删除。

如果节点必须停用以进行运行时修复，请运行 `kubectl drain --ignore-daemonsets --delete-emptydir-data <node>`，并在处理运行时之前等待驱逐完成——仅驱逐（没有标志）将因节点上的 DaemonSet 管理的 Pod 而拒绝启动。修复后，`kubectl uncordon <node>` 将节点切换回可调度状态，以便调度器恢复在其上放置 Pod。

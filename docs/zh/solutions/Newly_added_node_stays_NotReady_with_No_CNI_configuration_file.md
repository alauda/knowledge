---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: 9b774da931bed425de5fe9a0bfe2b070404c6a8454e0f02844b5260f654c7100
---

## 问题

一个新的工作节点被添加到集群中，但该节点从 `NotReady` 状态永远无法转换为 `Ready`。受影响节点上的 kubelet 报告：

```text
container runtime network not ready: NetworkReady=false
reason: NetworkPluginNotReady
message: Network plugin returns error: No CNI configuration file in /etc/cni/net.d/
```

应该在新节点上写入 CNI 配置的网络层 DaemonSet Pods — `kube-ovn-cni`、`kube-multus-ds` 和 `ovs-ovn` — 从未到达该节点，或者到达后未能与 OVN 控制平面注册。因此 `/etc/cni/net.d/` 保持为空，kubelet 拒绝接纳任何工作负载，`kubectl describe node <new-node>` 显示匹配的条件：

```text
Conditions:
  Type             Status  Reason                       Message
  Ready            False   KubeletNotReady              container runtime network not ready: …
  NetworkUnavailable  True  NoRouteCreated              … (仅在某些安装程序上)
```

如果 OVN 控制平面是瓶颈，`kube-system` 中的 Pod 列表显示现有节点上健康的 `kube-ovn-cni` Pods，但新节点上缺少或处于 `Pending` 状态，而 `kube-ovn-controller` 和 `ovn-central` 表面上看起来健康，但它们的日志报告过时的领导者 / 数据库连接问题。

## 根本原因

每个节点的 CNI 智能体 (`kube-ovn-cni`) 不能写入 `/etc/cni/net.d/01-kube-ovn.conflist`，直到它从 `kube-ovn-controller` 获取节点的逻辑端口配置，而后者又从 `ovn-central` 托管的 OVN 北向和南向数据库读取。当控制平面处于过时状态时 — 通常是在之前的 `ovn-central` 领导者崩溃、与 NBDB/SBDB 失去联系，或 `kube-ovn-controller` 在 apiserver 上的监视不同步后 — 控制器停止为新添加的节点提供服务，即使现有节点继续工作。

从新节点的角度来看，症状很简单：CNI 节点 Pod 启动，向控制器请求其节点配置，但从未收到响应，因此从未写入 CNI conflist。kubelet 没有看到 CNI 配置，因此每个 Pod（包括后续重启时的网络 DaemonSets 自身）都无法调度，显示 `NetworkPluginNotReady`。

重启控制平面部署（`kube-ovn-controller` 和（如有必要）`ovn-central`）会刷新 apiserver 监视和 OVN 数据库连接，并让控制器处理待处理的节点注册。

## 解决方案

模式是：确认每个节点的 CNI Pod 是直接故障，滚动 `kube-system` 中的 OVN 控制平面，然后验证新节点变为 Ready。下面的 Pod 和 Deployment 名称是 ACP 默认值（Kube-OVN 在 `kube-system` 中）；自定义安装可能使用不同的命名空间，但工作负载名称是稳定的。

1. **确认每个节点的 CNI 智能体状态。**

   ```bash
   kubectl -n kube-system get pod -l app=kube-ovn-cni -o wide
   ```

   现有节点显示每个节点一个 Ready 的 `kube-ovn-cni-<hash>` Pod；新节点要么尚未有 Pod（DaemonSet 尚未调度到那里，因为节点是 `NotReady`），要么有一个卡在 `ContainerCreating` / `CrashLoopBackOff` 状态的 Pod。

2. **检查控制器日志以获取节点注册失败的信息。**

   ```bash
   kubectl -n kube-system logs deploy/kube-ovn-controller --tail=200 \
     | grep -E '<new-node>|register|node-port|allocate' | tail -40
   ```

   查找重复的行，如 `failed to register node <new-node>` 或 `timeout waiting for OVN NB`。这两者中的任何一个都确认控制平面是瓶颈，而不是节点本身。

3. **滚动 Kube-OVN 控制器。**

   使用滚动重启 — 它保留 Deployment 的 PDB，并且不会让集群没有 OVN 控制器：

   ```bash
   kubectl -n kube-system rollout restart deployment/kube-ovn-controller
   kubectl -n kube-system rollout status  deployment/kube-ovn-controller --timeout=5m
   ```

   如果控制器的滚动本身停滞（新 Pods 启动但记录相同的数据库错误），还需滚动 `ovn-central`，它托管 NB/SB 数据库：

   ```bash
   kubectl -n kube-system rollout restart deployment/ovn-central
   kubectl -n kube-system rollout status  deployment/ovn-central --timeout=5m
   ```

   `ovn-central` 作为一个 3 副本的 Deployment 运行，具有领导者选举；只要在任何时刻有法定人数存活，滚动它是安全的，`rollout restart` 会强制执行这一点。

4. **观察新节点注册。**

   在几分钟内，每个节点的 CNI Pod 应该完成其注册，写入 CNI conflist，kubelet 应该接收它：

   ```bash
   kubectl -n kube-system get pod -l app=kube-ovn-cni -o wide | grep <new-node>
   kubectl get nodes <new-node>
   ```

   节点变为 `Ready`，`kube-multus-ds` 和 `ovs-ovn` 在其上调度，且在该节点上新创建的 Pods 从它们被分配的 OVN 子网获取 IP。

如果滚动控制平面没有解决问题，OVN 数据库本身可能已损坏或无法访问。这是一个单独的故障排除路径 — 在尝试任何集群范围的操作之前，通过 `ovn-nbctl`/`ovn-sbctl` 检查 `ovn-central` Pod 内的 NB/SB 领导者。

## 诊断步骤

检查节点和关键的 Deployment / DaemonSet 状态：

```bash
kubectl get nodes | grep -i notready
kubectl -n kube-system get deploy/kube-ovn-controller deploy/ovn-central
kubectl -n kube-system get ds/kube-ovn-cni ds/ovs-ovn ds/kube-multus-ds
```

检查 NotReady 节点的条件：

```bash
kubectl describe node <new-node> | sed -n '/Conditions:/,/Addresses:/p'
```

查找受影响节点上处于 `Pending`/`ContainerCreating` 状态的网络 Pods：

```bash
kubectl get pod -A -o wide | grep -E "<new-node>.*(Pending|ContainerCreating)"
```

从节点本身确认 `/etc/cni/net.d/` 为空（证明 CNI conflist 从未写入，而不是损坏）：

```bash
kubectl debug node/<new-node> -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host ls -la /etc/cni/net.d/
```

在节点上采样 kubelet 日志以获取重复的 "No CNI configuration file" 错误：

```bash
kubectl debug node/<new-node> -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host journalctl -u kubelet --no-pager | tail -100 \
  | grep -E "NetworkPluginNotReady|No CNI configuration file"
```

在解决步骤后，预计节点将在几分钟内转换为 `Ready`，并且该节点上的新 Pods 将从它们被分配的 OVN 子网获取 IP。

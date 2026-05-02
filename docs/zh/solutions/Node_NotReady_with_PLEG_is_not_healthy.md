---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: 5bfbca2a048988b52f198676dc7be6c96fba5157901f961893fcbba80cab8f98
---

## 问题

一个或多个集群节点变为 `NotReady`，且 kubelet 状态日志报告类似于以下错误：

```text
容器运行时已关闭，PLEG 状态不健康：最后一次活动的 PLEG ...
```

受影响节点上的工作负载停止接收生命周期更新，新 Pod 无法在该节点上调度，如果这种情况持续，控制器管理器将开始将 Pod 驱逐出该节点。节点通常在 kubelet 重启后短暂恢复，然后几分钟后再次变为 `NotReady`。

## 根本原因

Pod 生命周期事件生成器（PLEG）是 kubelet 内部的一个组件，它定期向容器运行时请求容器列表及其状态。每次迭代称为“重新列出”。如果 kubelet 在 PLEG 健康窗口（3 分钟）内无法完成完整的重新列出，它将标记节点为 `NotReady`，并显示 `PLEG is not healthy` 的 CRI 级别错误。

根本原因可以归纳为四个方面：

- **容器运行时延迟或挂起。** CRI 端点响应缓慢，卡在死锁的 goroutine 上，或被昂贵的操作（例如，删除非常大的容器根文件系统）序列化。每次重新列出都在其后排队，导致 PLEG 超时。
- **Pod 密度过高，超出重新列出窗口。** PLEG 的开销与节点上的容器数量成正比，而不是与主机的 CPU / 内存预算成正比。一个运行 1000 个容器的 96 核主机仍然需要在每次重新列出时遍历每个容器，并且在一个有 50 个容器的小型主机之前就会错过截止时间。
- **在获取 Pod 状态时的 CNI 问题。** 获取 Pod 网络状态是重新列出路径的一部分；一个挂起的 CNI 调用（网络插件无响应，`cni-bin` 缺少二进制文件，网络策略控制器卡住）会像运行时挂起一样阻塞 PLEG。
- **kubelet 自身的资源匮乏。** 没有请求/限制的容器使节点 CPU 资源匮乏，内存压力导致 kubelet 辅助程序的 OOM 杀死，或热 I/O 循环使容器运行时进程的系统调用吞吐量匮乏——所有这些在 PLEG 边界上都会显现，因为这是 kubelet 首次错过截止时间的地方。

## 解决方案

立即的恢复措施是对节点进行隔离和排空，重启运行时和 kubelet，并清理死掉的容器和悬挂的镜像，这些都会给每次重新列出带来不必要的开销。然后解决适用的根本原因。

步骤 1 — 排空节点，以便工作负载能够干净地迁移：

```bash
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
```

步骤 2 — 在节点主机上，重启运行时和 kubelet。使用 `kubectl debug node/<node-name>` 获取一个特权 shell 进入一个绑定了 `/host` 的调试容器，然后 `chroot /host` 在主机文件系统和服务上操作：

```bash
kubectl debug node/<node-name> --image=busybox:1.36 -it -- chroot /host \
  sh -c 'systemctl restart crio && systemctl restart kubelet'
```

步骤 3 — 清除已退出的容器和未标记的镜像。这些在工作负载更替中会在节点上累积，并在每次重新列出时增加开销：

```bash
kubectl debug node/<node-name> --image=busybox:1.36 -it -- chroot /host \
  sh -c '
    crictl ps -a | awk "/Exited/ {print \$1}" | xargs -r crictl rm
    crictl images | awk "/<none>/ {print \$3}" | xargs -r crictl rmi
  '
```

步骤 4 — 解除节点隔离：

```bash
kubectl uncordon <node-name>
```

如果在此清理后 PLEG 仍然复发，则是结构性原因之一，修复不在节点本身：

- **在每个工作负载上设置 `resources.requests` 和 `resources.limits`。** 无限制的 Pod 在负载下常常使 kubelet 资源匮乏。从在事件窗口期间通过 `kubectl top pod --sort-by=cpu` 和 `--sort-by=memory` 确定的罪魁祸首开始。
- **限制 Pod 密度** 在每个节点超过大约 250 个 Pod 的主机上。kubelet 的 `maxPods` 默认值为 110；高于该值是支持的，但 PLEG 的预算会迅速收紧，尤其是在有许多短生命周期容器的情况下。降低受影响池的节点配置中的 `maxPods`，或进行横向扩展。
- **检查 CNI 健康状况。** ACP 上的集群 CNI 是 Kube-OVN。在 PLEG 错误发生的同一窗口内，观察 Kube-OVN 控制器和守护进程 Pod 是否存在重启循环或卡住的调解：

  ```bash
  kubectl -n kube-system get pod -l app=kube-ovn-cni -o wide
  kubectl -n kube-system logs ds/kube-ovn-cni --since=30m | grep -iE 'timeout|deadline|reconcile'
  ```

  在获取 Pod 状态期间 CNI 内部的挂起会在 kubelet 端表现为 PLEG 症状，尽管根本原因在网络栈中。
- **如果已知的死锁在上游已被修复，则升级运行时。** 节点配置表面（`configure/clusters/nodes`，或 **不可变基础设施** 扩展）是运行时版本被固定的地方；从那里提升运行时是一个声明式的滚动更改，而不是每个节点的 yum 事务。

## 诊断步骤

确认 PLEG 是节点报告的实际状态（而不是通用的 `KubeletNotReady`）：

```bash
kubectl describe node <node-name> | sed -n '/Conditions/,/Addresses/p'
```

查看 kubelet 日志，了解转变为 `NotReady` 时哪个 CRI 调用在 PLEG 超时时仍未完成：

```bash
kubectl debug node/<node-name> --image=busybox:1.36 -it -- chroot /host \
  journalctl -u kubelet --since='30 min ago' \
    | grep -iE 'pleg|relist|container runtime'
```

查看同一时间段内的容器运行时日志——运行时侧的死锁或异常长的系统调用通常会在此处显示为匹配的停滞：

```bash
kubectl debug node/<node-name> --image=busybox:1.36 -it -- chroot /host \
  journalctl -u crio --since='30 min ago' | tail -200
```

计算节点上的容器数量以排除密度问题：

```bash
kubectl debug node/<node-name> --image=busybox:1.36 -it -- chroot /host crictl ps -a | wc -l
```

常规超过 300 个活动容器加上尚未回收的已退出容器的节点处于 PLEG 的危险区。

快速检查未使用的资源，这些资源会增加重新列出的成本：

```bash
kubectl debug node/<node-name> --image=busybox:1.36 -it -- chroot /host \
  sh -c 'crictl ps -a | grep -i Exited | wc -l; crictl images | grep -c "<none>"'
```

如果任一项的数量很大，则表明垃圾回收未能跟上——该节点池的定期 kubelet 容器和镜像 GC 设置可能需要收紧。

从容量角度来看，将节点级 Pod 数量与事件期间的集群范围内的 top Pod 配对：

```bash
kubectl top node
kubectl top pod -A --sort-by=cpu | head -20
kubectl top pod -A --sort-by=memory | head -20
```

如果顶级消费者始终是同一节点上未限制的工作负载，并且该节点出现 PLEG，则修复措施是请求/限制（以及 Pod 反亲和性以分散副本），而不是运行时方面的任何内容。

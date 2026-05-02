---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500038
sourceSHA: 3601a61badb74f1bf6cf76b0abc8cf772baff97b1d431bbe89e1408608dae109
---

# 节点 NotReady，提示 "PLEG is not healthy"

## 问题

一个或多个集群节点变为 `NotReady`，且 kubelet 状态日志报告类似以下错误：

```text
container runtime is down, PLEG is not healthy: pleg was last seen active ...
```

受影响节点上的工作负载停止接收生命周期更新，新 Pods 无法在该节点上调度，如果这种情况持续，控制器管理器将开始将 Pods 驱逐出该节点。节点通常在 kubelet 重启后短暂恢复，然后几分钟后再次出现问题。

## 根本原因

Pod 生命周期事件生成器 (PLEG) 是 kubelet 内部的一个组件，它定期向容器运行时请求容器列表及其状态。每次迭代称为一次 "relist"。如果 kubelet 无法在 PLEG 健康窗口（3 分钟）内完成完整的 relist，它将标记节点为 `NotReady`，并显示 `PLEG is not healthy` 的 CRI 级别错误。

潜在的根本原因可以归纳为四个方面：

- **容器运行时延迟或挂起。** CRI 端点响应缓慢，卡在死锁的 goroutine 上，或因昂贵操作（例如，删除非常大的容器根文件系统）而被串行化。每次 relist 都排队在其后，导致 PLEG 超时。
- **Pod 密度过高，超出 relist 窗口。** PLEG 的成本与节点上的容器数量成正比，而不是与主机的 CPU / 内存预算成正比。一个 96 核的主机运行 1,000 个容器时，仍然需要在每次 relist 时遍历每一个容器，并且在较小的主机上有 50 个容器时会更早错过截止时间。
- **在获取 Pod 状态时的 CNI 问题。** 获取 Pod 网络状态是 relist 路径的一部分；一个挂起的 CNI 调用（网络插件无响应，`cni-bin` 缺少二进制文件，网络策略控制器卡住）会以与运行时挂起相同的方式阻塞 PLEG。
- **kubelet 自身的资源匮乏。** 没有请求/限制的容器使节点 CPU 资源匮乏，内存压力导致 kubelet 辅助程序的 OOM 杀死，或热 I/O 循环使容器运行时进程的系统调用吞吐量匮乏——所有这些都在 PLEG 边界上显现，因为这是 kubelet 首次错过截止时间的地方。

## 解决方案

立即的恢复措施是对节点进行隔离和排空，重启运行时和 kubelet，并清理死掉的容器和悬挂的镜像，这些都会给每次 relist 增加不必要的成本。然后解决适用的根本原因。

步骤 1 — 排空节点，以便工作负载能够干净地迁移：

```bash
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
```

步骤 2 — 在节点主机上，重启运行时和 kubelet。ACP 的集群 PSA 拒绝 `chroot /host`；请改用 `kubectl debug node` 并使用 `--profile=sysadmin`（这会挂载主机的 systemd 套接字和 PID 命名空间）以及一个包含 `systemctl` 的镜像。`busybox` 镜像缺少 `systemctl`：

```bash
kubectl debug node/<node-name> --image=<image-with-systemd> --profile=sysadmin -it -- \
  sh -c 'systemctl restart crio && systemctl restart kubelet'
```

步骤 3 — 清除已退出的容器和未标记的镜像。这些在工作负载更替过程中会在节点上累积，并且会增加每次 relist 的开销。镜像必须包含 `crictl`：

```bash
kubectl debug node/<node-name> --image=<image-with-crictl> --profile=sysadmin -it -- \
  sh -c '
    crictl ps -a | awk "/Exited/ {print \$1}" | xargs -r crictl rm
    crictl images | awk "/<none>/ {print \$3}" | xargs -r crictl rmi
  '
```

步骤 4 — 解除节点的隔离：

```bash
kubectl uncordon <node-name>
```

如果在此清理后 PLEG 仍然复发，那么它是结构性原因之一，修复不在节点本身：

- **在每个工作负载上设置 `resources.requests` 和 `resources.limits`。** 无限制的 Pods 在负载下会定期使 kubelet 资源匮乏。首先从通过 `kubectl top pod --sort-by=cpu` 和 `--sort-by=memory` 在事件窗口中识别的罪魁祸首开始。
- **限制 Pod 密度** 在每个节点超过大约 250 个 Pods 的主机上。kubelet 的 `maxPods` 默认值为 110；支持高于该值的设置，但 PLEG 预算会迅速收紧，尤其是在有许多短生命周期容器的情况下。降低受影响池的节点配置中的 `maxPods`，或进行横向扩展。
- **检查 CNI 健康。** ACP 上的集群 CNI 是 Kube-OVN。在 PLEG 错误发生的同一时间窗口内，观察 Kube-OVN 控制器和守护进程 Pods 是否存在重启循环或卡住的调和：

  ```bash
  kubectl -n kube-system get pod -l app=kube-ovn-cni -o wide
  kubectl -n kube-system logs ds/kube-ovn-cni --since=30m | grep -iE 'timeout|deadline|reconcile'
  ```

  在获取 Pod 状态时 CNI 内部的挂起会在 kubelet 端表现为 PLEG 症状，尽管根本原因在网络栈中。
- **如果已知的死锁在上游已被修复，则升级运行时。** 节点配置表面（`configure/clusters/nodes`，或 **Immutable Infrastructure** 扩展）是运行时版本被固定的地方；从那里提升运行时是一个声明式的滚动更改，而不是每个节点的 yum 事务。

## 诊断步骤

确认 PLEG 是节点实际报告的状态（而不是通用的 `KubeletNotReady`）：

```bash
kubectl describe node <node-name> | sed -n '/Conditions/,/Addresses/p'
```

查看 kubelet 日志，了解何时转变为 `NotReady`，以查看 PLEG 超时时哪个 CRI 调用未完成。`journalctl --root=/host` 通过 `/host` 绑定挂载读取主机的日志目录——无需 chroot：

```bash
kubectl debug node/<node-name> --image=<image-with-systemd> --profile=sysadmin -it -- \
  journalctl --root=/host -u kubelet --since='30 min ago' \
    | grep -iE 'pleg|relist|container runtime'
```

查看容器运行时日志，了解相同时间窗口内的情况——运行时侧的死锁或异常长的系统调用通常会在这里显示为匹配的停滞：

```bash
kubectl debug node/<node-name> --image=<image-with-systemd> --profile=sysadmin -it -- \
  journalctl --root=/host -u crio --since='30 min ago' | tail -200
```

计算节点上的容器数量，以排除密度问题。`crictl` 通过其 CRI 套接字与运行时通信，位于 `/run/crio/crio.sock`（或 `/run/containerd/containerd.sock`）；`--profile=sysadmin` 会挂载这些：

```bash
kubectl debug node/<node-name> --image=<image-with-crictl> --profile=sysadmin -it -- \
  crictl ps -a | wc -l
```

节点上常规超过 300 个活动容器加上尚未回收的已退出容器，处于 PLEG 的危险区。

快速检查未使用的资源，这些资源会增加 relist 成本：

```bash
kubectl debug node/<node-name> --image=<image-with-crictl> --profile=sysadmin -it -- \
  sh -c 'crictl ps -a | grep -i Exited | wc -l; crictl images | grep -c "<none>"'
```

如果任一项的数量较大，表明垃圾回收未能跟上——该节点池的周期性 kubelet 容器和镜像 GC 设置可能需要收紧。

从容量角度，结合节点级 Pod 数量与事件期间的集群级顶级 Pods：

```bash
kubectl top node
kubectl top pod -A --sort-by=cpu | head -20
kubectl top pod -A --sort-by=memory | head -20
```

如果顶级消费者始终是同一节点上无界限的工作负载，并且该节点出现 PLEG，则修复措施是请求/限制（以及 Pod 反亲和性以分散副本），而不是运行时侧的任何内容。

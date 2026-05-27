---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500214
sourceSHA: 4cfea8ac56b26025a3397be9c57a521e6dcb2ce7dc8b65684acf071e1216b147
---

# 执行探针导致的无效进程给工作节点带来压力

## 问题

在运行 Kubernetes v1.34.5 的 Alauda 容器平台工作节点上，当执行探针失败时，会不断生成短暂的辅助进程，这些进程未被容器的主进程回收，从而导致无效（僵尸）进程在节点进程表中累积。执行探针是该平台上一个活跃使用的接口——在工作负载集中，有八个 Pod 声明了 `livenessProbe.exec`，九个声明了 `readinessProbe.exec`，涵盖了 `argocd` redis-ha Pod、`kube-system` Kube-OVN 和 OVS Pod，以及 `kubevirt` CDI Pod，因此触发模式影响到实际的工作进程树。

这种累积与节点负载升高和受影响工作节点的响应能力下降相关。kubelet 的 `stats/summary` 端点暴露了系统容器的压力停滞信息，`cpu.psi` 报告了标准 `avg10` / `avg60` / `avg300` 窗口内的 `full` 和 `some` 平均值，以及 `memory.availableBytes`，这是 kubelet 原生接口，在高负载信号可见的同时，僵尸进程也在不断增加。

## 根本原因

无效条目是一个已退出的子进程，但其父进程尚未收集其退出状态，因此内核在进程表中保留一个精简的任务条目，直到回收发生。当执行探针在紧密的时间间隔内重新触发，而容器的主进程未能回收探针生成的子进程时，每次失败的探针迭代都会留下另一个无效条目，且计数会随着探针持续对一个无响应命令的触发而增长。探针生成的子进程位于容器的进程子树中，位于 kubelet 通过 CRI 驱动的容器监控/适配进程下；随着探针间隔的持续触发，存活的子树继续为同一父进程累积无效行。

由于每个僵尸占用一个 PID 表槽，并且 kubelet 忙于驱动探针和容器生命周期工作，因此随着计数的增长，每个节点的 PSI 计数器也在上升，这与 kubelet 系统容器的 `stats/summary` 中显示的相同 `cpu.psi` 信号一致。

## 解决方案

一旦识别出生成无效进程的 Pod，重启该 Pod，前提是工作负载可以容忍重启。`pods` 资源在该服务器上暴露了 `delete` 动词（`VERBS [create delete deletecollection get list patch update watch]`），因此只需执行一次 `kubectl delete pod` 即可——拥有者控制器会重新创建该 Pod，新的容器将以干净的进程表启动，无需特定于平台的原语。

```bash
# 识别出有问题的 Pod，然后删除它；控制器会重新创建它。
kubectl -n <namespace> delete pod <pod-name>

# 等待重新创建的 Pod 变为就绪状态，然后重新测量。
kubectl -n <namespace> wait --for=condition=Ready pod/<pod-name> --timeout=120s
```

如果在重启后同一工作负载仍然不断生成无效条目，则需要解决根本原因：修复应用程序，使其主进程回收其子进程，或修正失败的执行探针，以便停止重新生成从未被收集的命令。

## 诊断步骤

列出工作节点上的无效行，并从 `ps -elfL` 输出的第五个字段读取父 PID。ACP 工作节点运行 Ubuntu 22.04.1，内核为 5.15，procps-ng 的 `ps`，其 `ps -elfL` 头为 `F S UID PID PPID LWP C NLWP ...`，因此 PPID 列是每个工作节点的第五个字段——该 PPID 标识未能回收其子进程的父进程。

```bash
# 在工作节点上（通过 kubectl debug node），列出无效进程并读取 PPID（第5个字段）。
kubectl debug node/<node-name> -- chroot /host ps -elfL | grep defunct

# 从该 PPID 遍历进程树以确认拥有者父进程。
kubectl debug node/<node-name> -- chroot /host pstree -lp <ppid>
```

使用 `pstree -lp` 从 PPID 遍历树，以确认哪个容器子树拥有该父进程——无效行位于容器监控/适配进程下，该进程锚定容器的进程层次结构，父进程是容器的主进程。

通过 kubelet `stats/summary` 端点监视受影响工作节点的高负载信号，该端点返回 `systemContainers[].cpu.psi`，其中包含 `full` 和 `some` 的 `avg10` / `avg60` / `avg300` 值，以及 `memory.availableBytes`，因此可以在无效计数持续上升的同时跟踪 PSI 平均值。

```bash
# 通过 apiserver 代理从 kubelet stats/summary 端点读取 PSI。
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/stats/summary"
```

如果在重启后计数仍在上升，则源工作负载仍然处于活动状态——触发接口仍然是声明执行探针的同一组 Pod（例如 `argocd` redis-ha、`kube-system` Kube-OVN / OVS 和 `kubevirt` CDI Pod），因此请重新检查这些探针是否在紧密循环中失败。

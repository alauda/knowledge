---
kind:
  - Information
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500042
sourceSHA: 727658269853721c43d2aa049d14db81a960f5e97fb317dba6452d31f182e873
---

# 阅读节点网络 Pod 内的 ovn-controller 线程模型

## 概述

`ovn-controller` 是每个节点的守护进程，它将全局 OVN 南向数据库转换为节点实际编程到 Open vSwitch 的本地 OpenFlow 规则。当操作员看到单个节点上的 `ovn-controller` 进程消耗 *几百个百分比的 CPU* 时，第一反应往往是认为存在泄漏；但实际上，通常是多个线程在并行执行合法工作，而进程级 CPU 视图将它们相加。

本说明解释了 `ovn-controller` 的线程模型，以便操作员能够正确读取 CPU 样本，并判断他们所看到的是稳定状态的工作、实际的热循环，还是产生可避免波动的配置形状。

## 解决方案

### ovn-controller 在 ACP (Kube-OVN) 中的运行位置

ACP 使用 **Kube-OVN** 作为其 CNI。与主机级 OVN 部署不同，`ovn-controller` **不** 作为进程在节点上运行——它运行在每个节点的网络 Pod 内。在该平台上的具体形态为：

| 组件                | 值                  |
| ------------------ | ------------------ |
| DaemonSet          | `kube-ovn-cni`     |
| 命名空间           | `kube-system`      |
| 容器               | `cni-server`       |
| Pod 标签选择器    | `app=kube-ovn-cni` |

本文中的每个诊断命令都通过 `kubectl exec` 进入该容器——`kubectl debug node` + `chroot /host` 将无法找到该进程，并被 ACP 的集群 Pod 安全入场政策拒绝。

选择要检查的节点的 Pod：

```bash
NODE=<node-name>
POD=$(kubectl -n kube-system get pod -l app=kube-ovn-cni \
        --field-selector=spec.nodeName=$NODE,status.phase=Running \
        -o jsonpath='{.items[0].metadata.name}')
echo $POD
```

### 线程

`ovn-controller` 是 **多线程** 设计的。这些线程共享相同的南向数据库视图，但专注于不同的工作类型：

| 线程 (top -H 名称)      | 角色                                                                                                              | 热信号                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **ovn-controller** (主)   | 处理南向数据库的变化；计算并安装本地桥上的 OpenFlow 流                                                       | CPU 与逻辑流波动相关（Pod 创建/删除、端口绑定、ACL 变化）                          |
| **ovn_pinctrl0**         | 处理被转发到用户空间的包（PACKET_IN），包括 ARP/NDP 响应和 DNS 拦截                                          | CPU 与用户空间包速率相关，通常在连接风暴期间激增                                   |
| **ovn_statctrl3**        | 刷新来自数据路径的 FDB（转发数据库）和 MAC 绑定条目                                                          | CPU 与 L2 邻居集的波动相关；在大型扁平网络中频繁通信                               |

当即使两个线程处于活跃状态时，综合的进程 CPU 视图轻松超过 100%；持续的 `300 %` 与同时安装流、处理转发包和刷新大型 MAC 绑定表的节点是一致的。这 *本身* 并不是异常。

### 当高 CPU 是真实症状时

线程模型应作为真实病理的过滤器：

- **主线程 (`ovn-controller`) 单独固定在高 CPU** 通常意味着本地节点重复计算相同的流——查找创建/删除 Pods 的控制平面热循环，或节点正在重新编译的波动 NetworkPolicy。
- **`ovn_pinctrl0` 单独固定** 指向一个不应在用户空间中的数据包路径——一个错误配置的负载均衡器正在进行发夹，或一个强制慢路径的损坏 ACL。
- **`ovn_statctrl3` 单独固定** 指向 MAC 绑定波动——一个频繁波动的端点或一个具有过多并发 ARP/NDP 条目的网络。

关键在于 *哪个* 线程是热的比绝对 CPU 数字更具诊断意义。

## 诊断步骤

读取实时每线程 CPU。`top -H` 列出线程，而不仅仅是进程；在 `cni-server` 容器内运行它：

```bash
NODE=<node-name>
POD=$(kubectl -n kube-system get pod -l app=kube-ovn-cni \
        --field-selector=spec.nodeName=$NODE,status.phase=Running \
        -o jsonpath='{.items[0].metadata.name}')

PID=$(kubectl -n kube-system exec $POD -c cni-server -- pgrep -x ovn-controller)
kubectl -n kube-system exec $POD -c cni-server -- top -H -b -n 1 -p $PID | head -n 40
```

`COMMAND` 列显示哪个线程占用了 CPU。

通过本地 `unixctl` 套接字采样 `ovn-controller` 自身的分析计数器——`ovn-appctl` 被打包在同一容器内并直接与守护进程通信：

```bash
kubectl -n kube-system exec $POD -c cni-server -- \
  ovn-appctl -t ovn-controller coverage/show
```

`coverage/show` 显示计数器，如 `flow_install`、`pinctrl_run` 和 `lflow_run`——每秒的增量直接转换为每个线程正在执行的工作量。低 `lflow_run` 速率结合高主线程 CPU 是重复无操作重新计算的标志。

检查南向数据库的波动。南向数据库由 **`ovn-central`** 部署托管（在 `kube-system` 下有 3 个副本）；从任何这些 Pods 查询它。`kube-ovn-cni` Pod *可以* 仅在恰好也托管 ovn-central 副本的节点上看到南向套接字（共享 `hostPath`），因此不要依赖于任意工作节点。

```bash
CENTRAL=$(kubectl -n kube-system get pod -l app=ovn-central \
            -o jsonpath='{.items[0].metadata.name}')

kubectl -n kube-system exec $CENTRAL -- \
  ovn-sbctl --no-leader-only \
    --columns=_uuid,logical_port,external_ids list Port_Binding | wc -l
```

`--no-leader-only` 是必需的，因为 ovn-central 作为 3 副本 Raft 集群运行——没有它，`ovn-sbctl` 可能拒绝查询跟随者。在 OVN 南向模式中，`Port_Binding` 表使用 `logical_port`，而不是 `name`。

一个持续增长的端口绑定计数而没有相应的工作负载增加，通常指向集群中的控制器泄漏（Pods 未从南向数据库中被垃圾回收）——将其反馈给网络操作团队，而不是将其视为节点本地问题。

为了获取更深入的跟踪，短暂地将 `ovn-controller` 重定向到详细日志，并捕获 30 秒的窗口：

```bash
kubectl -n kube-system exec $POD -c cni-server -- \
  ovn-appctl -t ovn-controller vlog/set ANY:console:dbg
sleep 30
kubectl -n kube-system exec $POD -c cni-server -- \
  ovn-appctl -t ovn-controller vlog/set ANY:console:info
```

详细日志增长迅速——保持窗口短暂，不要将级别保持在 `dbg`。

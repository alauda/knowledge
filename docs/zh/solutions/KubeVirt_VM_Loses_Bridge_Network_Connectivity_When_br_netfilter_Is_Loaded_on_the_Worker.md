---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500818
sourceSHA: bd5644f5040787adf3fb5d7de60729dcfa715e880673f4d5d624f43a1c3ffb27
---

# KubeVirt 虚拟机在加载 br_netfilter 时失去桥接网络连接

## 问题

在 Alauda 容器平台（Kubernetes v1.34.5，使用 Ubuntu 22.04 的工作节点，运行 Linux 5.15.0-56-generic）上，KubeVirt 虚拟机通过 Multus `NetworkAttachmentDefinition` 附加到 Linux Bridge 次要网络时，经历了周期性或永久的网络连接丢失。进入流量如 ICMP 到达工作节点的物理绑定或接口，但从未出现在虚拟机的 veth 接口上，而来自虚拟机的出口流量如 ARP 到达桥接，但未通过桥接端口转发。涉及的数据路径是 ACP 上标准的 KubeVirt 次要网络形状：一个 `NetworkAttachmentDefinition`（`network-attachment-definitions.k8s.cni.cncf.io`，`k8s.cni.cncf.io/v1`）的 CNI `type: bridge`，通过 `virtualmachineinstance.spec.networks[].multus.networkName` 引用，并在虚拟机端通过 `virtualmachineinstance.spec.domain.devices.interfaces[].bridge` 绑定（`InterfaceBridge 通过 Linux 桥接连接到给定网络`），KubeVirt 在命名空间 `kubevirt` 中运行，`virt-handler` 作为 `3rdparty/kubevirt/virt-handler:v1.7.0-alauda.2` 提供。

## 根本原因

触发因素是加载在托管虚拟机的工作节点上的 `br_netfilter` Linux 内核模块。在运行 Ubuntu 22.04 + Linux 5.15.0-56-generic 内核的 ACP 工作节点上，加载 `br_netfilter` 会在 `/proc/sys/net/bridge/` 下注册三个 sysctl，并将每个值设置为 1；在 ACP 工作节点上进行特权探测显示实时值 `net.bridge.bridge-nf-call-arptables = 1`，`net.bridge.bridge-nf-call-ip6tables = 1`，和 `net.bridge.bridge-nf-call-iptables = 1`，正如模块文档所述。

当相应的 `bridge-nf-call-*` sysctl 为 1 时，穿过 Linux 桥接的帧会被推送到主机的 `iptables`、`ip6tables` 和 `arptables` 链进行过滤决策，而不是仅在第 2 层进行切换——通过桥接帧的 iptables 钩子被限制的内核 sysctl 载体是工作节点上观察到的相同 `/proc/sys/net/bridge/` 键集。KubeVirt 不会安装主机端的 `iptables` 允许规则来白名单次要桥接虚拟机流量：`virt-handler` 和 `virt-launcher`（镜像 `3rdparty/kubevirt/virt-handler:v1.7.0-alauda.2`）仅将虚拟机的 tap 连接到由上游 `bridge` CNI 委托创建的现有 Linux 桥接。由于 `bridge-nf-call-*` sysctls 强制桥接帧通过 iptables，因此虚拟机的桥接流量受到主机的 iptables 策略的影响——在一个 Kubernetes 集群中，其 pod 网络代理拥有自己的 FORWARD 链规则，默认情况下，非相关的桥接帧会被静默丢弃。

内核级的耦合产生了症状：在加载 `br_netfilter` 且 `bridge-nf-call-*` = 1 的工作节点上，加上一个通过 Linux Bridge `NetworkAttachmentDefinition` 桥接的 KubeVirt 虚拟机，以及缺乏任何显式的 iptables 允许该流量的情况。到达物理 NIC 的进入 ICMP 穿过桥接，交给 iptables，并在到达虚拟机的 veth/tap 之前被丢弃；来自虚拟机的出口 ARP 穿过桥接端口，交给 arptables，并从未通过物理 NIC 离开。

## 诊断步骤

确认 `br_netfilter` 是否当前加载在托管受影响虚拟机的工作节点上，并读取桥接 sysctl 的实时值。打开一个特权调试 pod 针对该节点，直接检查内核模块状态和 `/proc/sys/net/bridge/`；在经过测试的 ACP 工作节点上，这返回 `br_netfilter` 加载以及依赖的 `bridge` 模块，所有三个 `bridge-nf-call-*` sysctl = 1，以及 `/proc/sys/net/bridge/` 下的相应文件：

```bash
kubectl debug node/<worker> -it=false \
  --image=registry.alauda.cn:60080/acp/container-debug:v4.3.2 \
  --profile=sysadmin -- \
  chroot /host bash -c \
    "lsmod | grep -E 'br_netfilter|bridge' ; \
     echo --- ; \
     sysctl -a 2>/dev/null | grep bridge-nf-call ; \
     echo --- ; \
     ls /proc/sys/net/bridge/"
```

`lsmod` 行报告模块的名称、大小和引用计数；第三列非零表示某个 pod 内的进程正在持有桥接子系统，模块无法卸载，直到该进程退出。`sysctl -a | grep bridge-nf-call` 行打印 `= 1` 确认内核处于将桥接虚拟机帧提交给主机的 iptables 链的状态，这正是文章中静默丢弃症状发生的状态。

直接检查模块的引用计数和持有者，以查看是否有任何东西当前保持其加载。`refcnt` 为 `0` 和空的 `holders/` 目录意味着模块已加载但未被引用，因此卸载调用将成功；非零的 `refcnt` 表明某个内核子系统（通常是运行在特权 pod 内的容器运行时）正在阻止卸载：

```bash
kubectl debug node/<worker> -it=false \
  --image=registry.alauda.cn:60080/acp/container-debug:v4.3.2 \
  --profile=sysadmin -- \
  chroot /host bash -c \
    "cat /sys/module/br_netfilter/refcnt ; \
     ls -la /sys/module/br_netfilter/holders/"
```

检查集群中可能在受影响工作节点上加载 `br_netfilter` 的特权工作负载。典型模式是运行其自身容器守护进程的特权 pod（例如，具有嵌入式服务容器守护进程的自托管 CI 运行器）；通过 `nodeName` 确认 pod 的放置，并通过 `spec.containers[*].securityContext.privileged` 确认 pod 的特权，然后将其视为加载者：

```bash
kubectl get pods -A -o json \
  | jq -r '.items[] | select(.spec.containers[]?.securityContext.privileged==true)
      | "\(.metadata.namespace)/\(.metadata.name)\t\(.spec.nodeName)"'
```

## 解决方案

通过移除加载 `br_netfilter` 的工作负载、在工作节点上卸载该模块，并验证桥接 sysctl 不再处于活动状态来恢复虚拟机连接。每个步骤都是针对每个工作节点，因为 `br_netfilter` 是每个节点的内核状态——在每个托管有 KubeVirt 虚拟机的工作节点上重复该操作步骤，该虚拟机具有 Linux Bridge `NetworkAttachmentDefinition` 附加。

停止持有桥接子系统的特权工作负载——在诊断步骤中识别出的工作负载，其 `nodeName` 是受影响的工作节点，并且其容器是特权的。下一段中的内核卸载步骤仅在持有者进程退出并且模块的引用计数降至 0 时成功：

```bash
kubectl delete pod -n <ns> <runner-pod>
```

通过从特权调试 pod 中调用 `modprobe -r` 来卸载工作节点上的 `br_netfilter`。仅当模块的引用计数为 0 时，卸载返回 0；如果返回 `EBUSY`，请返回到上一步，确保节点上没有特权 pod 仍在持有桥接子系统：

```bash
kubectl debug node/<worker> -it=false \
  --image=registry.alauda.cn:60080/acp/container-debug:v4.3.2 \
  --profile=sysadmin -- \
  chroot /host modprobe -r br_netfilter
```

验证 `bridge-nf-call-*` sysctl 不再为 1。在卸载 `br_netfilter` 后，诊断步骤中使用的相同探测应报告 `/proc/sys/net/bridge/` 中缺少三个 `bridge-nf-call-*` 键（或者在某些配置中，存在且值为 0）；目标是没有键报告值为 1，这就是内核在桥接虚拟机帧不再被推送到主机 iptables 时的状态：

```bash
kubectl debug node/<worker> -it=false \
  --image=registry.alauda.cn:60080/acp/container-debug:v4.3.2 \
  --profile=sysadmin -- \
  chroot /host bash -c \
    "sysctl -a 2>/dev/null | grep net.bridge.bridge-nf-call ; \
     ls /proc/sys/net/bridge/ 2>&1"
```

一旦 sysctl 不再为 1，KubeVirt 虚拟机的 Linux Bridge 附加通过与文章描述的相同上游数据路径（`NetworkAttachmentDefinition` → `bridge` CNI 委托 → 主机 Linux 桥接 → 桥接端口 → 通过 `virtualmachineinstance.spec.domain.devices.interfaces[].bridge` 绑定的虚拟机 tap/veth）恢复连接——没有平台级的绑定更改，只有内核级的过滤切换。

---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500527
sourceSHA: f8a8332d7afa32315e6564b69e1cd80809e91c466faf675e393ea27b912a66eb
---

# 重启 OVN/OVS 容器不会重新加载 ACP 上主机 NIC 配置更改

## 问题

在 Alauda 容器平台上，OVS 和 OVN 用户空间运行在 `kube-system` 命名空间中的 `ovs-ovn` DaemonSet 内。每个节点托管一个 Pod（标签为 `app=ovs`），其单个 `openvswitch` 容器（镜像为 `registry.alauda.cn:60080/acp/kube-ovn:v1.15.10`）从 `/kube-ovn/start-ovs.sh` 入口点启动 `ovsdb-server`、`ovs-vswitchd` 和 `ovn-controller`；该 Pod 以 `hostNetwork=true` 和 `hostPID=true` 运行，以便共享主机网络命名空间。主机的网络管理器因节点操作系统而异；在参考集群中，所有四个节点均运行 Ubuntu 22.04.1 LTS，内核为 `5.15.0-56-generic`，主机 NIC、bond 和 VLAN 配置由节点操作系统网络栈管理（在 Ubuntu 中，默认由 `netplan` 驱动的 `systemd-networkd` 管理）。`ovs-ovn` Pod 仅在主机已启动这些接口后才会附加到这些接口。

在节点上应用主机级网络更改后（例如编辑 bond、VLAN 子接口或 MTU），重启 `ovs-ovn` Pod 或其组成进程不会将新配置传播到活动的主机接口——数据平面容器在重启时不会重新读取或重新应用主机级接口状态，因此主机网络更改不会通过 CNI 重启传播。

## 根本原因

`ovs-ovn` Pod 内的 OVS 数据平面和 OVN 南向控制器不负责或管理主机级 NIC、bond 或 VLAN 配置；它们使用节点操作系统网络管理器已创建的主机接口。由于主机网络所有者是与 CNI 数据平面分开的子系统，仅重启 CNI 用户空间——通过滚动 `ovs-ovn` DaemonSet 或删除 Pod——将保持主机接口状态不变，并重新附加到节点操作系统当前暴露的内容。任何节点操作系统系列都遵循相同的关注点分离，只有主机端配置工具发生变化；在参考集群中，主机所有者是 `systemd-networkd` 加上 `netplan`（Ubuntu 22.04.1 LTS）。

## 解决方案

通过每个受影响节点上的节点操作系统网络管理器应用主机网络更改，而不是通过 CNI Pod。在参考的 Ubuntu 22.04.1 LTS 节点上，这意味着编辑 `/etc/netplan/` 下的相关文件并通过 `netplan apply` 重新加载；主机所有者重新创建或重新配置接口，然后 `ovs-ovn` Pod 的 `openvswitch` 容器通过共享的主机网络命名空间看到更新的接口状态。

对于大规模的 NIC、bond 或 VLAN 变更，计划进行节点重启——或以其他方式重启主机网络栈——作为使新的主机网络配置生效的标准方式。重启预计将完全重新初始化主机网络栈，并且在 ACP 上，也会重新创建 `ovs-ovn` Pod，以便 CNI 重新附加到新初始化的主机接口。

在 ACP 上的容器级重启操作（滚动 `ovs-ovn` DaemonSet 或删除其 Pod）仍然是解决 OVS/OVN 用户空间内部问题的有效恢复步骤，但不能替代重新应用主机网络状态，因为数据平面容器不拥有该状态。标准的重启步骤是：

```bash
kubectl -n kube-system rollout restart daemonset/ovs-ovn
kubectl -n kube-system rollout status daemonset/ovs-ovn
```

## 诊断步骤

确认集群中的 OVS/OVN 交付工具和镜像。`ovs-ovn` DaemonSet 位于 `kube-system` 中，每个节点运行一个 Pod，具有 `hostNetwork=true` 和 `hostPID=true`，并将 `ovsdb-server`、`ovs-vswitchd` 和 `ovn-controller` 打包在单个 `openvswitch` 容器中：

```bash
kubectl -n kube-system get daemonset ovs-ovn
kubectl -n kube-system get pods -l app=ovs -o wide
kubectl -n kube-system get daemonset ovs-ovn \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

识别每个节点的操作系统和活动的主机网络管理器。CNI 数据平面附加到该子系统拥有的接口，因此必须通过它进行任何更改：

```bash
kubectl get nodes -o wide
# 在目标节点（参考集群上的 Ubuntu 22.04.1 LTS，内核 5.15.0-56-generic）上：
#   ls /etc/netplan/
#   systemctl status systemd-networkd
```

在应用主机网络更改后，验证新状态是否在主机接口上可见，并且 `ovs-ovn` Pod 是否通过共享的主机网络命名空间观察到它。如果主机接口仍显示旧配置，则更改未在主机级别提交，重启 Pod 将无法修复：

```bash
# 检查主机端接口状态：
ip -d link show <iface>
ip addr show <iface>

# 检查 OVS 当前从 ovs-ovn Pod 内部看到的内容：
kubectl -n kube-system exec ds/ovs-ovn -c openvswitch -- ovs-vsctl show
```

如果更改涉及 bonds、VLAN 父接口或共享上行链路上的 MTU，请安排节点重启以完全重新初始化主机网络栈；节点返回后，DaemonSet 控制器会重新创建 `ovs-ovn` Pod，并重新附加到新初始化的接口。

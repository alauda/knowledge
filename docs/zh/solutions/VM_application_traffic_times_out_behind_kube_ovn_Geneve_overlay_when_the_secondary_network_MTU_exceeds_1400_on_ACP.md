---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500863
sourceSHA: 86c3fb621f91b760e423c09bdd6bf0f55be2d7556fdbea3afb37cc4459b21012
---

# 当 ACP 上的二级网络 MTU 超过 1400 时，虚拟机应用程序流量在 kube-ovn Geneve 覆盖下超时

## 问题

在运行 `acp/kube-ovn:v1.15.11` 作为 CNI 和 KubeVirt (`kubevirt-kubevirt-hyperconverged` 部署在命名空间 `kubevirt` 的情况下，Alauda 容器平台 (kube `v1.34.5-1`)，一个工作负载在 pod 或 KubeVirt 虚拟机内部无法完成与外部端点的应用级连接，即使对同一地址的基本 `ping` 成功。在虚拟机/pod 接口上进行的 `tcpdump` 显示相同的 TLS 服务器 Hello / 证书段 (`Len=1448`) 被重复重传，最终跟随一个 `[RST]`，而小的 ICMP 回显和 ARP 流量仍在继续流动。

当工作负载绑定的接口的 MTU 大于覆盖可以承载的 MTU 时，症状就会出现——最常见的情况是 Multus `NetworkAttachmentDefinition` 在其嵌入的 CNI-JSON 中声明的 `mtu` 超过 kube-ovn Geneve 覆盖 MTU。

## 根本原因

ACP 的覆盖 CNI 是 `kube-ovn`，配置为使用 Geneve 封装端到端。每个节点上的 `kube-ovn-controller` 和 `kube-ovn-cni` DaemonSet 都以 `--network-type=geneve` 和 `--encap-checksum=true` 启动，pod 通过 `--pod-nic-type=veth-pair` 附加到 OVS `br-int`，Geneve 隧道在 `--iface=eth0` 上出口。

Geneve 为每个封装的数据包添加一个外部 L2 / IP / UDP / Geneve 头，因此覆盖可以传递的最大有效负载是节点的出口接口 MTU 减去该开销。在 ACP 上，这个差距是固定的 100 字节，因此在默认安装中，1500 字节的节点接口 MTU 下，kube-ovn pod/VM 的 eth0 MTU 为 1400。在这个集群上直接测量，在支持虚拟机的节点 `192.168.139.158` 上，节点 `eth0` 的 MTU 为 `1500`，该节点上的每个 kube-ovn veth 主机端 (`<id>_h`) 的 MTU 为 `1400`，而默认网络探测 pod 自身的 `eth0` 也报告 `mtu 1400`：

```text
# 来自节点上的 hostNetwork pod
/sys/class/net/eth0/mtu                  : 1500
/sys/class/net/04eccd882d72_h/mtu        : 1400
/sys/class/net/074693ea3c2d_h/mtu        : 1400
...  (23 个 kube-ovn veth 主机端均为 1400)
/sys/class/net/eth0/mtu                  : 1400
```

如果随后将一个二级接口附加到一个虚拟机或 pod，其 MTU 声明可以承载超过 1400 字节——例如，一个 Multus `NetworkAttachmentDefinition` 其 CNI-JSON 嵌入 `"mtu": 1500`，或者一个 `kubeovn.io/v1` 的 `Subnet` 其 `spec.mtu` 设置高于节点接口 MTU 减去 Geneve 开销——从客户机发出的全尺寸 IP 数据包无法被封装并在覆盖层被丢弃。小的 ICMP 回显仍然适合，这就是为什么 `ping` 成功，但全 MSS TCP 段（这里的有效载荷为 1448 字节，源自 SYN 宣布的 MSS）在出口时达到上限，接收方无限重传直到连接超时。

`kubeovn.io/v1` 的 `Subnet` CRD 直接暴露每个子网的覆盖：

```text
GROUP:      kubeovn.io
KIND:       Subnet
VERSION:    v1

FIELD: mtu <integer>
    子网的最大传输单元。
```

在默认的 ACP 安装中，该字段在 `ovn-default` (`10.3.0.0/16`) 和 `join` (`100.64.0.0/16`) 上均未设置，因此平台派生的 1400 生效——上面测量的值是数据路径使用的值，而不是配置选择。

当 Multus 也安装在集群上时，`network-attachment-definitions.k8s.cni.cncf.io/v1` CRD 提供了第二个控制点：其 `spec.config` 是一个 JSON 格式的 CNI 配置字符串，任何嵌入该 JSON 的 `mtu` 字段必须遵守相同的上限。

## 解决方案

ACP 上的覆盖 MTU 为 `节点接口 MTU − 100 B`，用于 Geneve。它不能独立提高——底层节点接口 MTU 必须首先提高，然后 kube-ovn 子网（以及任何匹配的 NAD）可以跟随。

如果失败的工作负载位于 kube-ovn 子网中，请将子网的 `spec.mtu` 降低到一个值 ≤ `(节点接口 MTU − 100)`，或将其保持未设置，以便 kube-ovn 派生默认值：

```bash
# 读取当前每个子网的覆盖（空 = 平台默认适用）
kubectl get subnet -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidrBlock,MTU:.spec.mtu,PROVIDER:.spec.provider'

# 移除自定义子网上的过大覆盖
kubectl patch subnet <subnet> --type=json \
  -p='[{"op":"remove","path":"/spec/mtu"}]'
```

如果失败的工作负载是具有 Multus 二级接口的 KubeVirt 虚拟机，请编辑 NAD 的 CNI-JSON `mtu`（在 `spec.config` 中），使其不超过覆盖上限，然后重启虚拟机（tap-backed 接口将根据新的 NAD MTU 重新创建）：

```bash
# 检查 NAD 的 CNI JSON
kubectl get net-attach-def <name> -n <ns> -o jsonpath='{.spec.config}{"\n"}'

# 修补嵌入的 mtu（示例：1500 -> 1400 在 1500 字节的底层上）
kubectl patch net-attach-def <name> -n <ns> --type=merge \
  -p '{"spec":{"config":"<new-cni-json-with-mtu-1400>"}}'

# 重启虚拟机，以便其 tap 在新的 MTU 下重新附加
virtctl restart <vm> -n <ns>   # 或：kubectl delete vmi <name>
```

如果确实需要更高的覆盖 MTU，请首先提高底层（提高每个节点上的 `eth0` MTU，在每个 L2 跳跃和上游交换机端口上），然后将 kube-ovn 子网上的 `Subnet.spec.mtu` 提高到新的上限，然后将任何 NAD `mtu` 提高以匹配。在没有其他层的情况下提高其中任何一层会从不同方向重现此确切症状。

## 诊断步骤

确认节点上的平台派生覆盖 MTU。从固定到支持虚拟机的节点的 hostNetwork pod，可以从 sysfs 中读取节点接口 MTU 和每个 kube-ovn veth 主机端 MTU，而无需直接接触节点。预期模式是节点 `eth0` 为 `1500`，每个 `<id>_h` 为 `1400`，在默认安装中：

```bash
kubectl run node-mtu-probe -n default --rm -i --restart=Never --overrides='
{"spec":{"hostNetwork":true,"nodeName":"<vm-node>"}}
' --image=registry.alauda.cn:60080/acp/kube-ovn:v1.15.11 \
  -- sh -c 'cat /sys/class/net/eth0/mtu; for i in /sys/class/net/*/mtu; do echo "$i: $(cat $i)"; done'
```

从任何默认网络 pod 内确认 pod 侧覆盖 MTU（工作负载的 eth0 将看到相同的值）。预期：在默认安装中为 `1400`：

```bash
kubectl run mtu-probe -n default --rm -i --restart=Never \
  --image=registry.alauda.cn:60080/acp/kube-ovn:v1.15.11 \
  -- sh -c 'cat /sys/class/net/eth0/mtu'
```

在失败的 pod 或虚拟机内部，读取接口 MTU，并通过设置不分片位进行数据包大小扫描，以找到连接中断的大小：

```bash
ip a
for s in 1000 1300 1400 1470 1580 1680 2080; do
  echo "测试大小 $s"
  ping -M do -c 2 -W 6 -s $s <external-ip>
done
```

一个成功的扫描，直到 `~1372` 字节（`1400 − 28` 用于 ICMP+IP 头）并从 `~1473` 开始失败，将中断点定位到 kube-ovn 1400 覆盖上限，而不是上游网络。结合上面节点侧和 pod 侧的读数，这足以将故障归因于三个层次之一的 MTU 配置错误——NAD CNI-JSON `mtu`、`Subnet.spec.mtu` 或节点接口 MTU——并指向需要降低的那个。

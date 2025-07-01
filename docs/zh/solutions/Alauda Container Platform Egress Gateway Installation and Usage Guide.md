---
id: KB250500026
products:
  - Alauda Container Platform
kind:
  - Solution
sourceSHA: e5151ecb6b1aed4a151fc4d42544e1301b55e9d7709df9cdf0b34d2348085aa8
---

# Alauda Container Platform 出口网关安装与使用指南

## 概述

Alauda Container Platform（ACP）提供了**出口网关**功能，旨在为您的应用程序提供**专用的外部公共 IP 地址**以用于出站流量。此功能集中控制您的应用程序如何发起与外部网络的连接，从而实现对出口策略的精确管理。与应用程序 Pod 使用动态的内部 IP 进行外部通信不同，出口网关确保所有出站流量均来自一个稳定的、可公开路由的 IP。这大大简化了网络安全配置和外部集成。

本文档描述了如何在 ACP 上部署和使用出口网关。

## 先决条件

1. 已安装 Alauda Container Platform。
2. 由 ACP 管理的 Kubernetes 集群。
3. 公共 IP 可用且可达。
4. 需要设置一些配置：
   - 对于 OpenStack 虚拟机环境，您需要关闭相应网络端口的 PortSecurity。
   - 对于 VMware vSwitch 网络，MAC 地址更改、伪造传输和混杂模式操作应设置为允许。
   - 对于 Hyper-V 虚拟化，VM NIC 高级功能中应启用 MAC 地址欺骗。
   - 公有云（如 AWS、GCE、阿里云等）不支持用户定义的 MAC。在这种情况下，建议使用相应公有云供应商提供的 VPC-CNI。

## 安装步骤

> 注意：本文档中提到的所有命令必须在您希望创建出口网关的集群的主节点上执行。

### 安装 Multus CNI

执行以下命令以安装 Multus CNI 插件：

```shell
# 可选环境变量
export KUBECONFIG="/etc/kubernetes/admin.conf"

# 安装 Multus CNI 插件
cat <<EOF | kubectl apply -f -
apiVersion: cluster.alauda.io/v1alpha1
kind: ClusterPluginInstance
metadata:
  annotations:
    cpaas.io/display-name: multus
  labels:
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: multus
spec:
  pluginName: multus
EOF

# 等待 ars 被创建
while true; do
  if kubectl -n cpaas-system get ars -o name | grep -w multus >/dev/null; then
    break
  fi
  echo "等待 ars/multus 被创建..."
  sleep 3
done

# 等待 Multus CNI 插件准备就绪
kubectl -n cpaas-system wait --for=condition=Health=true ars/multus
```

### 创建网络附加定义

使用以下命令创建 *NetworkAttachmentDefinition* 资源：

```shell
# 可选环境变量
export KUBECONFIG="/etc/kubernetes/admin.conf"

# 此变量值必须是连接到外部物理网络的网络接口的名称
NIC="eth0"

# 安装 Multus CNI 插件
cat <<EOF | kubectl apply -f -
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: macvlan
  namespace: kube-system
spec:
  config: '{
      "cniVersion": "0.3.0",
      "type": "macvlan",
      "master": "${NIC}",
      "mode": "bridge",
      "ipam": {
        "type": "kube-ovn",
        "server_socket": "/run/openvswitch/kube-ovn-daemon.sock",
        "provider": "macvlan.kube-system"
      }
    }'
EOF
```

### 在默认 VPC 上启用 BFD 端口

执行以下命令以在默认 VPC 上启用 BFD 端口：

```shell
# 可选环境变量
export KUBECONFIG="/etc/kubernetes/admin.conf"

# 用于与出口网关实例通信的内部 IP 地址
# 如果您想使用其他 IP 地址，请更改此值
BFD_IP="10.255.255.255"

# 为默认 VPC 启用 BFD 端口
cat <<EOF | kubectl apply -f -
apiVersion: kubeovn.io/v1
kind: Vpc
metadata:
  name: ovn-cluster
spec:
  bfdPort:
    enabled: true
    ip: "${BFD_IP}"
    nodeSelector:
      matchLabels:
        node-role.kubernetes.io/control-plane: ""
EOF
```

### 创建 MACVlan 子网

执行以下命令以创建 MACVlan 子网：

```shell
# 可选环境变量
export KUBECONFIG="/etc/kubernetes/admin.conf"

# 外部子网 CIDR
CIDR="10.226.82.0/24"
# 外部子网网关
GATEWAY="10.226.82.254"

# 创建子网
cat <<EOF | kubectl apply -f -
apiVersion: kubeovn.io/v1
kind: Subnet
metadata:
  name: macvlan
spec:
  protocol: IPv4
  provider: macvlan.kube-system
  cidrBlock: "${CIDR}"
  gateway: "${GATEWAY}"
EOF
```

## 使用出口网关

执行以下命令以创建绑定到命名空间的出口网关：

```shell
# 可选环境变量
export KUBECONFIG="/etc/kubernetes/admin.conf"

# 出口网关绑定的命名空间
NAMESPACE="ha-cluster-ns"
# 出口网关实例的名称、命名空间和副本数
GW_NAME="egress-gateway"
GW_NAMESPACE="kube-system"
REPLICAS=3
# 逗号分隔的出口 IP
EGRESS_IPS="10.226.82.241,10.226.82.242,10.226.82.243"
# 流量策略：“Cluster” 或 “Local”
# 如果设置为 “Local”，流量将在可用时路由到同一节点上的网关 Pod/实例
TRAFFIC_POLICY="Local"

# 创建出口网关
cat <<EOF | kubectl apply -f -
apiVersion: kubeovn.io/v1
kind: VpcEgressGateway
metadata:
  name: ${GW_NAME}
  namespace: ${GW_NAMESPACE}
spec:
  replicas: ${REPLICAS}
  externalSubnet: macvlan
  externalIPs:
$(for ip in $(echo ${EGRESS_IPS} | sed 's/,/ /g'); do echo "  - $ip"; done)
  selectors:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ${NAMESPACE}
  nodeSelector:
    - matchExpressions:
      - key: node-role.kubernetes.io/control-plane
        operator: DoesNotExist
  trafficPolicy: Local
  bfd:
    enabled: true
    minRX: 100
    minTX: 100
    multiplier: 5
EOF

# 等待出口网关准备就绪
kubectl -n ${GW_NAMESPACE} wait --for=condition=Ready=true veg/${GW_NAME}
```

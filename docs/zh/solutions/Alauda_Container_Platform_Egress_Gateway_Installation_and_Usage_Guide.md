---
id: KB250500026
products:
  - Alauda Container Platform
kind:
  - Solution
sourceSHA: 2b0e41c3c4fa50fa8e8a62aec7a26a81298a3ec068b98bdfa439d18aaa90227f
---

# Alauda Container Platform 出口网关安装与使用指南

## 概述

Alauda Container Platform(ACP) 提供了 **出口网关** 功能，旨在为您的应用程序提供 **专用的外部公共 IP 地址** 用于出站流量。此功能集中控制您的应用程序如何发起与外部网络的连接，从而实现对出口策略的精确管理。出口网关确保所有出站流量都源自一个稳定的、可公开路由的 IP，而不是应用程序 Pod 使用动态的内部 IP 进行外部通信。这大大简化了网络安全配置和外部集成。

本文档描述了如何在 ACP 上部署和使用出口网关。

## 先决条件

1. 已安装 Alauda Container Platform。
2. 由 ACP 管理的 Kubernetes 集群。
3. 公共 IP 可用且可达。
4. 需要设置一些配置：
   - 对于 OpenStack 虚拟机环境，您需要关闭相应网络端口的 PortSecurity。
   - 对于 VMware vSwitch 网络，MAC 地址更改、伪造传输和混杂模式操作应设置为允许。
   - 对于 Hyper-V 虚拟化，VM nic 高级功能中应启用 MAC 地址欺骗。
   - 公有云，如 AWS、GCE、阿里云等，不支持用户定义的 MAC。在这种情况下，建议使用相应公有云供应商提供的 VPC-CNI。

## 安装步骤

:::note
本文档中提到的所有命令必须在您要创建出口网关的集群的主节点上执行。
:::

### 安装 Multus CNI

执行以下命令以安装 Multus CNI 插件：

```shell
# optional environment variable
export KUBECONFIG="/etc/kubernetes/admin.conf"

# install Multus CNI plugin
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

# wait for ars to be created
while true; do
  if kubectl -n cpaas-system get ars -o name | grep -w multus >/dev/null; then
    break
  fi
  echo "Waiting for ars/multus to be created..."
  sleep 3
done

# wait for the Multus CNI plugin to be ready
kubectl -n cpaas-system wait --for=condition=Health=true ars/multus
```

### 创建网络附加定义

使用以下命令创建 *NetworkAttachmentDefinition* 资源：

```shell
# optional environment variable
export KUBECONFIG="/etc/kubernetes/admin.conf"

# this variable value MUST be name of an network interface that connects to the external physical network
NIC="eth0"

# install Multus CNI plugin
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
# optional environment variable
export KUBECONFIG="/etc/kubernetes/admin.conf"

# internal IP address used for to communicate with the egress gateway instances
# change this value if you want to use another IP address
BFD_IP="10.255.255.255"

# enable BFD port for the default VPC
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

执行以下命令以创建一个 MACVlan 子网：

```shell
# optional environment variable
export KUBECONFIG="/etc/kubernetes/admin.conf"

# external subnet CIDR
CIDR="10.226.82.0/24"
# external subnet gateway
GATEWAY="10.226.82.254"

# create the subnet
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

执行以下命令以创建一个绑定到命名空间的出口网关：

```shell
# optional environment variable
export KUBECONFIG="/etc/kubernetes/admin.conf"

# namespace to which the egress gateway is bound to
NAMESPACE="ha-cluster-ns"
# name, namespace and replicas of the egress gateway instance
GW_NAME="egress-gateway"
GW_NAMESPACE="kube-system"
REPLICAS=3
# comma separated egress IPs
EGRESS_IPS="10.226.82.241,10.226.82.242,10.226.82.243"
# traffic policy: "Clutser" or "Local"
# if set to "Local", traffic will be routed to the gateway pod/instance on the same node when available
TRAFFIC_POLICY="Local"

# create egress gateway
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

# wait for the egress gateway to be ready
kubectl -n ${GW_NAMESPACE} wait --for=condition=Ready=true veg/${GW_NAME}
```

---
id: KB250500024
products:
  - Alauda Container Platform
kind:
  - Solution
tags:
  - LB
sourceSHA: 2b43ac0d628fb19714809958ef3c35c0d0c5345ea7a67a14f53c4996854afef4
---

# Alauda 负载均衡器与 MetalLB

## 概述

MetalLB 为本地 Kubernetes 集群提供了网络负载均衡器（LoadBalancer 类型的服务）的实现。它提供了一个可供外部访问的 IP 地址，客户端可以将流量发送到集群中相应的 Pods。该可外部访问的 IP 通过标准的 ARP/NAD 请求或 BGP 协议进行公告，以实现快速故障转移或高可用性。

## 先决条件

1. 由 ACP 管理的 Kubernetes 集群。
2. L2 段中可用的 IPv4 地址范围。
3. 节点之间必须允许在端口 7946（TCP 和 UDP）上的流量。

## 安装

执行以下命令以安装 MetalLB 插件：

```bash
export KUBECONFIG="/etc/kubernetes/admin.conf"

# 安装 MetalLB 插件
cat <<EOF | kubectl apply -f -
apiVersion: cluster.alauda.io/v1alpha1
kind: ClusterPluginInstance
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "2"
    cpaas.io/display-name: metallb
  labels:
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: metallb
spec:
  pluginName: metallb
EOF

# 等待 MetalLB 插件准备就绪

kubectl -n cpaas-system wait --for=condition=Health=true ars/metallb
```

## 第 1 章. 配置地址池

作为集群管理员，您可以向集群添加地址池，以控制分配给 `LoadBalancer` 类型服务的 IP 地址。

### 步骤 1: 创建 IP 地址池

使用以下命令创建一个 IP 地址池。

```bash
cat <<EOF | kubectl apply -f -
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: example
  namespace: metallb-system
spec:
  addresses:
  - 192.168.10.0/24
  - 192.168.9.1-192.168.9.5
  - fc00:f853:0ccd:e799::/124
  autoAssign: false
EOF
```

#### 字段描述

- `spec.addresses`: MetalLB 有权管理的 IP 地址范围列表。您可以在一个池中列出多个范围，它们将共享相同的设置。每个范围可以是 CIDR 前缀或显式的起始-结束 IP 范围。
- `spec.autoAssign`: 自动分配标志，用于防止 MetalLB 对池进行自动分配。

### 步骤 2. 创建 L2 广告

为了宣传来自 `IPAddressPool` 的 IP，必须将一个 `L2Advertisement` 实例与 `IPAddressPool` 关联。使用以下命令创建一个 `L2 广告`。

```bash
cat <<EOF | kubectl apply -f -
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: example
  namespace: metallb-system
spec:
  ipAddressPools:
  - example
  nodeSelectors:
  - matchLabels:
      kubernetes.io/hostname: NodeA
  interfaces:
  - eth3
EOF
```

#### 字段描述

- `spec.ipAddressPools`: 通过此广告宣传的 IPAddressPools 列表，按名称选择。
- `spec.nodeSelectors`: NodeSelectors 允许限制节点作为负载均衡器 IP 的下一跳进行公告。当为空时，所有节点都被公告为下一跳。
- `spec.interfaces`: 要进行公告的接口列表。负载均衡器 IP 仅从这些接口进行公告。如果未设置该字段，则从主机上的所有接口进行公告。

## 第 2 章. 配置服务以使用 MetalLB

### 步骤 1: 创建一个随机 IP 的服务

默认情况下，地址池配置为允许自动分配。MetalLB 从这些地址池中分配一个 IP 地址。

要接受来自任何配置为自动分配的池的任何 IP 地址，无需特殊注释或配置。您需要做的唯一事情是将服务的类型设置为 `LoadBalancer`。

```bash
apiVersion: v1
kind: Service
metadata:
  name: example
spec:
  ports:
    - port: 8080
      targetPort: 8080
      protocol: TCP
  type: LoadBalancer
```

### 步骤 2: 创建一个具有特定 IP 的服务

要将 IP 地址分配给服务中的地址池，您可以使用 `metallb.universe.tf/loadBalancerIPs` 注释。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx
  annotations:
    metallb.universe.tf/loadBalancerIPs: 192.168.1.100
spec:
  ports:
  - port: 80
    targetPort: 80
  selector:
    app: nginx
  type: LoadBalancer
```

### 步骤 3: 创建一个具有特定池的服务

要从特定地址池中分配 IP 地址，但您不关心特定的 IP 地址，您可以使用 `metallb.universe.tf/address-pool` 注释。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx
  annotations:
    metallb.universe.tf/address-pool: example
spec:
  ports:
  - port: 80
    targetPort: 80
  selector:
    app: nginx
  type: LoadBalancer
```

---
id: KB250500024
products:
  - Alauda Container Platform
kind:
  - Solution
sourceSHA: 020cab4dbe43490320604b113451472bdf7a844c48f4099ac0419c50de7522f1
---

# Alauda LoadBalancer 与 MetalLB

## Overview

MetalLB 提供了一个网络负载均衡器（Service 类型为 LoadBalancer）在本地 Kubernetes 集群中的实现。它提供一个外部可访问的 IP 地址，客户端可以将流量发送到集群中对应的 Pods。该外部可访问的 IP 通过标准的 ARP/NAD 请求或 BGP 协议进行公告，以实现快速故障切换或高可用性。

## Prerequisites

1. 由 ACP 管理的 Kubernetes 集群。
2. L2 网络段中可用的一段 IPv4 地址。
3. 节点之间必须允许 7946 端口（TCP 和 UDP）的流量。

## Installation

执行以下命令安装 MetalLB 插件：

```bash
export KUBECONFIG="/etc/kubernetes/admin.conf"

# install MetalLB plugin
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

# wait for the MetalLB plugin to be ready

kubectl -n cpaas-system wait --for=condition=Health=true ars/metallb
```

## Chapter 1. 配置地址池

作为集群管理员，您可以向集群添加地址池，以控制分配给类型为 `LoadBalancer` 的 Service 的 IP 地址。

### Step 1: 创建 IP 地址池

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

#### 字段说明

- `spec.addresses`：MetalLB 有权限管理的 IP 地址范围列表。您可以在单个地址池中列出多个范围，它们将共享相同的设置。每个范围可以是 CIDR 前缀，也可以是明确的起始-结束 IP 范围。
- `spec.autoAssign`：AutoAssign 标志，用于防止 MetalLB 自动从该地址池分配 IP。

### Step 2. 创建 L2 广告

为了广告来自 `IPAddressPool` 的 IP，必须将一个 `L2Advertisement` 实例与该 `IPAddressPool` 关联。使用以下命令创建一个 `L2Advertisement`。

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

#### 字段说明

- `spec.ipAddressPools`：通过此广告公告的 IPAddressPools 列表，按名称选择。
- `spec.nodeSelectors`：NodeSelectors 用于限制作为 LoadBalancer IP 下一跳公告的节点。当为空时，所有节点都会被公告为下一跳。
- `spec.interfaces`：公告的接口列表。LB IP 仅从这些接口进行公告。如果未设置此字段，则从主机上的所有接口进行公告。

## Chapter 2. 配置 Service 使用 MetalLB

### Step 1: 创建一个随机 IP 的 Service

默认情况下，地址池配置为允许自动分配。MetalLB 会从这些地址池中分配 IP 地址。

要接受任何配置为自动分配的地址池中的任意 IP 地址，无需特殊注解或配置。您只需将 Service 的类型设置为 `LoadBalancer`。

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

### Step 2: 创建一个指定 IP 的 Service

要为 Service 分配地址池中的特定 IP 地址，可以使用 `metallb.universe.tf/loadBalancerIPs` 注解。

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

### Step 3: 创建一个指定地址池的 Service

要从特定地址池分配 IP 地址，但不关心具体的 IP 地址，可以使用 `metallb.universe.tf/address-pool` 注解。

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

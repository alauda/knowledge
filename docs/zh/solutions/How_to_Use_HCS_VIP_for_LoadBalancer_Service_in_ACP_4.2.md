---
id: KB250500031
products:
  - Alauda Container Platform
kind:
  - Solution
---

# 如何在 ACP 4.2 HCS 场景下为 LoadBalancer Service 使用虚拟机 VIP

## 概述

在 HCS（华为云）环境中，华为虚拟机层会预先提供 VIP（虚拟 IP 地址）用于业务对外访问。但 Kubernetes 集群中的 `LoadBalancer Service` 默认无法直接使用这些 VIP，因此需要通过创建外部地址池的方式，将华为侧已分配的 VIP 提供给集群内业务使用。

本文介绍 ACP 4.2 提供的一个方案：在 HCS 虚拟机层预先创建 VIP 后，通过平台提供的 **External IP Pools（外部地址池）** 能力创建地址池，并将这些 VIP 分配给 LoadBalancer 类型 Service，再由 kube-proxy IPVS 在每个节点上生成对应的转发规则，使外部流量到达 VIP 后能被正确转发到后端 Pod。

## 适用版本

- ACP 4.2

## 方案架构

HCS 虚拟机层负责 VIP 的对外路由，ACP 的 External IP Pools 负责管理可分配的外部地址资源，底层 MetalLB 负责将 VIP 分配给 Service，kube-proxy IPVS 在每个节点上生成虚拟服务器规则，处理流量到后端 Pod 的转发。本方案仅使用 MetalLB 的 VIP 管理与分配能力，不使用其 BGP 对外通告能力：

```
外部客户端
     ↓ 访问 VIP
HCS 虚拟机层网络（负责 VIP 的对外路由）
     ↓ 流量到达集群节点
┌─────────────────────────────────────────────────────────────┐
│                     HCS 集群                                │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Node 1     │    │   Node 2     │    │   Node 3     │  │
│  │  kube-proxy  │    │  kube-proxy  │    │  kube-proxy  │  │
│  │  (IPVS 规则) │    │  (IPVS 规则) │    │  (IPVS 规则) │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         ↓                  ↓                  ↓              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Service (LoadBalancer)                     │ │
│  │         ExternalIP (VIP): 10.0.0.100                   │ │
│  └────────────────────────────────────────────────────────┘ │
│         ↓                  ↓                  ↓              │
│     Pod A             Pod B             Pod C               │
└─────────────────────────────────────────────────────────────┘
```

**流量路径：**
1. 外部客户端访问 VIP → HCS 虚拟机层网络将流量路由到集群节点
2. kube-proxy (IPVS) 识别 VIP 对应的 Service → 按负载均衡策略转发到后端 Pod

## 前提条件

1. HCS 虚拟机层已为集群分配并配置好可用的 VIP 地址段
2. VIP 地址在 HCS 网络侧可被外部客户端访问
3. 集群插件 `metallb` 已经部署
4. VIP 地址池已与网络团队确认，且与集群内部 CIDR 不重叠

## 操作步骤

### 步骤一：配置 kube-proxy 使用 IPVS 模式

> 此步骤不可跳过。IPVS 模式是本方案的强依赖前提。

1. 编辑 kube-proxy ConfigMap：

```bash
kubectl edit configmap kube-proxy -n kube-system
```
```yaml
mode: "ipvs"
```

2. 重启 kube-proxy 使配置生效：

```bash
kubectl rollout restart daemonset/kube-proxy -n kube-system
```

3. 确认 kube-proxy 已切换到 IPVS 模式：

```bash
kubectl get configmap kube-proxy -n kube-system -o yaml | grep mode
```

输出应显示 `mode: ipvs`。

### 步骤二：创建地址池

在 ACP 控制台中进入目标集群，打开 `Networking` -> `External IP Pools`，创建可供 LoadBalancer Service 使用的外部地址池。

华为侧已经预先提供可用的 VIP 网段。创建地址池时，只需要填写以下关键字段：

1. `Name`：填写地址池名称。
2. `IP Resources` -> `IP Address`：填写华为侧分配的 VIP 地址段。

后续创建 `LoadBalancer Service` 时，注解中的地址池名称需要与这里填写的 `Name` 保持一致。

平台地址池仅用于管理和分配 VIP，VIP 的对外路由仍由 HCS 虚拟机层网络负责，因此不需要额外创建 `BGP Peer`，也不依赖 MetalLB 的 BGP 发布能力。

### 步骤三：创建 LoadBalancer Service

创建一个 LoadBalancer 类型 Service，使其从平台管理的外部地址池中分配 VIP，kube-proxy 随后在各节点生成对应的 IPVS 规则。

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: my-app-lb
  annotations:
    metallb.universe.tf/address-pool: <pool-name>
spec:
  type: LoadBalancer
  selector:
    app: my-app
  ports:
    - name: http
      port: 80
      targetPort: 8080
EOF
```

## 验证

创建 `LoadBalancer Service` 后，确认分配到的 VIP 可以正常访问。

```bash
# 查看 Service 的外部访问地址（EXTERNAL-IP 列应显示分配的 VIP）
kubectl get svc my-app-lb

# 首先在集群节点上访问 VIP:Port，确认流量已正确转发到后端业务
curl http://<VIP_ADDRESS>:80
```

然后再从集群外部访问同一个 `VIP:Port`，确认外部流量也可以正常到达业务服务。

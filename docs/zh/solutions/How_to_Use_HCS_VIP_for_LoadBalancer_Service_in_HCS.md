---
id: KB250500031
products:
  - Alauda Container Platform
kind:
  - Solution
sourceSHA: 2bb822d5949593aed0bd03c059f67678f5551b2767bacd1b8ab83ff29d24cb75
---

# 如何在 HCS 环境中使用 VM VIPs 进行 LoadBalancer 服务

## 概述

在 HCS 环境中，华为 VM 层预先创建了用于外部访问的 VIP（虚拟 IP 地址）。然而，Kubernetes 的 `LoadBalancer` 服务默认无法直接使用这些 VIP。为了使这些华为分配的 VIP 可供集群中的工作负载使用，您需要创建一个外部 IP 池。

本文档描述了 ACP 4.2 解决方案：在 HCS VM 层创建 VIP 后，使用平台提供的 **External IP Pools** 功能创建一个地址池，将这些 VIP 分配给 `LoadBalancer` 服务，并让 kube-proxy IPVS 在每个节点上生成转发规则，以便将发送到 VIP 的外部流量转发到后端 Pods。

## 适用版本

- ACP 4.2

## 架构

HCS VM 层负责外部 VIP 路由。ACP 的 `External IP Pools` 管理可分配的外部 IP 资源。MetalLB 将 VIP 分配给服务，kube-proxy IPVS 在每个节点上创建虚拟服务器规则，将流量转发到后端 Pods。该解决方案仅使用 MetalLB 进行 VIP 管理和分配，不使用其 BGP 广播功能。

```text
外部客户端
     ↓ 访问 VIP
HCS VM 层网络（路由外部 VIP 流量）
     ↓ 流量到达集群节点
┌─────────────────────────────────────────────────────────────┐
│                         HCS 集群                           │
│                                                             │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   │
│   │    节点 1    │   │    节点 2    │   │    节点 3    │   │
│   │  kube-proxy  │   │  kube-proxy  │   │  kube-proxy  │   │
│   │ (IPVS 规则)  │   │ (IPVS 规则)  │   │ (IPVS 规则)  │   │
│   └──────────────┘   └──────────────┘   └──────────────┘   │
│          ↓                  ↓                  ↓           │
│              ┌──────────────────────────────┐              │
│              │ 服务 (LoadBalancer)          │              │
│              │ ExternalIP (VIP): 10.0.0.100 │              │
│              └──────────────────────────────┘              │
│                          ↓                                 │
│                Pod A    Pod B    Pod C                     │
└─────────────────────────────────────────────────────────────┘
```

**流量流向：**

1. 外部客户端访问 VIP，HCS VM 层将流量路由到集群节点。
2. kube-proxy (IPVS) 识别拥有 VIP 的服务，并将流量转发到后端 Pods。

## 先决条件

1. HCS VM 层已为集群分配并配置了可用的 VIP 范围。
2. VIP 可以从 HCS 网络侧的外部客户端访问。
3. `metallb` 集群插件已部署。
4. VIP 地址池已与网络团队确认，并且不与集群内部 CIDR 重叠。

## 操作步骤

### 步骤 1：配置 kube-proxy 使用 IPVS 模式

> `ipvs` 模式是此解决方案的必要条件；仅在当前 kube-proxy 模式不是 `ipvs` 时执行此步骤的配置更改和重启。

某些环境默认已使用 `ipvs` 模式。首先检查当前 kube-proxy 模式。

1. 检查当前 kube-proxy 模式：

```bash
kubectl get configmap kube-proxy -n kube-system -o yaml | grep mode
```

如果输出已经是 `mode: ipvs`，您可以跳过此步骤的配置更改和重启。

2. 如果当前模式不是 `ipvs`，请编辑 kube-proxy ConfigMap：

```bash
kubectl edit configmap kube-proxy -n kube-system
```

```yaml
mode: "ipvs"
```

3. 如果您更新了 ConfigMap，请重启 kube-proxy 以使更改生效：

```bash
kubectl rollout restart daemonset/kube-proxy -n kube-system
```

4. 确认 kube-proxy 已切换到 IPVS 模式：

```bash
kubectl get configmap kube-proxy -n kube-system -o yaml | grep mode
```

输出应显示 `mode: ipvs`。

5. 验证节点上是否生成了 IPVS 规则：

```bash
ipvsadm -Ln
```

输出应包含类似以下的 IPVS 虚拟服务器条目：

```text
IP Virtual Server version 1.2.1 (size=4096)
Prot LocalAddress:Port Scheduler Flags
  -> RemoteAddress:Port           Forward Weight ActiveConn InActConn
TCP  10.0.0.100:443 rr
  -> 192.0.2.10:6443              Masq    1      6          0
```

### 步骤 2：创建地址池

在 ACP 控制台中，转到目标集群并打开 `Networking` -> `External IP Pools`。为 `LoadBalancer` 服务创建一个外部地址池。

华为已提供可用的 VIP 范围。创建地址池时，请填写以下关键字段：

1. `Name`：输入地址池名称。
2. `Type`：选择 `BGP`。
3. `IP Resources` -> `IP Address`：输入华为分配的 VIP 范围。

稍后创建 `LoadBalancer` 服务时，注释中的地址池名称必须与此处使用的 `Name` 匹配。

尽管池类型设置为 `BGP`，但在此解决方案中，平台地址池仅用于管理和分配 VIP。外部 VIP 路由仍由 HCS VM 层处理，因此您无需创建额外的 `BGP Peer`，并且此解决方案不依赖于 MetalLB 的 BGP 广播。

### 步骤 3：创建 LoadBalancer 服务

创建一个 `LoadBalancer` 服务，以便它使用来自平台管理的地址池的 VIP。然后，kube-proxy 在每个节点上创建相应的 IPVS 规则。

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

创建 `LoadBalancer` 服务后，确认分配的 VIP 是否可访问。

```bash
# 检查服务的外部地址
kubectl get svc my-app-lb

# 首先，从集群节点访问 VIP:Port
curl http://<VIP_ADDRESS>:80
```

然后从集群外部访问相同的 `VIP:Port`，确认外部流量也可以到达该服务。

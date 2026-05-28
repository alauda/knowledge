---
kind:
  - Information
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500278
sourceSHA: 6faeeb9b0d79d6f27fc26e1c416c94da791559e15af0c7ac3a6a95c87b992037
---

# LoadBalancer 服务字段语义在 ACP 中 — allocateLoadBalancerNodePorts 和 externalTrafficPolicy Local

## 概述

在 Alauda Container Platform 上，`type=LoadBalancer` 服务由集群的本地负载均衡器提供服务，其路由行为由两个标准的 `core/v1` 服务规格字段控制，这两个字段在任何符合标准的 Kubernetes 集群（kube `v1.34.5`）上表现相同。本参考文档描述了 `spec.allocateLoadBalancerNodePorts` 的默认值和效果，`spec.externalTrafficPolicy: Local` 的含义，以及如何使用 `kubectl` 检查这两个字段。

## 解决方案

服务上的 `spec.allocateLoadBalancerNodePorts` 字段是一个布尔值，默认值为 `true`，因此 `type=LoadBalancer` 服务为每个服务端口分配一个 NodePort，除非该字段被显式覆盖。

将 `spec.allocateLoadBalancerNodePorts: false` 设置为 `false` 会使服务跳过 NodePort 分配；当提供服务的负载均衡器不依赖 NodePorts 来访问后端 Pod 时，可以将其设置为 `false`。固定该字段的清单如下所示：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: example-lb
spec:
  type: LoadBalancer
  allocateLoadBalancerNodePorts: false
  externalTrafficPolicy: Local
  selector:
    app: example
  ports:
    - port: 80
      targetPort: 8080
```

`spec.externalTrafficPolicy` 字段接受枚举值 `Cluster` 和 `Local`，其中 `Cluster` 为默认值。值 `Local` 通过仅将流量路由到接收流量的同一节点上的端点来保留外部流量的客户端源 IP，并在没有本地端点的节点上丢弃流量。

## 诊断步骤

可以使用 `kubectl get svc -o yaml` 检查服务的配置，包括 `spec.externalTrafficPolicy` 和 `spec.allocateLoadBalancerNodePorts`；当填充（在已分配地址的 `type=LoadBalancer` 服务上）时，`status.loadBalancer.ingress` 也会显示该地址：

```bash
kubectl get svc <name> -n <namespace> -o yaml
```

要确认端点已分配，并且后端 Pod 在 `externalTrafficPolicy: Local` 所需的节点上运行，请列出服务的 EndpointSlices 及其节点位置的后端 Pod。在 kube `v1.34.5` 中，v1 `Endpoints` API 已被弃用（v1.33+ 指示调用者使用 `discovery.k8s.io/v1` EndpointSlice），因此更倾向于使用 `kubectl get endpointslices`：

```bash
kubectl get endpointslices -n <namespace> -l kubernetes.io/service-name=<name>
kubectl get pods -n <namespace> -o wide -l <selector>
```

可以使用 `kubectl get svc -A` 获取集群中的服务清单，该命令列出每个服务及其类型，以便在检查每个服务字段之前找到 `type=LoadBalancer` 服务。

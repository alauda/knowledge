---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500501
sourceSHA: 237076b491e1ce5091f118d8312301a7d80be428a85b242f2e9f3b01d580457d
---

# 通过标记 IPAddressPool 为非自动分配来防止 MetalLB 自动分配 IP

## 问题

MetalLB 作为 `metallb` ModulePlugin（默认通道 v4.4.1；release-4.3 分支标签 v4.3.9 的 chart `acp/chart-alauda-metallb-plugin`）和 `metallb-operator` OperatorBundle（CSV `metallb-operator.v0.15.1-alauda.20260506053547`（重建戳），上游 MetalLB v0.15.1）随 Alauda 容器平台一起发布。两种安装路径都嵌入了上游控制器镜像 `build-harbor.alauda.cn/3rdparty/metallb/controller:v4.3.6-v0.15.1`，因此 IP 分配器遵循上游 MetalLB 的行为。默认情况下，MetalLB 从任何配置的池中为每个没有显式地址池注释的 LoadBalancer 类型的 Service 分配一个外部 IP。

在必须为特定工作负载使用的池存在的环境中——例如，为特定应用程序或租户保留的范围——默认行为是不理想的：集群中的任何新 LoadBalancer Service 都可以从保留范围中声明一个地址。目标是保持池的定义，但阻止 MetalLB 从中提取，除非 Service 显式请求。

## 解决方案

在不应被未注释的 Services 使用的 IPAddressPool 上设置 `spec.autoAssign: false`。集群中的 IPAddressPool CRD 为 `metallb.io/v1beta1`；该资源位于 `metallb-system` 中，`spec.addresses` 包含 CIDR 前缀或显式起止 IP 范围的列表，`spec.autoAssign` 为布尔值（默认值为 `true`，在 CRD 中描述为“用于防止 MetalLB 自动分配池的标志”）。

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: reserved-pool
  namespace: metallb-system
spec:
  addresses:
    - 10.0.0.200-10.0.0.220
  autoAssign: false
```

仍应从保留池中接收 IP 的工作负载通过将其 Service 注释为 `metallb.universe.tf/address-pool=<poolName>` 来显式请求。该注释指示 MetalLB 控制器从命名池中分配 Service 的外部 IP，包括 `autoAssign: false` 的池。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: app-with-reserved-ip
  namespace: app-ns
  annotations:
    metallb.universe.tf/address-pool: reserved-pool
spec:
  type: LoadBalancer
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 8080
```

在将池切换为 `autoAssign: false` 之前，MetalLB 已经分配的 IP 仍然绑定到其现有的 Services——切换标志不会追溯性地释放正在使用的分配。要释放先前分配的外部 IP，请将 Service 的 `spec.type` 从 `LoadBalancer` 修补为 `ClusterIP`；MetalLB 然后释放该 IP，并且一旦池配置正确，Service 可以修补回 `LoadBalancer`。

```bash
kubectl -n <namespace> patch svc <service> -p '{"spec":{"type":"ClusterIP"}}'
```

## 诊断步骤

确认池已到位且不再自动分配。未携带 `metallb.universe.tf/address-pool` 注释的 LoadBalancer Service 如果没有其他可自动分配的池可用，预期将保持 `EXTERNAL-IP` 报告为 `<pending>`，这表明控制器拒绝从非自动分配池中提取。

```bash
kubectl -n metallb-system get ipaddresspool
kubectl -n metallb-system get ipaddresspool reserved-pool -o jsonpath='{.spec.autoAssign}{"\n"}'
kubectl get svc -A -o wide
```

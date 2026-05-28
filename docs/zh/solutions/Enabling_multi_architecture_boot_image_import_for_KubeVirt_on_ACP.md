---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500321
sourceSHA: 75a4bbb901488043837d2ac2aa46fe1f1a722c849b0e65a7faba919f1be3433e
---

# 在 ACP 上为 KubeVirt 启用多架构引导镜像导入

## 问题

在运行 KubeVirt 插件（`kubevirt-hyperconverged-operator.v4.3.5`，HCO 操作员版本 1.17.0）的 Alauda Container Platform 上，`kubevirt` 命名空间中的单例 `HyperConverged` CR 暴露了一个布尔特性开关 `spec.featureGates.enableMultiArchBootImageImport`（组 `hco.kubevirt.io/v1beta1`），该开关控制不同 CPU 架构的黄金引导镜像的导入。在新安装的集群上，此开关默认是禁用的——`spec.featureGates.enableMultiArchBootImageImport=false`，这是该功能的默认预配置状态。

## 根本原因

一个 VirtualMachine 在 `spec.template.spec.architecture` 中携带一个客户机架构（字符串字段），当未设置时，默认为集群中 KubeVirt 组件的编译架构。当多架构引导镜像导入开关保持在默认禁用状态时，HyperConverged 操作员不会维护每个架构的黄金镜像，因此用于 VM 创建的可引导源不会按架构区分。

## 解决方案

要为异构（混合 CPU 架构）集群管理每个架构的黄金引导镜像，请在单例 HyperConverged CR 上设置特性开关。将 `spec.featureGates.enableMultiArchBootImageImport` 设置为 `true`，指示 HyperConverged 操作员在异构集群上为不同 CPU 架构创建黄金镜像。

在 `kubevirt` 命名空间中修补 `kubevirt-hyperconverged` HyperConverged CR：

```bash
kubectl patch hyperconverged -n kubevirt kubevirt-hyperconverged \
  --type merge \
  -p '{"spec":{"featureGates":{"enableMultiArchBootImageImport":true}}}'
```

该字段是 `hco.kubevirt.io/v1beta1` 上的一个普通布尔值，因此相同的合并补丁形状在不再需要每个架构的黄金镜像时将其切换回 `false`。

## 诊断步骤

在更改之前，读取单例 HyperConverged CR 上开关的当前值；新安装的集群报告为 `false`：

```bash
kubectl get hyperconverged -n kubevirt kubevirt-hyperconverged \
  -o jsonpath='{.spec.featureGates.enableMultiArchBootImageImport}'
```

根据 HyperConverged CRD 确认字段形状和语义，其中 `enableMultiArchBootImageImport` 被定义为一个布尔值，其 `true` 值允许操作员为不同 CPU 架构创建黄金镜像：

```bash
kubectl get crd hyperconvergeds.hco.kubevirt.io \
  -o jsonpath='{.spec.versions[*].schema.openAPIV3Schema.properties.spec.properties.featureGates.properties.enableMultiArchBootImageImport}'
```

可以从 VirtualMachine 的 spec 中读取有效的客户机架构；未设置的值将回退到 KubeVirt 组件的编译架构：

```bash
kubectl get virtualmachine -n <namespace> <vm-name> \
  -o jsonpath='{.spec.template.spec.architecture}'
```

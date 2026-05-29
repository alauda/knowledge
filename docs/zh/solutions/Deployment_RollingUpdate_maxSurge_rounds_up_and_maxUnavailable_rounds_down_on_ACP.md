---
kind:
  - Information
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500446
sourceSHA: ff333984a035535860decca17c00245c3df50afa904e18fd4599de04c6a3036f
---

# 部署 RollingUpdate 的 maxSurge 向上取整，maxUnavailable 向下取整 在 ACP 上

## 概述

在 Alauda 容器平台 (kube `v1.34.5`, kube-controller-manager 镜像 `registry.alauda.cn:60080/tkestack/kube-controller-manager:v1.34.5`)，上游 Kubernetes `apps/v1` 部署原语未做更改，其 `spec.strategy.rollingUpdate.maxSurge` 和 `spec.strategy.rollingUpdate.maxUnavailable` 字段接受绝对整数或百分比字符串（标准的 `IntOrString` 形式）；apiserver 在此集群的实时部署上对这两种形式进行往返处理。

当值以百分比形式提供时，`kube-controller-manager` 中的内置部署控制器在协调时将其解析为整数计数。这两个字段使用相反的取整方向：`maxSurge` 通过向上取整解析 — `ceil(percent * desired_replicas)` — 以确保任何正副本计数的非零百分比始终至少产生一个涌入槽。`maxUnavailable` 通过向下取整解析 — `floor(percent * desired_replicas)` — 以确保小副本计数的分数百分比归零，而不是进一步减少可用 pod 数量。

取整方向在部署控制器的 `ResolveFenceposts` 部署助手中是固定的，该助手通过上游 `IntOrString` 规模逻辑在 apimachinery 中从百分比计算绝对数，取整方向由调用位置决定：`maxSurge` 向上取整，`maxUnavailable` 向下取整。由于使用的控制器管理器二进制文件是上游的 `v1.34.5` 构建，因此内置的 v1.34.5 控制器代码携带了部署助手，取整行为与上游文档完全一致。

## 解决方案

要计算使用百分比形式的滚动更新参数的部署的有效涌入和不可用计数，请取 `.spec.replicas` 并应用两个取整规则，方向相反。对于 `replicas=3, maxSurge=25%, maxUnavailable=25%`，控制器将 `0.25 * 3 = 0.75` 解析为 `ceil(0.75)=1` 允许的涌入 pod 和 `floor(0.75)=0` 允许的不可用 pod；在此集群上存在一个 `spec.replicas=3` 且策略为 `maxSurge=25%`/`maxUnavailable=25%` 的部署，其 spec 值以 `IntOrString` 形式保留在 `apps/v1` 下。

使用 `kubectl` 直接检查部署的滚动更新参数和结果的稳定状态：

```bash
kubectl get deployment <name> -n <namespace> \
  -o jsonpath='{.spec.replicas}{"\t"}{.spec.strategy.rollingUpdate.maxSurge}{"\t"}{.spec.strategy.rollingUpdate.maxUnavailable}{"\n"}'
kubectl get deployment <name> -n <namespace> \
  -o jsonpath='{.status.replicas}{"\t"}{.status.readyReplicas}{"\t"}{.status.availableReplicas}{"\n"}'
```

在选择百分比值时，请考虑不对称性：在小副本计数下，应用于两个字段的单个百分比不会产生相等的整数预算，因为涌入侧向上取整，而不可用侧向下取整。为了在滚动更新期间允许零个不可用 pod，请明确设置 `maxUnavailable: 0`（绝对整数，而不是百分比）；为了确保无论副本计数如何始终至少有一个涌入槽，请将 `maxSurge` 保留为非零百分比，并依赖向上取整规则。对两个字段应用相同的百分比仅在 `percent * replicas` 为整数时会产生相等的计数；否则，涌入计数将比不可用计数多一个。

以任一形式表达参数；在此集群的 `apps/v1` 部署下，绝对整数和百分比字符串均被接受：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 25%
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: app
          image: <image>
```

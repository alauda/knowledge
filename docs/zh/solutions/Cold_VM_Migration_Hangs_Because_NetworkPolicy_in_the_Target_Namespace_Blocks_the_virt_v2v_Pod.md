---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500059
sourceSHA: 00246103081c95b00310b8a3c19b5200b56a806c5bf7cf429b57ad48b0c1031b
---

# 冷虚拟机迁移因目标命名空间中的 NetworkPolicy 阻止 virt-v2v Pod 而挂起

## 问题

从 VMware 到 ACP 虚拟化（KubeVirt）的冷虚拟机迁移，由 Alauda Build 的 Forklift Operator 驱动，在转换进度步骤挂起。`forklift-controller` 日志重复显示 `Failed to update conversion progress`，而迁移的 `virt-v2v` pod 在目标命名空间的日志显示它正在提供服务，但没有消费者访问它。

## 根本原因

在转换步骤中，每个虚拟机的 `virt-v2v` pod 在 **目标命名空间**（导入虚拟机将存在的命名空间）中启动，并在端口 `8080` 上公开虚拟机的 XML。`forklift-controller` 在 `konveyor-forklift` 中运行，并轮询该端点以读取转换进度。

如果目标命名空间有一个默认拒绝流入的 `NetworkPolicy`（或将流入限制为不包括 Forklift 命名空间的标签集），则控制器与 `virt-v2v` pod 的 `:8080` 的 TCP 连接会被中断。迁移 pod 在隔离中是健康的；控制器无法观察其进度，因此它永远无法通过转换步骤。

## 解决方案

在 **目标命名空间** 中添加一个 `NetworkPolicy`，允许从 `konveyor-forklift` 命名空间在端口 `8080` 上的流入：

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-forklift-controller
  namespace: <target-namespace>
spec:
  podSelector: {}              # 应用于 virt-v2v pods（及其他任何 pod）
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: konveyor-forklift
      ports:
        - protocol: TCP
          port: 8080
```

应用后，重新运行迁移计划。控制器的轮询将达到 `virt-v2v`，转换进度将正常推进。

如果目标命名空间中的现有策略使用不同的选择器形状（命名标签、允许所有流入但有拒绝列表等），请添加一个等效于上述的单一允许规则；该规则是纯粹的附加。

## 诊断步骤

确认控制器和转换 pod 的位置：

```bash
kubectl -n konveyor-forklift get deploy forklift-controller
kubectl -n <target-namespace> get pod -l job-name -o wide   # virt-v2v pod 是一个由 Job 生成的 pod
```

确认是否有 NetworkPolicy 实际上阻止了路径：

```bash
kubectl -n <target-namespace> get networkpolicy
# 选择策略并检查其 ingress.from — 如果没有 namespaceSelector
# 允许 `konveyor-forklift`，那就是阻塞。
```

检查控制器日志中是否有 `Failed to update conversion progress`
或针对目标 pod IP 的连接拒绝 / 连接超时消息：

```bash
kubectl -n konveyor-forklift logs deploy/forklift-controller | \
  grep -E 'conversion progress|virt-v2v' | tail -20
```

从控制器的 IP 到 virt-v2v pod 的 IP 的超时确认了策略阻塞。在策略到位后成功的 `:8080` 响应确认了修复。

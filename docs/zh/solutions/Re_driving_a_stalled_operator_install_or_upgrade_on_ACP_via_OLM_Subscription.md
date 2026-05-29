---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500464
sourceSHA: 853a05f1badcfe0fd60c471aafea9bf4626c12b66b697bfdf823b70c4ca09eed
---

# 通过 OLM 订阅重新驱动在 ACP 上停滞的 operator 安装或升级

## 问题

在运行 Operator Lifecycle Manager (OLM) 控制平面的 Alauda 容器平台集群上，operator 的安装或升级可能会停止进展，并停留在当前版本。OLM 控制平面组件 — `catalog-operator` 和 `olm-operator` — 运行在 `cpaas-system` 命名空间中，因此安装机制本身位于该命名空间；而 operator 自身的 `Subscription`、`InstallPlan` 和 `ClusterServiceVersion` (CSV) 则位于 operator 自身的命名空间，而不是在 `cpaas-system` 中。在将停滞视为 OLM 级别的问题之前，请确认控制平面 pod 的健康状态：

```bash
kubectl get pods -n cpaas-system | grep -E 'catalog-operator|olm-operator'
```

每个组件的 `1/1 Running` 行表示控制平面本身正常运行，因此升级卡住更可能是针对单个 operator 资源的解析停滞，而不是 OLM 故障。

## 根本原因

operator 在安装和升级过程中的进展由三个在 operator 自身命名空间中协调的 OLM 资源驱动：`Subscription` (`subscriptions.operators.coreos.com`) 携带指向已解析 `InstallPlan` 的 `status.installPlanRef`，以及解析 `state`，如 `AtLatestKnown`；`InstallPlan` (`installplans.operators.coreos.com`) 记录批准模式和批准状态；而结果 CSV 则在一个阶段中推进至 `Succeeded`。OLM 在 `Automatic` 和 `Manual` 批准模式下协调 InstallPlans。当解析被卡住时，Subscription 继续引用一个过时或未满足的 InstallPlan，而 CSV 永远无法达到 `Succeeded`，因此 operator 停留在当前版本。

## 解决方案

删除并重新创建 operator 的 `Subscription` 强制 OLM 重新解析 operator 并重新尝试安装或升级：OLM 清除旧的 InstallPlan 引用，并为重新创建的 Subscription 生成一个新的 `InstallPlan`，这使得停滞的解析得以继续。首先捕获当前的 Subscription 规格，然后在 operator 自身的命名空间中删除并重新创建它（替换为 operator 的实际 Subscription 名称和命名空间）：

```bash
kubectl get subscription -n <operator-namespace> <subscription-name> -o yaml > sub-backup.yaml
kubectl delete subscription -n <operator-namespace> <subscription-name>
kubectl apply -f sub-backup.yaml
```

重新创建后，OLM 会在同一命名空间中生成一个新的 `InstallPlan`；对于 `Manual` 批准的 Subscription，批准生成的 InstallPlan，以便解析可以继续，然后观察 CSV 进展到 `Succeeded`。

## 诊断步骤

读取 Subscription 状态以查看当前引用的 `InstallPlan` 及其解析 `state`；未满足的引用或从未稳定的状态指向停滞的解析。这些资源位于 operator 自身的命名空间中 — 例如，`acp-storage` operator 的 Subscription 报告 `status.installPlanRef.namespace` 为 `acp-storage`，并且一旦稳定，`state` 为 `AtLatestKnown`：

```bash
kubectl get subscription -n <operator-namespace> <subscription-name> \
  -o jsonpath='{.status.installPlanRef.name}{"\n"}{.status.state}{"\n"}'
```

然后检查引用的 `InstallPlan` 的批准模式和批准状态，并确认 CSV 阶段 — 健康的链条以 CSV 达到 `Succeeded` 结束，如在命名空间 `acp-storage` 中的 `acp-storage-operator.v4.3.2` 所示：

```bash
kubectl get installplan -n <operator-namespace>
kubectl get csv -n <operator-namespace>
```

这些步骤在运行 Alauda 容器平台 `v4.3.13` (Kubernetes `v1.34.5`) 的集群上进行了验证。

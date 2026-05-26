---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500152
sourceSHA: ddf6e950fde412c77685052e883ef1b76bfe7562f8af1a18ecf12bb3a3b3b535
---

# OLM 解析器因安装命名空间中的孤立 CSV 而无法安装 operator

## 问题

在 Alauda Container Platform v4.3.13（Kubernetes v1.34.5）上，安装或升级由 OLM v0 堆栈支持的 operator 可能会失败，解析器会发出 `Warning` 事件，原因是 `ResolutionFailed`，消息以 `constraints not satisfiable` 开头，列出相关的包、通道、目录和 `ClusterServiceVersion`（CSV）\。CSV CRD `clusterserviceversions.operators.coreos.com` 在该集群中与上游 OLM v0 形式具有相同的 `status.phase` 枚举和 `status.conditions[]` 历史；驱动此协调的 `catalog-operator`、`olm-operator` 和 `packageserver` 部署在 `cpaas-system` 命名空间中运行 \。

当安装命名空间中已经存在该包的 CSV，但没有 `Subscription` 通过 `status.installedCSV` 引用它时，就会出现一种特定的解析器错误——孤立 CSV。解析器在目录所需的 CSV 和来自同一包的 `@existing/<ns>//<csv>` 条目之间发生冲突，无法满足约束集 \。

## 根本原因

`Subscription` 是通过 `status.installedCSV` 与 CSV 之间的所有权链接；当该链接缺失或过时时，受影响的 CSV 被视为安装命名空间中的孤立库存。在健康的安装中，每个运行 operator 的命名空间都有一个匹配的 `Subscription`，其 `spec.name` 是包名，`status.installedCSV` 则命名当前的 CSV \。当 `olm-operator` 协调循环尚未将其推进到 `InstallReady` 或 `Installing` 时，CSV 也可能处于 `status.phase=Pending` 状态；相同的值在 `status.conditions[]` 中记录为一行，`phase=Pending` 和 `reason` 如 `NeedsReinstall` \。

## 解决方案

确保通过删除安装命名空间中与该包相关的每个 `Subscription`、`ClusterServiceVersion` 和 `InstallPlan`，完全卸载受影响的 operator，然后再尝试重新安装。这三种资源在该集群的安装命名空间中是共存的，可以一起删除 \。可靠的形式列出并删除每个资源的名称 \:

```bash
kubectl get subscription,csv,installplan -n <install-namespace>
kubectl delete subscription <name> -n <install-namespace>
kubectl delete csv <csv-name> -n <install-namespace>
kubectl delete installplan <ip-name> -n <install-namespace>
```

当上游 OLM 安装标签 `operators.coreos.com/<package>.<install-namespace>=` 存在于这三种资源上时，单个标签范围的删除也可以工作 \:

```bash
kubectl delete subscription,csv,installplan -n <install-namespace> \
  -l operators.coreos.com/<package>.<install-namespace>=
```

在安装命名空间清理干净后，通过 CLI 或 Web 控制台重新安装 operator 成功：新的 `Subscription` 采用新解析的 CSV，`status.installedCSV` 匹配 `status.currentCSV`，并且 Subscription 的 `status.conditions` 报告 `CatalogSourcesUnhealthy=False`，原因是 `AllCatalogSourcesHealthy`，且没有 `ResolutionFailed` 条件 \。

## 诊断步骤

通过列出安装命名空间中的 `Subscriptions` 和 `CSVs` 并交叉检查所有权链接，确定 CSV 是否孤立 \:

```bash
kubectl get subscription -n <install-namespace> \
  -o custom-columns=NAME:.metadata.name,PKG:.spec.name,INSTALLED:.status.installedCSV
kubectl get csv -n <install-namespace>
```

在命名空间中存在的任何 CSV，如果在同一命名空间的 Subscription 中未显示为 `status.installedCSV`，则相对于解析器而言是孤立的 \。

检查 CSV 阶段和最新条件条目，以确认协调已停滞 \:

```bash
kubectl get csv -n <install-namespace> <csv-name> \
  -o jsonpath='{.status.phase}{"\n"}'
kubectl get csv -n <install-namespace> <csv-name> \
  -o jsonpath='{range .status.conditions[*]}{.phase}{"\t"}{.reason}{"\t"}{.lastTransitionTime}{"\n"}{end}'
```

在最新时间戳处出现 `Pending NeedsReinstall`（或 `Pending RequirementsUnknown`）的一行，表明 CSV 未在 `Pending` → `InstallReady` → `Installing` 循环中推进 \。在清理和重新安装后，Subscription 的 `status.installedCSV` 应等于其 `status.currentCSV`，并且其 `status.conditions` 应显示 `CatalogSourcesUnhealthy=False`，原因是 `AllCatalogSourcesHealthy`，且没有 `ResolutionFailed` 条件——在 `konveyor-tackle` 命名空间中观察到的 ACP v4.3.13 对 `konveyor-operator.v0.6.0-beta.1` \。

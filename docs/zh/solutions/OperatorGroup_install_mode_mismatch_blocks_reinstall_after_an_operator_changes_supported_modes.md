---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500466
sourceSHA: ad3cead5434ab5379872eaa4af298bf56d1164039a935b960e4ab3b355f7bdf5
---

# OperatorGroup 安装模式不匹配阻止在操作员更改支持模式后重新安装

## 问题

在 ACP 上安装或重新安装 OperatorBundle 失败。决定 CSV 是否可以安装的 OLM 控制器（`olm-operator` 和 `catalog-operator`）在此平台的 `cpaas-system` 命名空间中运行，而一个无法找到匹配 OperatorGroup 的 CSV 的 Subscription 会停留在 `ResolutionFailed` / `ConstraintsNotSatisfiable` 状态，永远不会安装 CSV。错误在 Subscription 上显示为：

```text
命名空间 <ns> 中的 OperatorGroup 不支持 <X> 安装模式。选择不同的安装模式或命名空间。
```

## 根本原因

OLM 通过安装模式将 CSV 匹配到 OperatorGroup。CSV 通过 `spec.installModes` 声明其支持的模式——一个 `{type, supported}` 条目的列表。OperatorGroup 通过 `spec.targetNamespaces` 隐式选择一个：

| `targetNamespaces` 值         | 隐含模式         |
| ----------------------------- | ----------------- |
| `[<og-ns>]`（自己的命名空间）   | `OwnNamespace`    |
| `[<other-ns>]`（不同的命名空间） | `SingleNamespace` |
| `[ns1, ns2, ...]`            | `MultiNamespace`  |
| 缺失 / `[]`                  | `AllNamespaces`   |

如果操作员的 `installModes` 集在版本之间缩小（例如，新 CSV 放弃对 `SingleNamespace` 的支持），而在旧版本下创建的 OperatorGroup 仍然请求该模式，则新 CSV 不再具有匹配的支持条目，OLM 会使 Subscription 保持在上述解析失败状态。这是文档中记录的上游 OLM 匹配行为；尚未通过故意的 installModes 缩小实验在 ACP 上直接重现，因此将特定的缩小场景视为表面症状的最常见触发因素，而不是唯一因素。

这适用于任何 ACP OperatorBundle（kubevirt-operator、topolvm-operator、asm-operator 等）。它不影响在 ModulePlugin 路径上的 ACP 插件（例如 `logcenter` / `logagent` / `logclickhouse`），这些插件不使用 OperatorGroups。

## 解决方案

删除过时的 OperatorGroup，然后重新创建一个其 `spec.targetNamespaces` 形状映射到新 CSV 的 `installModes` 列表中标记为 `supported: true` 的模式。在 ACP 上，OLM **不会** 自动为您重新创建 OperatorGroup——安装路径（例如 `install-acp-operator` 流程）显式地使用调用者选择的 `targetNamespaces` 值创建 OG，因此在您重新应用一个之前，命名空间将保持没有 OG。匹配的 OG 存在后，现有的 Subscription 会在下一个协调时重新解析，OLM 会选择一个兼容的 CSV。

```bash
# 1. 查找操作员命名空间中的 OperatorGroup
kubectl get og -n <operator-ns>

# 2. 删除过时的 OperatorGroup
kubectl delete og -n <operator-ns> <og-name>

# 3. 重新创建一个其 targetNamespaces 匹配新 CSV 上支持模式的 OG。
#    从 ## 根本原因 中的表格中选择形状。
cat <<'YAML' | kubectl apply -f -
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: <og-name>
  namespace: <operator-ns>
spec:
  targetNamespaces:
    - <operator-ns>   # OwnNamespace; 或者删除整个 spec 以使用 AllNamespaces
YAML

# 4. 现有的 Subscription 会在下一个协调时重新解析。
```

> 将删除 + 重新创建的范围限制在失败操作员的命名空间内。不要触碰不相关命名空间中的 OperatorGroups——其他操作员共享它们。

## 诊断步骤

比较失败的 CSV 实际支持的模式与现有 OG 请求的模式。第一个命令列出 CSV 的 `installModes` 条目；第二个命令打印 OG 的 `targetNamespaces` 形状——它们一起告诉您错误消息中的不匹配是否反映了该集群上真实的形状不一致。

```bash
# 失败的 CSV 实际支持的模式
kubectl get csv -n <ns> <csv-name> -o jsonpath='{.spec.installModes}'

# 现有 OG 请求的模式
kubectl get og -n <ns> <og-name> -o jsonpath='{.spec.targetNamespaces}{"\n"}'
```

如果 OG 的 `targetNamespaces` 形状与 CSV 的 `installModes` 中的 `supported: true` 条目不对应，则这是不匹配。

Subscription 的状态逐字携带错误，这是确认此问题并排除其他 OLM 解析失败的最快方法。

```bash
kubectl get sub -n <ns> <sub-name> -o jsonpath='{.status.conditions}' | jq
```

一个条件具有 `reason: ConstraintsNotSatisfiable` 以及包含 "does not support the X installation mode" 的消息确认了此问题，而不是其他 OLM 解析失败（例如缺少或不健康的 CatalogSource）。

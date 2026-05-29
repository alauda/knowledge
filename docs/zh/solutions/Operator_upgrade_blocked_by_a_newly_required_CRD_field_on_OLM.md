---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500485
sourceSHA: 5a117ac104cf055264303ff3d41e92ee4bffb7213221b77b8ae352e6ce29e053
---

# 操作员升级因 OLM 新要求的 CRD 字段被阻止

## 问题

在 Alauda 容器平台（`marketplace` chart `v4.3.7`，`catalog-operator` 镜像 `registry.alauda.cn:60080/3rdparty/operator-framework/olm:v4.3.1`）中，OLM 控制平面在 `cpaas-system` 命名空间中运行，并注册了上游的 `operators.coreos.com/v1alpha1` 组（`CatalogSource` / `Subscription` / `InstallPlan` / `ClusterServiceVersion` / `OperatorGroup` / `OLMConfig` / `OperatorCondition` / `Operator`）。当操作员升级被批准时，`catalog-operator` 解析一个新的 `ClusterServiceVersion` 并生成一个 `InstallPlan`，其步骤包括应用与该包一起提供的任何更新的 `CustomResourceDefinition`。

当新包提供的 `CustomResourceDefinition` 版本的 `spec.versions[].schema.openAPIV3Schema.required` 列表添加了一个之前 CRD 版本不需要的属性时，已经存储的 `CustomResource` 对象在其存储的 `spec` 中并不包含该属性。`kube-apiserver` 中的结构模式验证器（该集群上的版本为 `v1.34.5`）会在任何后续写入时拒绝这些对象，因为它们未能通过新模式的验证。

在集群上可见的结果是 `ClusterServiceVersion` 未达到 `Succeeded`。`kubectl get csv -n <namespace>` 显示新 CSV 的阶段为非 `Succeeded`（典型阶段包括 `Failed` / `Pending` / `Installing` / `Replacing`），而 `kubectl describe csv <name> -n <namespace>` 在 `status.phase`、`status.reason` 和 `status.message` 下暴露了失败的详细信息。

## 根本原因

OLM 在允许包的新 CRD 版本生效之前会执行 CRD 升级安全检查。当现有的 `CustomResource` 对象在升级时会因结构模式验证失败而无法通过更新的 `openAPIV3Schema`（因为新的 `required:` 列表列出了它们不包含的字段），OLM 会阻止升级，而不是允许 CRD 更新提交并使存储的对象无效。

在 CRD 模式属性上声明的 `default:` 关键字并不能解决此情况。`kube-apiserver` 仅在写入时应用默认值——在 `CustomResource` 的创建或更新请求时——并且从不重新遍历 etcd 以填充在字段存在之前存储的对象的默认值。因此，将新的 `required:` 字段与 `default:` 配对并不会自动修复现有的 `CustomResource` 对象；它们在写入触及之前仍然缺少该字段，并且继续未能通过新模式的验证。

通用的失败模式，不针对特定操作员，表现为：操作员的新版本将属性添加到其 CRD 的 `required` 列表中，而现有的 CustomResources 并不包含该属性，OLM 阻止升级，直到这些现有对象要么获得该字段，要么被删除。

## 解决方案

与操作员供应商协调以获取升级的迁移指导，然后修补现有的 `CustomResource` 对象，以便它们填充新要求的字段（或以其他方式更新/重新创建它们），以使其满足更新的 CRD 模式。一旦每个受影响类型的现有 `CustomResource` 都包含该字段，重新批准 `InstallPlan`，升级将继续：

```bash
kubectl get <cr-kind> -A
kubectl -n <namespace> patch <cr-kind> <name> --type=merge -p '{"spec":{"<new-required-field>":"<value>"}}'
```

在修补后，确认被阻止的 `ClusterServiceVersion` 超过之前的失败。`kubectl get csv -n <namespace>` 应该显示新的 CSV 在 `Installing` / `Replacing` 过程中向 `Succeeded` 迈进，而 `kubectl describe csv <name> -n <namespace>` 应不再携带来自先前尝试的验证 `status.reason` / `status.message`。

## 诊断步骤

直接从 CRD 对象读取受影响 CRD 的当前必需字段列表。每个 `spec.versions[].schema.openAPIV3Schema` 级别下的 `required:` 段列出了 `CustomResource` 必须携带的属性，以通过 apiserver 结构模式验证：

```bash
kubectl get crd <crd-name> -o yaml | grep -n 'required:' -A5
```

列出安装命名空间中的 `ClusterServiceVersion` 对象，以查看被阻止升级的阶段，然后描述失败的 CSV 以读取解释 `InstallPlan` 步骤未提交的 `status.reason` 和 `status.message`：

```bash
kubectl get csv -n <namespace>
kubectl describe csv <name> -n <namespace>
```

列出命名空间范围的事件，以显示 Kubernetes 在失败的 `InstallPlan` 执行期间发出的 `Warning` 事件。这些事件标记为 `clusterserviceversion/<name>`（及相关对象类型），并记录了命名空间中可见的 CRD 更新 / CSV 安装失败：

```bash
kubectl get events -n <namespace>
```

交叉引用失败的 CSV 报告的字段与 CRD 的 `required:` 列表，识别缺少该字段的每个现有 `CustomResource`，并在重新批准 `InstallPlan` 之前应用解决方案修补。

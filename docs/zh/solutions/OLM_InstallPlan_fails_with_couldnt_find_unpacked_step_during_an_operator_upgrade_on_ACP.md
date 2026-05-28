---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: 2954a6a79b6c4538f610fe84f063f7cdd251ecb9513aad58a51005eb3d93935c
---

# OLM InstallPlan 在 ACP 上的操作升级过程中因“找不到解压步骤”而失败

## 问题

在 Alauda Container Platform 上，作为 OperatorBundles 提供的操作由运行在 `cpaas-system` 命名空间中的上游 OLM 控制平面进行协调（OLM 镜像 `registry.alauda.cn:60080/3rdparty/operator-framework/olm:v4.3.1`）。在操作升级过程中，catalog-operator 将解析的包解压到一个 `InstallPlan` 中，该 `InstallPlan` 的 `status.plan[]` 每个资源携带一个类型步骤，每个元素的格式为 `{resolving, resource, status}`。当 catalog-operator 无法解压或协调这些每个资源步骤之一时——例如 RBAC `Role` 或 `ClusterRole` 步骤——该步骤的 `status` 将保持在 `Unknown` 状态，而不是达到健康的 `Present` 值。

当计划步骤以这种方式卡住时，`InstallPlan` 不会完成：其 `status.phase` 会变为 `Failed` 值，而不是健康的 `Complete` 值，卡住的 CSV 通过其自身的 `status.phase` 显示失败，携带一个 `Failed` 值和一个驼峰式的原因及可读消息。`InstallPlan` 在 `status.conditions[]` 中记录结果，每个条件携带标准的上游字段形状——`type`、`status`、`reason`、`message`、`lastTransitionTime` 和 `lastUpdateTime`——`reason` 是状态转换的驼峰式标识符。

条件 `message` 遵循上游 OLM 模板 `couldn't find unpacked step for <csv-name>: <csv-name>-<short-hash>[<gvr> (<source-name>/<source-namespace>)] (Unknown)`，命名属于该步骤的 CSV 和失败步骤的标识符；在 ACP 上，括号中的源标识解析为活动目录源，例如 `(platform/cpaas-system)`。

## 根本原因

失败消息中的括号部分——`<csv-name>-<hash>[<group>/<version>/<kind> (<source-name>/<source-namespace>)] (Unknown)`——标识失败包步骤的 GVK 以及它所解析的目录源名称和命名空间。对于 RBAC 步骤，像 `rbac.authorization.k8s.io/v1/Role` 这样的段意味着失败步骤是 `rbac.authorization.k8s.io` 组下的 `v1` API 的 `Role`；在 ACP 上，尾随的源标识反映了解析的目录源，例如 `platform/cpaas-system`。

失败在 CSV 替换期间显现，升级触发了这一过程。当新的 InstallPlan 未解析时，先前的 CSV 在其 `status.phase` 中保持 `Replacing` 值，而传入的 CSV 则保持 `Pending` 值；`csv.spec.replaces` 字段是从新 CSV 回到其替换的 CSV 名称的字符串链接，这是 catalog-operator 必须满足的升级替换边缘，以便传入的 CSV 可以进展。

## 解决方案

确认操作员命名空间中两个 CSV 之间的替换关系。列出 CSV 显示两行，`REPLACES` 列将新 CSV 链接回先前的 CSV：

```bash
kubectl get csv -n <operator-ns>
```

检查携带操作员名称前缀的集群范围和命名空间范围的 RBAC，以便识别与消息中命名的步骤相关的先前操作员版本的剩余角色：

```bash
kubectl get clusterrole | grep <operator-name>
kubectl get role -n <operator-ns> | grep <operator-name>
```

在进行新的解决之前，确认目标版本在解析的目录中实际可用，通过读取 PackageManifest 的 `status.channels[].currentCSV`。在 ACP 上，这是从 PackageManifest 本身读取的——包括目录源标识，`catalogSource=platform` 在 `catalogSourceNamespace=cpaas-system` 中——而不是假设的：

```bash
kubectl get packagemanifest <operator> -n cpaas-system -o yaml | grep currentCSV -A3
```

当新的 CSV 在其 `status.phase` 中达到 `Succeeded` 值时，恢复被确认，可以通过列出操作员命名空间中的 CSV 来观察：

```bash
kubectl get csv -n <operator-ns>
```

## 诊断步骤

当升级停滞时，列出操作员命名空间中的 CSV 显示先前的 CSV 在 `Replacing` 值中和传入的 CSV 在 `Pending` 值中，`REPLACES` 列将新 CSV 链接到其所取代的 CSV——确认传入 CSV 的 InstallPlan 尚未解析。交叉引用 InstallPlan 条件消息中命名的失败 GVR（例如 `rbac.authorization.k8s.io/v1/Role`）与携带操作员名称前缀的角色，以定位涉及的特定 RBAC 对象。一旦传入的 CSV 进展到 `Succeeded` 值，替换就已顺利完成。

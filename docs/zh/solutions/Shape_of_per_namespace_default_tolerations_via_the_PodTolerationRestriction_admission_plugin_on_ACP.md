---
kind:
  - Information
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500175
sourceSHA: a0a983314551d2119bad5b59d5b86e7e3727ad64b43ed15e779345e6f37743a0
---

# ACP 上通过 PodTolerationRestriction 准入插件设置每个命名空间的默认容忍度形状

## 概述

在上游 Kubernetes 中，一个常见的调度模式是通过在命名空间级别附加默认容忍度，将在给定命名空间中创建的每个 pod 固定到专用的污点节点池，而不是编辑每个工作负载的 PodSpec。该机制由一个准入插件 `PodTolerationRestriction` 所拥有，该插件读取 pod 的 `Namespace` 上的两个注释，并将默认容忍度合并到传入的 pods 中，或者拒绝那些容忍度不在每个命名空间白名单中的 pods。该插件存在于 kube-apiserver 的准入链中，而不是调度器中，因此其效果受到 apiserver 配置加载的限制。

在运行 kube-apiserver 镜像 `registry.alauda.cn:60080/tkestack/kube-apiserver:v1.34.5`（Kubernetes v1.34.5）的 Alauda Container Platform 集群上，apiserver 加载的变更和验证准入链不包括 `PodTolerationRestriction`。链中出现的 `DefaultTolerationSeconds` 插件是一个不同的上游插件——它在 `NoExecute` 容忍度上设置 `tolerationSeconds` 默认值，并不执行每个命名空间的默认注入或白名单强制。因此，这里描述的命名空间注释机制是 ACP 上的一个 **解决方案形状** 参考，而不是开箱即用的配方：在 `Namespace` 上设置注释是无害的，并被 API 接受，但默认 ACP apiserver 链中的任何准入插件都不会对此采取行动。

## 解决方案

将本文视为描述上游机制的形状。要使注释在 ACP 集群上生效，必须编辑 kube-apiserver 静态 pod 清单，将 `PodTolerationRestriction` 添加到 `--enable-admission-plugins`；该更改超出了正常集群操作的范围，此处不予讨论。本节的其余部分记录了注释和节点侧原语，以便在插件启用时，支持的节点配置已经到位。

这两个注释位于 `Namespace` 对象上。`Namespace.metadata.annotations` 是一个 `map[string]string`，因此它接受任意键；默认容忍度注释的值必须是一个 JSON 编码的容忍度对象数组，其条目包含标准字段：`key`、`operator`（`Equal` 或 `Exists`）、`value`、`effect`（`NoSchedule`、`PreferNoSchedule` 或 `NoExecute`）和 `tolerationSeconds`。当 `key` 为空时，`operator` 必须为 `Exists`；该组合匹配每个键和每个值（容忍所有的习语）。

使用 `kubectl annotate` 应用注释。值是一个单引号 JSON 字符串：

```bash
kubectl annotate namespace <namespace> \
  scheduler.alpha.kubernetes.io/defaultTolerations='[{"key":"role","operator":"Equal","value":"infra","effect":"NoSchedule"}]'
```

伴随的白名单注释具有相同的 JSON 形状：

```bash
kubectl annotate namespace <namespace> \
  scheduler.alpha.kubernetes.io/tolerationsWhitelist='[{"key":"role","operator":"Equal","value":"infra","effect":"NoSchedule"}]'
```

在节点侧，目标节点池使用原生 `kubectl` 动词准备一个标签和匹配的污点。角色标签将节点标记为属于专用池：

```bash
kubectl label node <node> node-role.kubernetes.io/infra=
```

默认容忍度旨在容忍的污点使用标准的 `Node.spec.taints` 形状——一个条目列表，包含必需的 `key`、可选的 `value` 和从 `NoSchedule`、`PreferNoSchedule` 或 `NoExecute` 中选择的必需 `effect`：

```bash
kubectl taint nodes <node> role=infra:NoSchedule
```

在两侧都到位的情况下，只有容忍度与污点匹配的 pods 才能落在标记的节点上；在加载了准入插件的集群中，在注释命名空间中创建的 pods 将通过准入链接收匹配的容忍度，而不是通过每个 pod 清单编辑。

## 诊断步骤

在依赖命名空间注释行为之前，确认准入插件是否处于活动状态。apiserver 加载的插件链可以从其静态 pod 清单中的 `--enable-admission-plugins` 标志中读取；在经过验证的环境中，ACP 控制平面加载了 14 个变更插件和 15 个验证插件，而 `PodTolerationRestriction` 不在这两个列表中——因此在该 apiserver 上，注释是无效的，以上描述的默认注入/白名单行为将不会被观察到。

一旦满足先决条件（apiserver 启用插件，命名空间携带注释，目标节点携带匹配的标签和污点），通过在注释命名空间中创建工作负载并使用原生 `kubectl` 检查结果节点分配来验证 pod 的放置。`-o wide` 列集包括 `NODE` 字段，这是调度器放置每个 pod 的最直接读取：

```bash
kubectl get pods -n <namespace> -o wide
```

落在准备好的节点池中的 pod 确认了容忍链的端到端；如果 pod 无法调度（`FailedScheduling` 事件引用 `untolerated taint`），则表示准入插件未注入默认容忍度（最可能是插件未启用）或 pod 的有效容忍度与节点的污点不匹配。交叉检查 pod 的 `spec.tolerations` 与节点的 `spec.taints` 以定位不匹配。

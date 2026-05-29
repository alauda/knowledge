---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500679
sourceSHA: cd390d318d6e1fc2dbf0cd7dfaca68c1c9a525f99948c1822e36ac27af21ef9c
---

# 在 ACP 上安装 Kubernetes operator 而不通过 OLM

## 概述

在 Alauda Container Platform 上，operator 的结构与其他地方的 upstream-Kubernetes 模式相同：一个控制器 pod（通常是一个 `apps/v1` `Deployment`）在调和由 `apiextensions.k8s.io/v1` `CustomResourceDefinition` 声明的自定义资源。CRD 是集群范围的对象（`NAMESPACED=false`），其 `spec.scope` 字段——`Cluster` 或 `Namespaced`——决定了它们定义的自定义资源实例的范围，而不是 CRD 本身。OLM（`operators.coreos.com` — `Subscription`、`OperatorGroup`、`ClusterServiceVersion`、`InstallPlan`、`CatalogSource`）是一个位于此模式之上的打包和生命周期层，而不是其先决条件；ACP 在其 `OperatorBundle` 和 `ModulePlugin` 分发渠道中提供 OLM API 组，而 operator 模式使用的 bare-Kubernetes 原语无论 OLM 是生产者还是 `kubectl apply` 都可以被 apiserver 接受。

本文涵盖了何时以及如何通过直接应用原始清单在 ACP 上安装 operator，这样做的好处，以及跳过 OLM 后 operator 拥有者承担的生命周期责任。

## 问题

在 ACP 上安装 operator 的标准路径是两个受管渠道之一：通过集群的 `CatalogSource` 发布的 `OperatorBundle`，通过 OLM `Subscription` 消费（与 OLM 在上游使用的相同 `operators.coreos.com/v1alpha1` 形状），或者通过 cpins/cluster-transformer 工具链实现的 `ModulePlugin` 作为 `ClusterPluginInstance`。这两者都生成一个运行中的控制器 `Deployment`、它监视的 CRD 以及所需的 RBAC。

在某些情况下，两个受管渠道都不适用——供应商仅提供原始清单（没有 `ClusterServiceVersion` 包，没有 `ModulePlugin` 包），operator 正在离线测试，或者 operator 的 RBAC 或监视命名空间需要以目录打包未参数化的方式进行调整。在这些情况下，可以通过直接使用 `kubectl` 应用其 CRD、`ServiceAccount`、`ClusterRole`、`ClusterRoleBinding` 和 `Deployment` 来安装 operator，而无需创建 `Subscription`、`OperatorGroup` 或 `ClusterServiceVersion`。

## 根本原因

OLM 的工作是从目录中获取 CSV 包并将其转换为 operator 的控制器 pod 所需的相同集群对象——一个 `Deployment`、CRD 和 RBAC 绑定。kube-apiserver 不会根据创建这些对象的主体进行区分：一个 `apps/v1` `Deployment`、一个 `apiextensions.k8s.io/v1` `CustomResourceDefinition` 和一个 `rbac.authorization.k8s.io/v1` `ClusterRole`/`ClusterRoleBinding` 在 ACP 上都是一等公民 API 资源，无论是 OLM CSV 调解器还是 `kubectl apply -f` 生成它们。因此，无 OLM 的直接安装路径实际上是一个问题，即 operator 供应商是否发布原始清单；集群本身是无关的。

如果供应商仅提供 OLM 形状的工件（一个 CSV 包加目录索引，没有独立的 `operator.yaml` 和 RBAC），则该 operator 没有供应商支持的无 OLM 安装——用户必须手动从 CSV 中提取嵌入的 `Deployment` 和 RBAC，以获取等效的原始清单，并且在升级时将独立。

## 解决方案

要在 ACP 上无 OLM 安装 operator，请按顺序应用 operator 控制器 pod 所需的原始工件，顺序为 CRDs → 命名空间 + ServiceAccount → ClusterRole + ClusterRoleBinding（如果 operator 使用领导选举或监视命名空间锁，则还需命名空间角色/角色绑定）→ Deployment。最小集，针对标准 kube 原语：

- `apiextensions.k8s.io/v1 CustomResourceDefinition`，用于控制器调和的每个 API 组（集群范围对象）。
- `v1 ServiceAccount`，位于 operator 的安装命名空间中。
- `rbac.authorization.k8s.io/v1 ClusterRole`，授予控制器对 CRD（以及它接触的任何内置 API 组）的动词的权限，以及与 `ServiceAccount` 匹配的 `ClusterRoleBinding`。
- 可选的命名空间 `Role`/`RoleBinding`，用于领导选举租约或限制在 operator 命名空间内的 webhook-config 写入。
- `apps/v1 Deployment`，用于控制器 pod，`serviceAccountName` 指向上述 SA。

确认支持的原语已在目标集群上注册：

```bash
kubectl api-resources --api-group=apiextensions.k8s.io
kubectl api-resources --api-group=rbac.authorization.k8s.io
kubectl api-resources -o wide | grep -E '^(deployments|serviceaccounts)\s'
```

按保留命名空间顺序应用清单（首先是 CRDs，以便 apiserver 可以接受 operator 立即创建的任何 `CustomResource`；RBAC 在 `Deployment` 之前，以便控制器 pod 的第一次调和循环已经获得权限）：

```bash
kubectl apply -f crds/
kubectl create namespace <operator-ns>
kubectl apply -n <operator-ns> -f service_account.yaml
kubectl apply -f cluster_role.yaml
kubectl apply -f cluster_role_binding.yaml
kubectl apply -n <operator-ns> -f operator.yaml
```

如果控制器进行领导选举或拥有限制在其安装命名空间内的 webhook 配置，则还需应用命名空间角色对：

```bash
kubectl apply -n <operator-ns> -f election_role.yaml
kubectl apply -n <operator-ns> -f election_role_binding.yaml
```

要配置监视范围，请在其 `Deployment` 上设置 operator 的 `WATCH_NAMESPACE` 环境变量——空字符串表示集群范围，命名空间名称（或逗号分隔的列表，控制器支持时）限制调和器：

```bash
kubectl set env -n <operator-ns> deployment/<operator-deploy> WATCH_NAMESPACE=""
```

当供应商的安装程序是一个包装这些相同 `kubectl create -f` 调用的 shell 脚本时，在运行之前阅读它——确认它不会尝试创建 `Subscription` 或 `OperatorGroup` 资源，并调整命名空间替换以落在为安装选择的 ACP 命名空间中。

### 生命周期责任转移到 operator 拥有者

跳过 OLM 意味着集群中不存在此 operator 的 OLM 生命周期方面——没有 `Subscription`、没有 `installPlanApproval` 控制、没有通道固定、没有 CSV 记录的 `replaces` 链、没有 `InstallPlan` 驱动的依赖解析。通过受管路径安装的任何 operator 的对比在于：

```bash
kubectl -n <ns> get subscription <name> \
  -o jsonpath='{.spec.channel}{"\t"}{.spec.installPlanApproval}{"\n"}'
kubectl -n <ns> get csv \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.replaces}{"\t"}{.status.phase}{"\n"}{end}'
```

对于无 OLM 安装，升级是重新应用一组更新的原始清单（至少是 CRDs 和 `Deployment` 镜像，RBAC 差异在升级时添加动词），版本固定是检查集群真实来源的任何清单集的属性，并且没有平台侧的冲突检测针对声称相同 CRD 或 webhook 配置的其他 operators。

## 诊断步骤

验证 operator 所拥有的 CRD 已注册，并且 `spec.scope` 与 operator 预期匹配：

```bash
kubectl get crd | grep <api-group>
kubectl get crd <crd-name> \
  -o jsonpath='{.spec.scope}{"\n"}'
```

检查控制器 `Deployment` 并确认它使用了 RBAC 绑定所引用的 `ServiceAccount`：

```bash
kubectl -n <operator-ns> get deploy <operator-deploy> \
  -o jsonpath='{.spec.template.spec.serviceAccountName}{"\n"}'
kubectl -n <operator-ns> get deploy <operator-deploy> \
  -o jsonpath='{.spec.template.spec.containers[*].env}{"\n"}'
```

确认 RBAC 绑定跨命名空间到达正确的 SA（一个常见的无 OLM 错误是 `ClusterRoleBinding` 的主体命名空间与安装命名空间不匹配）：

```bash
kubectl get clusterrolebinding <crb-name> \
  -o jsonpath='{range .subjects[*]}{.kind}/{.namespace}/{.name}{"\n"}{end}'
```

确认控制器 pod 正在调和——首先通过状态，然后通过读取其日志以查找指向 `ClusterRole` 中缺失规则的权限错误：

```bash
kubectl -n <operator-ns> get pods -l <selector>
kubectl -n <operator-ns> logs deploy/<operator-deploy> --tail=200 \
  | grep -iE 'forbidden|cannot list|cannot watch|cannot create'
```

如果权限错误命名了动词/资源对，请将其添加到 `ClusterRole` 中并重新应用；控制器将在下一个调和时获取它。

对于与同一集群上的 OLM 安装的 operators，相关的生命周期对象仍然可见：

```bash
kubectl api-resources --api-group=operators.coreos.com
kubectl get subscriptions -A
kubectl get csv -A
```

—— 在区分给定集群上哪些 operators 是 OLM 管理的，哪些是直接安装的时非常有用。

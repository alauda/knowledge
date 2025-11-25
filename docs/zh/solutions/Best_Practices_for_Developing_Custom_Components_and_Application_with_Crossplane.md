---
kind:
  - Best Practices
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB251100007
sourceSHA: ce4c98dc2bf5b557f35489aff8cd0860eec2727439ef225e2ead80d82231839f
---

# 使用 Crossplane 开发自定义组件和应用的最佳实践

## 目标

Crossplane 使用户能够通过熟悉的 Kubernetes 构造管理所有基础设施，旨在促进在多云和混合云环境中采用和实践基础设施即代码（IaC）。通过使用 Kubernetes YAML 进行资源定义，Crossplane 实现了应用程序及其依赖基础设施的同时部署。部署通过 `kubectl` 进行，确保安全和高效的数据共享。

为了让开发人员更专注于应用逻辑，本文将解释如何使用 Crossplane 开发自定义组件以打包应用模型。最终，这使开发人员能够灵活高效地构建和部署应用，而无需了解云资源的底层实现细节。

## 先决条件

- 安装 Crossplane。请参考 [如何安装 Crossplane](How_to_Install_Crossplane.md) 获取安装步骤。
- 了解更多关于 [通过组合 Kubernetes 资源构建自定义 API](https://docs.crossplane.io/latest/composition/)。

## 指南

本指南展示如何创建一种名为 App 的自定义资源。当用户调用自定义资源 API 创建 App 时，Crossplane 会创建一个 Deployment 和一个 Service。

Crossplane 将此称为 Composition。App 由 Deployment 和 Service 组成。

> 提示：本指南展示如何使用 YAML、模板化 YAML、Python 和 KCL 配置 Composition。您可以选择您喜欢的语言。

Crossplane 基于 Kubernetes，因此用户可以使用 kubectl 或 Kubernetes 生态系统中的任何其他工具来处理应用。

> 提示：Kubernetes 自定义资源只是 JSON REST API，因此用户可以使用任何支持 REST API 的工具来处理应用。

### Crossplane 核心组件关系

#### 简要描述：

- **复合资源定义（XRD）** 定义自定义基础设施类型的架构和 API。
- **复合资源（XR）** 是从 XRD 创建的实例，代表用户的基础设施请求。
- **Composition** 定义实现蓝图 - 如何将 XR 转换为实际资源。
- **Function** 在 Composition 的管道中执行转换逻辑。

#### 组件关系图

![crossplane-core-components-relationship-diagram](../../en/assets/crossplane-core-components-relationship-diagram.png)

> 流程：XRD 定义可以请求的内容 → 用户创建 XR 实例 → Composition 使用 Functions 将 XR 转换为真实基础设施。

### 创建自定义资源

#### 定义架构

Crossplane 将由 Composition 支持的自定义资源称为复合资源（XR）。

> 注意：
>
> Kubernetes 将用户定义的 API 资源称为自定义资源。
>
> Crossplane 将使用 Composition 的用户定义 API 资源称为复合资源（XR）。
>
> 复合资源（XR）是一种自定义资源。

创建此复合资源定义（XRD）以定义新的 App 复合资源（XR）的架构。

```yaml
apiVersion: apiextensions.crossplane.io/v2
kind: CompositeResourceDefinition
metadata:
  name: apps.example.crossplane.io
spec:
  scope: Namespaced
  group: example.crossplane.io
  names:
    kind: App
    plural: apps
  versions:
  - name: v1
    served: true
    referenceable: true
    schema:
     openAPIV3Schema:
       type: object
       properties:
        spec:
          type: object
          properties:
            image:
              description: 应用的 OCI 容器镜像。
              type: string
          required:
          - image
        status:
          type: object
          properties:
            replicas:
              description: 可用应用副本的数量。
              type: integer
            address:
              description: 应用的 IP 地址。
              type: string
```

将 XRD 保存为 xrd.yaml 并应用：

```bash
$ kubectl apply -f xrd.yaml
```

检查 Crossplane 是否已建立 XRD：

```bash
$ kubectl get -f xrd.yaml
NAME                         ESTABLISHED   OFFERED   AGE
apps.example.crossplane.io   True                    21s
```

现在 Crossplane 已建立 XRD，Kubernetes 正在为新的 App XR 提供 API 请求。
Crossplane 现在知道它负责新的 App XR，但它不知道在创建或更新时该怎么做。

#### 安装 Function

您可以使用不同的 Composition 函数来配置 Crossplane 在有人创建或更新复合资源（XR）时的行为。Composition 函数类似于配置语言插件。

选择使用哪种语言来配置 Crossplane 如何将 App XR 转换为 Deployment 和 Service。

YAML 是小型静态组合的不错选择。它不支持循环或条件。

创建此 Composition Function 以安装 YAML 支持：

```yaml
apiVersion: pkg.crossplane.io/v1
kind: Function
metadata:
  name: crossplane-contrib-function-patch-and-transform
spec:
  package: xpkg.crossplane.io/crossplane-contrib/function-patch-and-transform:v0.8.2
```

将 Function 保存为 fn.yaml 并应用：

```bash
$ kubectl apply -f fn.yaml
```

检查 Crossplane 是否安装了 Function：

```bash
$ kubectl get -f fn.yaml
NAME                                              INSTALLED   HEALTHY   PACKAGE                                                                     AGE
crossplane-contrib-function-patch-and-transform   True        True      xpkg.crossplane.io/crossplane-contrib/function-patch-and-transform:v0.8.2   10s
```

#### 配置 Composition

Composition 告诉 Crossplane 在您创建或更新复合资源（XR）时调用哪些函数。

创建一个 Composition 来告诉 Crossplane 在您创建或更新 App XR 时该怎么做。

创建此 Composition 以使用 YAML 配置 Crossplane：

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: app-yaml
spec:
  compositeTypeRef:
    apiVersion: example.crossplane.io/v1
    kind: App
  mode: Pipeline
  pipeline:
  - step: create-deployment-and-service
    functionRef:
      name: crossplane-contrib-function-patch-and-transform
    input:
      apiVersion: pt.fn.crossplane.io/v1beta1
      kind: Resources
      resources:
      - name: deployment
        base:
          apiVersion: apps/v1
          kind: Deployment
          spec:
            replicas: 2
            template:
              spec:
                containers:
                - name: app
                  command:
                  - /bin/sh
                  - -c
                  - sleep 1000000
                  ports:
                  - containerPort: 80
        patches:
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.name
          toFieldPath: metadata.labels[example.crossplane.io/app]
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.name
          toFieldPath: spec.selector.matchLabels[example.crossplane.io/app]
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.name
          toFieldPath: spec.template.metadata.labels[example.crossplane.io/app]
        - type: FromCompositeFieldPath
          fromFieldPath: spec.image
          toFieldPath: spec.template.spec.containers[0].image
        - type: ToCompositeFieldPath
          fromFieldPath: status.availableReplicas
          toFieldPath: status.replicas
        readinessChecks:
        - type: MatchCondition
          matchCondition:
            type: Available
            status: "True"
      - name: service
        base:
          apiVersion: v1
          kind: Service
          spec:
            ports:
            - protocol: TCP
              port: 8080
              targetPort: 80
        patches:
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.name
          toFieldPath: metadata.labels[example.crossplane.io/app]
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.name
          toFieldPath: spec.selector[example.crossplane.io/app]
        - type: ToCompositeFieldPath
          fromFieldPath: spec.clusterIP
          toFieldPath: status.address
        readinessChecks:
        - type: NonEmpty
          fieldPath: spec.clusterIP
```

将 Composition 保存为 composition.yaml 并应用：

```bash
$ kubectl apply -f composition.yaml
```

> 注意：
>
> 一个 Composition 可以包含多个函数。
>
> 函数可以改变管道中早期函数的结果。Crossplane 使用最后一个函数返回的结果。

> 提示：如果您编辑此 Composition 以包含不同类型的资源，您可能需要授予 Crossplane 访问权限以组合它。阅读更多关于 [如何授予 Crossplane 访问权限](https://docs.crossplane.io/latest/composition/compositions/#grant-access-to-composed-resources)

#### 使用自定义资源

Crossplane 现在理解 App 自定义资源。

创建一个 App：

```yaml
apiVersion: example.crossplane.io/v1
kind: App
metadata:
  namespace: default
  name: my-app
spec:
  image: <platform-registry-address>/ops/alpine:3
```

（将 <platform-registry-address> 替换为您的实际注册表地址。平台注册表地址可以从 `global` 集群详情页面获取：\[管理员] -> \[集群] -> \[集群] -> \[global]）

将 App 保存为 app.yaml 并应用：

```bash
$ kubectl apply -f app.yaml
```

检查 App 是否已准备好：

```bash
$ kubectl get -f app.yaml
NAME     SYNCED   READY   COMPOSITION   AGE
my-app   True     True    app-yaml      56s
```

> 注意：

> COMPOSITION 列显示 App 正在使用的 Composition。

> 您可以为每种 XR 创建多个 Composition。阅读 [XR 页面](https://docs.crossplane.io/latest/composition/composite-resources/) 了解如何选择 Crossplane 使用的 Composition。

检查 Crossplane 是否创建了 Deployment 和 Service：

```bash
$ kubectl get deploy,service -l example.crossplane.io/app=my-app
NAME                           READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/my-app-2r2rk   2/2     2            2           11m

NAME                   TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)    AGE
service/my-app-xfkzg   ClusterIP   10.96.148.56   <none>        8080/TCP   11m
```

> 提示：
>
> 使用 kubectl edit -f app.yaml 编辑 App 的镜像。Crossplane 会更新 Deployment 的镜像以匹配。

删除 App：

```bash
kubectl delete -f app.yaml
```

当您删除 App 时，Crossplane 会删除 Deployment 和 Service。

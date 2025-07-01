---
id: KB250500023
products:
  - Alauda Container Platform
kind:
  - Solution
sourceSHA: 8a657bb66aae33e22f64fa2ae7e6e5a6c44209bba78d77c33eb00191058c0bc2
---

# 如何在 ACP 平台上创建应用

## 概述

本文档描述了在 ACP 平台上部署应用的两种方法：一种是使用 Git（Helm 场景），另一种是使用模板。每种方法都有其优点；请根据您的需求进行选择。

### 先决条件

- **kubectl**：已安装
- **kubectl-acp**：已安装
- **helm**：已安装（Helm 场景）
- **git**：已安装并配置（Helm 场景）
- **Chart 仓库**：应用图表可用（Helm 场景）

## 创建命名空间

1. **登录 ACP**

   ```shell
   kubectl acp login <acp_address> --idp=<idp_name> --cluster=<cluster-name>
   ```

2. **创建项目**

   ```shell
   # 如果项目不存在
   kubectl acp create project <project-name> --cluster=<cluster-list> 
   ```

3. **创建命名空间并配置 ResourceQuota 和 LimitRange**

   ```shell
   kubectl acp process <template-name> --namespace cpaas-system | kubectl acp apply -f -
   ```

4. **绑定角色**

   ```shell
   kubectl acp bind <role-name> <username>  --namespace <namespace>
   ```

## 部署应用

### 方法 1：使用 Helm 部署

1. **登录 ACP 并选择命名空间**

   ```shell
   kubectl acp login <acp_address> --idp=<idp_name> --cluster=<cluster-name> --namespace=<namespace-name>
   ```

2. **克隆应用图表仓库**

   ```shell
   git clone https://github.com/test/hello-world.git
   ```

3. **通过 Helm 模板安装**

   ```shell
   helm template hello  --set replicas=1 --set image.repository=<image-repository> ./hello-world | kubectl acp apply -f -
   ```

### 方法 2：使用 ACP 模板部署

1. **登录 ACP**

   ```shell
   kubectl acp login <acp_address> --idp=<idp_name> -u <username> -p <password> --cluster=<cluster-name> --namespace <namespace-name>
   ```

2. **通过模板部署应用**

   ```shell
   # 注意：--namespace 指定模板 CR 所在的命名空间，而不是资源将要部署的命名空间
   kubectl acp process <template-name> --namespace cpaas-system  -p replica=1 -p image=<image-info> | kubectl acp apply -f -
   ```

## 模板概述

**模板**是一种将多个资源定义（如服务、存储、工作负载等）组合成一个文件的机制，使得描述和管理整个应用部署过程变得简单。通过在模板中使用参数占位符，可以在不同环境中重用相同的定义；您只需在部署时提供不同的参数值，以生成针对目标环境量身定制的资源清单，从而实现配置即代码的分离。

### 模板 CRD

确保您的 Kubernetes 集群中已经存在 Template CRD。

```yaml
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  annotations:
    controller-gen.kubebuilder.io/version: v0.17.3
  name: templates.template.alauda.io
spec:
  group: template.alauda.io
  names:
    kind: Template
    listKind: TemplateList
    plural: templates
    singular: template
  scope: Namespaced
  versions:
  - name: v1
    schema:
      openAPIV3Schema:
        description: Template 包含生成配置所需的输入。
        properties:
          apiVersion:
            description: |-
              APIVersion 定义了此对象表示的版本化架构。
              服务器应将已识别的架构转换为最新的内部值，并且
              可能会拒绝未识别的值。
              更多信息： https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#resources
            type: string
          kind:
            description: |-
              Kind 是一个字符串值，表示此对象所表示的 REST 资源。
              服务器可能会根据客户端提交请求的端点推断出这一点。
              不能被更新。
              使用 CamelCase。
              更多信息： https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#types-kinds
            type: string
          labels:
            additionalProperties:
              type: string
            description: |-
              labels 是在模板到配置转换过程中应用于每个
              对象的可选标签集。
            type: object
          message:
            description: |-
              message 是一个可选的说明性消息，当此模板被实例化时将
              显示。此字段应告知用户如何使用新创建的资源。
              在显示之前，将对消息进行参数替换，以便生成的凭证和其他参数可以
              包含在输出中。
            type: string
          metadata:
            type: object
          objects:
            description: |-
              objects 是要包含在此模板中的资源数组。
              如果对象中硬编码了命名空间值，则在模板实例化期间将被移除，
              但是如果命名空间值是或包含 ${PARAMETER_REFERENCE}，则在参数替换后解析的
              值将被尊重，并且对象将在该命名空间中创建。
            items:
              type: object
              x-kubernetes-preserve-unknown-fields: true
            type: array
            x-kubernetes-preserve-unknown-fields: true
          parameters:
            description: |-
              parameters 是在模板到配置转换过程中使用的可选参数数组。
            items:
              description: |-
                Parameter 定义了一个在模板到配置转换过程中要处理的名称/值变量。
              properties:
                description:
                  description: 参数的描述。可选。
                  type: string
                displayName:
                  description: '可选：在 UI 中显示的名称，而不是
                    参数的 ''名称'''
                  type: string
                from:
                  description: from 是生成器的输入值。可选。
                  type: string
                generate:
                  description: |-
                    generate 指定要用于从由 From 字段指定的输入值生成随机字符串的生成器。
                    结果字符串存储在 Value 字段中。如果为空，则不使用生成器，保持
                    结果 Value 不变。可选。

                    唯一支持的生成器是 "expression"，它接受一个 "from"
                    值，形式为包含范围表达式 "[a-zA-Z0-9]" 的简单正则表达式，以及
                    长度表达式 "a{length}"。

                    示例：

                    from             | value
                  type: string
                name:
                  description: |-
                    name 必须设置，并且可以在模板项中使用 ${PARAMETER_NAME} 引用。必填。
                  type: string
                required:
                  description: '可选：指示参数必须有值。默认为
                    false。'
                  type: boolean
                value:
                  description: |-
                    value 保存参数数据。如果指定，则生成器将被忽略。
                    该值在模板到配置转换过程中替换所有 ${Name} 表达式的出现。可选。
                  type: string
              required:
              - name
              type: object
            type: array
        required:
        - objects
        type: object
    served: true
    storage: true
```

### 使用 ResourceQuota 和 LimitRange 创建命名空间

#### 在 cpaas-system 中创建模板资源

```yaml
apiVersion: template.alauda.io/v1
kind: Template
metadata:
  name: namepace-quota-limit
  namespace: cpaas-system
objects:
- apiVersion: v1
  kind: Namespace
  metadata:
    labels:
      cpaas.io/cluster: "${CLUSTER}"
      cpaas.io/project: "${PROJECT}"
    name: "${NAMESPACE}"
  spec:
    finalizers:
    - kubernetes
- apiVersion: v1
  kind: ResourceQuota
  metadata:
    name: default
    namespace: "${NAMESPACE}"
  spec:
    hard:
      limits.cpu: "4"
      limits.memory: 8Gi
      pods: "10"
      requests.cpu: "2"
      requests.memory: 4Gi
- apiVersion: v1
  kind: LimitRange
  metadata:
    name: default
    namespace: "${NAMESPACE}"
  spec:
    limits:
    - default:
        cpu: 500m
        memory: 512Mi
      defaultRequest:
        cpu: 250m
        memory: 256Mi
      max:
        cpu: "1"
        memory: 1Gi
      min:
        cpu: 100m
        memory: 128Mi
      type: Container
parameters:
- description: 命名空间的名称
  displayName: namespaceName
  name: NAMESPACE
  required: true
- description: 命名空间所属项目的名称
  displayName: projectName
  name: PROJECT
- description: 命名空间所属集群的名称
  displayName: clusterName
  name: CLUSTER
  required: true
```

#### 检查渲染结果

```shell
kubectl acp process namepace-quota-limit -n cpaas-system -p NAMESPACE=tpl-ns -p PROJECT=test-project -p CLUSTER=workload
```

#### 创建命名空间

```shell
kubectl acp process namepace-quota-limit -n cpaas-system -p NAMESPACE=tpl-ns -p PROJECT=test-project -p CLUSTER=workload | kubectl acp apply -f -
```

### 部署应用

#### 在指定命名空间中创建包含部署和服务的模板资源

```yaml
apiVersion: template.alauda.io/v1
kind: Template
metadata:
  name: hello-world
  namespace: tpl-ns
objects:
- apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: ${NAME}
    namespace: tpl-ns
  spec:
    selector:
      matchLabels:
        service.cpaas.io/name: hello-world
    template:
      metadata:
        labels:
          service.cpaas.io/name: hello-world
      spec:
        affinity: {}
        containers:
        - image: hello-world:${TAG}
          imagePullPolicy: IfNotPresent
          name: nginx
          ports:
          - containerPort: 80
            protocol: TCP
- apiVersion: v1
  kind: Service
  metadata:
    name: ${NAME}-service
    namespace: tpl-ns
  spec:
    ipFamilies:
    - IPv4
    ipFamilyPolicy: SingleStack
    ports:
    - name: http
      port: 80
      protocol: TCP
      targetPort: 80
    selector:
      service.cpaas.io/name: hello-world
    type: ClusterIP
parameters:
- description: 命名空间的名称
  displayName: appname
  name: NAME
  required: true
- description: 镜像标签
  displayName: imagetag
  name: TAG
  required: true
```

#### 检查应用 yaml

```shell
kubectl acp process hello-world -n tpl-ns -p NAME=hello -p TAG=latest
```

#### 在当前命名空间中部署应用

```shell
kubectl acp process hello-world -n tpl-ns -p NAME=hello -p TAG=latest | kubectl acp apply -f -
```

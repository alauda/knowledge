---
id: KB250500032
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2
kind:
  - Solution
sourceSHA: 7bff0312a1aee6ba05310dc2df7cf6bb7d563b3d8ea52aa641c3ba78babee0b9
---

# 如何自定义 Web 控制台的示例

您可以随时动态地向任何 Kubernetes 资源添加 YAML 示例。

## 先决条件

- 您必须拥有集群管理员权限。
- 针对 `Custom Resources`，确保 CRD (apiVersion/kind) 已在集群中安装。

## 解决方案

1\). 通过定义 `ConsoleYAMLSample` 对象为 `Deployment` 资源创建一个 YAML 示例。

2\). 将该对象应用到集群中：

```yaml
apiVersion: console.alauda.io/v1
kind: ConsoleYAMLSample
metadata:
  name: sample-deployment
spec:
  title: "NGINX Deployment"
  description: "Sample deployment with 2 replicas"
  targetResource:
    apiVersion: apps/v1
    kind: Deployment
  yaml: |
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: nginx-deploy
    spec:
      replicas: 2
      selector:
        matchLabels:
          app: nginx
      template:
        metadata:
          labels:
            app: nginx
        spec:
          containers:
          - name: nginx
            image: nginx:1.25
```

注意​​：ConsoleYAMLSample 是一个集群范围的资源 – 创建时请勿指定命名空间。

字段说明：

| 字段          | 描述                                                                                                                                          | 必需/可选 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| title          | 在 Web UI 中显示的示例标题。                                                                                                  | 必需          |
| description    | 示例的详细描述。                                                                                                                | 必需          |
| targetResource | 使用 apiVersion 和 kind 指定目标资源类型。这支持原生 Kubernetes 资源和自定义资源定义 (CRDs)。 | 必需          |
| yaml           | 实际的 YAML 模板。必须符合目标资源的架构。                                                                         | 必需          |
| snippet        | 设置为 true 时，仅显示代码片段，而不是完整的 YAML。                                                                         | 可选          |

此资源允许用户将自定义 YAML 示例无缝集成到 Alauda Web 控制台中，从而提高可用性并加速开发工作流程。

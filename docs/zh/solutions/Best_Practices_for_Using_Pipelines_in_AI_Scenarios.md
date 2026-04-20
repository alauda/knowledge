---
products:
  - Alauda AI
  - Alauda DevOps Pipelines
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB260400009
sourceSHA: 432904420aa72063a25ffc83220f09190b09f7a1cfe7784c300d3fd848de6f02
---

# 在 AI 场景中使用管道的最佳实践

本文档介绍了在 AI 场景中使用管道的高级用法和最佳实践。假设用户已部署 `Alauda DevOps Pipelines`。

## 从 GitLab 触发管道

在 Alauda AI 中，模型和数据集存储在 GitLab 中。本节解释如何配置 Tekton 和 GitLab，以便在代码推送到 GitLab 时自动触发管道执行。

### 创建 EventListener

在管道所在的命名空间中创建 EventListener。请参考以下 YAML：

> **注意**：在下面所有示例 YAML 文件中，`metadata.name` 和 `metadata.namespace` 可以根据需要替换。

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata:
  name: demo
  namespace: demo-namespace
spec:
  namespaceSelector: {}
  resources: {}
  serviceAccountName: demo-sa
  triggers:
  - triggerRef: demo
```

#### 配置 EventListener 权限

Tekton 为 EventListener 创建一个 Deployment，以接收和处理事件。为该 Deployment 的 ServiceAccount 配置权限。

**创建 RoleBinding 以授予当前命名空间的权限**，如下所示：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: eventlistener
  namespace: demo-namespace
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: tekton-triggers-eventlistener-roles
subjects:
- kind: ServiceAccount
  name: demo-sa
  namespace: demo-namespace
```

**创建 ClusterRoleBinding 以授予集群资源查看权限**，如下所示：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: tekton-triggers-aggregate-view:demo-namespace:demo-sa
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: tekton-triggers-aggregate-view
subjects:
- kind: ServiceAccount
  name: demo-sa
  namespace: demo-namespace
```

#### 配置 EventListener 的外部访问地址

Tekton 为 EventListener 创建一个 Service 以接收请求，但该 Service 的类型为 `ClusterIP`，只能在集群内部访问。要从集群外部访问它，可以创建一个具有外部访问的 Service，或通过 Ingress 或其他方法提供访问入口。以下示例创建一个 `LoadBalancer` Service 以获取外部访问地址：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: demo
  namespace: demo-namespace
spec:
  ports:
  - name: http-listener
    port: 8080
    protocol: TCP
    targetPort: 8080
  selector:
    app.kubernetes.io/managed-by: EventListener
    app.kubernetes.io/part-of: Triggers
    eventlistener: demo                                # 值为 EventListener 的名称
  type: LoadBalancer
```

### 创建触发器

在 `Alauda Container Platform` 视图中，导航到相应的命名空间，然后在左侧导航中选择 `Pipelines / Triggers`，并点击页面右侧的 `Create` 按钮。

在弹出对话框中：

- 在 `Basic Info` 标签中，在 `Name` 字段中填写 `demo`，该名称应与 EventListener 中的 `triggerRef` 名称匹配
- 在 `Interceptors` 标签中，在 `Event` 字段中选择 `gitlab-push`
- 在 `Pipeline` 标签中，在 `Pipeline` 字段中选择要触发的管道名称
  - 在 `Parameters` 中，为管道配置触发参数
  - 使用 `$(tt.params.xxx)` 引用来自 GitLab 事件的相关信息。示例值：
    - `$(tt.params.git-repo-name)` 表示 GitLab 仓库的名称
    - `$(tt.params.git-revision)` 表示 Git 提交的分支或标签
    - `$(tt.params.git-commit-sha)` 表示 Git 提交的 SHA 值
    - 通过检查 `ClusterTriggerBinding` 资源 `gitlab-push` 查看所有可用参数

### 增强触发器安全性

为了增强触发器的安全性，在触发器中配置拦截器以验证 Webhook 事件的真实性。

#### 配置 GitLab 拦截器

通过切换到 YAML 模式并添加 `spec.interceptors` 来更新新创建的触发器，如下所示：

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: Trigger
metadata:
  name: demo
  namespace: demo-namespace
spec:
  ......
  interceptors:
  - params:
    - name: secretRef
      value:
        secretKey: webhook.secret
        secretName: gitlab-webhook-config
    ref:
      kind: ClusterInterceptor
      name: gitlab
  ......
```

上述 YAML 显示已向触发器添加了一个拦截器，该拦截器引用名为 `gitlab` 的 `ClusterInterceptor` 并配置 `secretRef` 参数以验证 Webhook 密钥。

#### 创建 Secret

创建一个名为 `gitlab-webhook-config` 的 Secret，其中包含 `webhook.secret` 字段。请参考以下内容：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: gitlab-webhook-config
  namespace: demo-namespace
data:
  webhook.secret: ......                  # Base64 编码的密钥值
type: Opaque
```

`webhook.secret` 的值可以任意设置，并且稍后需要在 GitLab 的 Webhook 中配置相同的值以进行验证。

### 配置 GitLab Webhook

在 GitLab 项目设置中，转到 Webhooks 并添加 Webhook 配置：

- 在 Webhook URL 中填写 EventListener 的外部访问地址
- 在 Webhook Trigger 中选择 `Push events`
- 在 Webhook `Secret token` 中填写来自 `gitlab-webhook-config` Secret 的 `webhook.secret` 的原始值（必须与 Secret 中配置的值匹配）

完成上述配置后，当代码推送到 GitLab 时，EventListener 将接收事件并执行配置的管道。

## 从管道触发另一个管道

在某些场景中，管道需要协同工作。例如，在模型训练管道完成后，可以触发另一个管道进行模型质量评估。有两种方法可以实现这一目标，下面将详细描述。

### 方法 1：在管道任务中创建 PipelineRun 以执行另一个管道

在之前的管道中添加一个 `kubectl` 任务。该任务的内容是创建一个 PipelineRun 资源。PipelineRun 表示管道的执行。在创建此资源后，Tekton 将启动相应的管道。

此方法的缺点是两个管道紧密耦合。如果下游管道有参数更改，或者上游管道需要启动另一个管道，则需要修改上游管道的内容。

### 方法 2：通过自定义事件触发管道

要理解此方法，需要介绍一些 Tekton 的基本概念：

- **EventListener**：接收和处理事件的事件监听器，如上所述
- **Event**：在 Tekton 中，事件可以理解为带有任意 JSON 主体的 HTTP 请求
- **TriggerBinding / ClusterTriggerBinding**：通过提取主体中的内容作为参数，在管道执行时引用有效信息。上述提到的 `ClusterTriggerBinding` `gitlab-push` 的内容如下：

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: ClusterTriggerBinding
metadata:
  name: gitlab-push
spec:
  params:
  - name: project-id
    value: $(body.project.id)
  - name: project-name
    value: $(body.project.name)
  - name: project-path
    value: $(body.project.path_with_namespace)
  ......
```

- **Interceptor / ClusterInterceptor**：负责过滤和判断事件的拦截器，以防止非法或不必要的事件触发管道执行
- **Trigger**：负责关联事件、拦截器和管道

在理解上述内容后，定义自定义事件并使用 Tekton 的触发机制来处理管道之间的关系。

以模型训练为例：

**步骤 1：定义模型训练完成事件**

以以下 JSON 格式定义模型训练完成事件：

```json
{
    "model_type": "xxx",
    "model_name": "demo-model",
    "model_output_url": "http://xxx.xxx.xxx.xxx/xxx"
}
```

**步骤 2：创建相应的 TriggerBinding**

TriggerBinding 配置如下：

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: model-output
  namespace: demo-namespace
spec:
  params:
  - name: model-type
    value: $(body.model_type)
  - name: model-name
    value: $(body.model_name)
  - name: model-url
    value: $(body.model_output_url)
```

**步骤 3：创建一个触发器以使用自定义 TriggerBinding**

以下示例还展示了如何使用 `CEL` ClusterInterceptor 来过滤事件：

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: Trigger
metadata:
  name: model-output
  namespace: demo-namespace
spec:
  bindings:
  - kind: TriggerBinding
    ref: model-output
  interceptors:
  - ref:
      kind: ClusterInterceptor
      name: cel
    params:
    - name: filter
      value: 'body.model_type == "llm"'                # 仅在 model_type 为 "llm" 时触发
  template:
    spec:
      params:
      - name: model-type
      - name: model-name
      - name: model-url
      resourcetemplates:
      - apiVersion: tekton.dev/v1
        kind: PipelineRun
        metadata:
          generateName: next-pipeline-
        spec:
          params:
            - name: MODEL_URL
              value: $(tt.params.model-url)
          pipelineRef:
            name: next-pipeline
```

**步骤 4：修改 EventListener 配置**

在 EventListener 的 `spec.triggers` 下添加以下内容：

```yaml
- triggerRef: model-output
```

**步骤 5：发送事件以触发下游管道**

在上游管道中向 EventListener 的 Service 地址发送事件，以触发下游管道的执行。

使用 curl 发送请求以验证配置是否正确。如果正确，管道 `next-pipeline` 将开始执行：

```bash
curl -X POST http://el-demo -H "Content-Type: application/json" \
  -d '{"model_type": "llm", "model_name": "demo-model", "model_output_url": "http://a.b.c.d/xxx"}'
```

通过这种方法，在定义事件格式后，上游管道只需根据约定发送事件，而无需再关心事件的后续处理流程。事件处理可以通过调整 EventListener 和 Trigger 配置来配置。

## 将管道存储在代码库中

Pipelines-as-Code (PAC)，维护在 `Red Hat OpenShift Pipelines` 项目中，并与 Tekton Pipelines 紧密集成，使团队能够将管道定义与应用程序源代码版本控制在一起，从而实现自动化和代码的同步而不发生漂移。

### 安装 PAC

创建以下资源：

```yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: pipelines-as-code
---
apiVersion: operator.tekton.dev/v1alpha1
kind: OpenShiftPipelinesAsCode
metadata:
  name: pipelines-as-code
spec:
  settings:
    application-name: Pipelines as Code CI
    auto-configure-new-github-repo: "false"
    bitbucket-cloud-check-source-ip: "true"
    custom-console-name: ""
    custom-console-url: ""
    custom-console-url-namespace: ""
    custom-console-url-pr-details: ""
    custom-console-url-pr-tasklog: ""
    error-detection-from-container-logs: "false"
    error-detection-max-number-of-lines: "50"
    error-detection-simple-regexp: ^(?P<filename>[^:]*):(?P<line>[0-9]+):(?P<column>[0-9]+):([
      ]*)?(?P<error>.*)
    error-log-snippet: "true"
    hub-catalog-name: tekton
    hub-url: http://tekton-hub-api.tekton-pipelines.svc:8000/v1
    remote-tasks: "true"
    secret-auto-create: "true"
    secret-github-app-token-scoped: "true"
    skip-push-event-for-pr-commits: "true"
  targetNamespace: pipelines-as-code
```

Tekton 操作员将在 `pipelines-as-code` 命名空间中部署 PAC 组件，如控制器、观察者和 webhook。

### 配置外部访问地址

`pipelines-as-code-controller` 负责接收 GitLab 事件，但 Tekton 操作员为其创建的 Service 类型为 `ClusterIP`，只能在集群内部访问。要从集群外部访问它，可以创建一个具有外部访问的 Service，或通过 Ingress 或其他方法提供访问入口。以下示例创建一个 `LoadBalancer` Service 以获取外部访问地址：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: pipelines-as-code-controller-external
  namespace: pipelines-as-code
spec:
  ports:
  - name: http-listener
    port: 8080
    protocol: TCP
    targetPort: 8082
  selector:
    app.kubernetes.io/component: controller
    app.kubernetes.io/instance: default
    app.kubernetes.io/name: controller
    app.kubernetes.io/part-of: pipelines-as-code
  type: LoadBalancer
```

### 配置代码库

创建以下资源：

```yaml
apiVersion: pipelinesascode.tekton.dev/v1alpha1
kind: Repository
metadata:
  name: repo
  namespace: demo-repo
spec:
  git_provider:
    secret:
      key: provider.token
      name: gitlab-webhook-config
    type: gitlab
    url: https://<gitlab-url>/
    webhook_secret:
      key: webhook.secret
      name: gitlab-webhook-config
  url: https://<gitlab-url>/<group>/<project>
```

根据需要填写 GitLab 信息。

Secret `gitlab-webhook-config` 的内容如下：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: gitlab-webhook-config
  namespace: demo-namespace
data:
  provider.token: ......
  webhook.secret: ......
type: Opaque
```

其中：

- **provider.token** 是 GitLab 生成的访问令牌，用于 PAC 调用 GitLab API 时使用。
- **webhook.secret** 可以任意填写，稍后需要在 GitLab 的 Webhook 中配置以验证 GitLab 事件的真实性。

> **注意**：另外，可以使用 PAC CLI 工具添加代码库。请参见： <https://pipelinesascode.com/docs/guide/cli/#repository-creation>

### GitLab 配置

在 GitLab 项目设置中，转到 Webhooks 并添加 Webhook 配置：

- 在 Webhook URL 中填写 `pipelines-as-code-controller` 的外部访问地址
- 在 Webhook Trigger 中选择 `Push events`
- 在 Webhook `Secret token` 中填写来自 `gitlab-webhook-config` Secret 的 `webhook.secret` 的原始值

### 将管道存储在代码中

存储在代码中的管道遵循以下约定：

- 必须放置在 `.tekton` 目录中
- 必须为 YAML 格式，文件扩展名为 `xxx.yaml`
- 文件内容必须是 PipelineRun 资源

示例：

```yaml
# filepath: .tekton/demo.yaml
---
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: demo
  namespace: demo-namespace
  annotations:
    pipelinesascode.tekton.dev/on-target-branch: "[main]"    # 必须指定匹配的分支
    pipelinesascode.tekton.dev/on-event: "[push]"            # 必须指定匹配的事件
                                                             # 参考： https://pipelinesascode.com/docs/guide/matchingevents/
spec:
  pipelineSpec:                                              # 使用嵌入式管道
    params:
    - name: git-url
      type: string
    - name: git-revision
      type: string
    - name: git-commit
      type: string
    tasks:
    - name: demo
      params:
      - name: args
        value:
        - GIT_URL=$(params.git-url)
        - GIT_REVISION=$(params.git-revision)
        - GIT_COMMIT=$(params.git-commit)
      - name: script
        value: |
          export "$@"
          echo "Git URL: ${GIT_URL}"
          echo "Git Revision: ${GIT_REVISION}"
          echo "Git Commit: ${GIT_COMMIT}"
      taskRef:
        params:
        - name: kind
          value: task
        - name: catalog
          value: catalog
        - name: name
          value: kubectl
        - name: version
          value: "0.1"
        resolver: hub
  params:
  - name: git-url
    value: "{{ repo_url }}"                    # PAC 将处理动态变量，如 {{ var }}
                                               # 参考： https://pipelinesascode.com/docs/guide/authoringprs/#dynamic-variables
  - name: git-revision
    value: "{{ source_branch }}"
  - name: git-commit
    value: "{{ revision }}"
```

在将上述 YAML 文件提交到 GitLab 后，将在 YAML 中指定的命名空间中创建名为 `demo-xxxx` 的 PipelineRun 资源，表示管道已开始执行。

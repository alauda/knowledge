---
products:
  - Alauda DevOps
kind:
  - Solution
id: KB260100009
sourceSHA: 9c257208435c4e01a05421e593b1db802a5eeb54afab8be0827db11df2b1cbc9
---

# 使用 CorpWeChat 的 ArtifactPromotionRun 审批事件通知

## 概述

本指南演示如何使用 **Kube Event Enricher** 启用对工件推广审批事件的个性化订阅，并通过 CorpWeChat 发送通知。

### 架构流程

```text
K8s Events (ArtifactPromotionRun)
    ↓
APIServerSource (监视事件资源)
    ↓
Kube Event Enricher Sink (丰富事件数据)
    ↓
Knative Broker (事件分发)
    ↓
ClusterSubscription (个人订阅 + CloudEvent 过滤)
    ↓
CorpWeChat 通知服务 (Katanomi 插件)
```

### 支持的事件类型

| 事件类型          | CloudEvent 类型                                                                    | 触发场景                                   | 通知接收者           |
| ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------------ | --------------------- |
| 审批待定          | `dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvalpending.v1alpha1` | 工件推广请求待审批                         | 审批者               |
| 审批被拒          | `dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvaldenied.v1alpha1`  | 推广请求已被拒绝                           | 请求者               |
| 审批通过          | `dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.running.v1alpha1`         | 推广请求已通过审批并开始执行              | 请求者               |
| 推广失败          | `dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.failed.v1alpha1`          | 推广操作失败                               | 请求者               |

---

## 先决条件

ACP 版本要求：>= 4.0

### 所需组件

在继续之前，请确保已安装和配置以下组件：

- **Alauda DevOps v3**：提供 ArtifactPromotion 和订阅/通知功能
- **Knative Eventing**：提供事件路由的 Broker 和 Trigger 机制，部署在 ACP Global
- **Kube Event Enricher Sink**：事件丰富服务（本指南中安装），部署在 ACP Global

### 权限要求

- **系统管理员**：负责基础设施设置和通知模板配置
- **项目管理员/开发人员**：为团队成员和个人用户配置个人订阅

---

## 离线包准备

本节描述在离线环境中部署工件推广通知所需的材料。

### 所需材料

以下组件是必需的：

- Kube Event Enricher Sink 部署清单和容器镜像
- 工件推广通知模板 YAML 文件

### 下载和准备安装包

有关下载离线安装包和将容器镜像上传到集群注册表的详细信息，请参阅安装指南中的 **[离线包准备](./ArtifactPromotionRun_Approval_Notification_with_CorpWeChat_Install_kubeevent-enricher.html#offline-package-preparation)** 部分。

**注意**：本指南中的所有后续命令假设您在 `kubeevent-enricher` 目录中工作。

## 设置概述

该解决方案分为两个阶段：**系统配置**（一次性）和 **用户配置**（按需）。

---

## 系统配置

### 1.1 部署 Kube Event Enricher Sink

有关部署说明，请参阅 [Kube Event Enricher Sink 安装指南](ArtifactPromotionRun_Approval_Notification_with_CorpWeChat_Install_kubeevent-enricher.md)。

### 1.2 创建 APIServerSource 以监视 Kubernetes 事件

创建一个专用命名空间并部署 APIServerSource 以监视所有 Kubernetes 事件：

```bash
# 创建监视命名空间
kubectl create namespace kubeevent-watcher

# 创建 APIServerSource 和 RBAC 配置
cat <<EOF | kubectl apply -f -
apiVersion: sources.knative.dev/v1
kind: ApiServerSource
metadata:
  name: kubeevent-watcher
  namespace: kubeevent-watcher
spec:
  resources:
  - apiVersion: v1
    kind: Event
  mode: Resource
  serviceAccountName: kubeevent-watcher-sa
  namespaceSelector:
    matchExpressions:
    - key: cpaas.io/inner-namespace # 监视所有 ACP 项目命名空间
      operator: Exists
  sink:
    ref:
      apiVersion: v1
      kind: Service
      name: kubeevent-enricher-sink
      namespace: kubeevent-enricher
    uri: "?broker=cloudevents-katanomi-dev" # 目标 Knative Broker，在集群中，cloudevents-katanomi-dev 是接收事件的默认 Broker 名称
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kubeevent-watcher-sa
  namespace: kubeevent-watcher
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubeevent-watcher
rules:
- apiGroups: [""]
  resources: ["events"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeevent-watcher
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kubeevent-watcher
subjects:
- kind: ServiceAccount
  name: kubeevent-watcher-sa
  namespace: kubeevent-watcher
EOF
```

有关 `ApiServerSource` 的更多信息，请参阅 [Knative Eventing ApiServerSource 文档](https://knative.dev/docs/eventing/sources/apiserversource/getting-started/)。

### 1.3 配置 CorpWeChat 通知服务器

配置 ACP 通知服务器以进行 CorpWeChat 集成。有关详细参数描述，请参阅 ACP 文档。

用您的 CorpWeChat 凭据替换占位符值：

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
stringData:
  displayNameEn: xx
  displayNameZh: xx
  corpId: <BASE64_ENCODED_CORP_ID>
  corpSecret: <BASE64_ENCODED_CORP_SECRET>
  agentId: <BASE64_ENCODED_AGENT_ID>
kind: Secret
metadata:
  labels:
    cpaas.io/notification.server.category: Corp
    cpaas.io/notification.server.type: CorpWeChat
  name: platform-corpwechat-server
  namespace: cpaas-system
type: NotificationServer
EOF
```

获取 WeChat Work corpId、corpSecret、agentId 的方法可以参考官方文档：<https://developer.work.weixin.qq.com/document/path/90665>

### 1.4 创建通知模板

为工件推广事件创建通知模板：

```bash
export PLATFORM_URL=xx # 设置为 ACP 平台 URL
cat dist/kubeevent.artifactpromotionrun.template.yaml | envsubst | kubectl apply -f -
```

此清单包含四个 NotificationTemplate 资源：

- `kubeevent.artifactpromotionrun.approvalpending` - 审批待定
- `kubeevent.artifactpromotionrun.approvaldenied` - 审批被拒
- `kubeevent.artifactpromotionrun.running` - 审批通过/执行中
- `kubeevent.artifactpromotionrun.failed` - 推广失败

### 1.5 更新 Katanomi 平台配置

更新 Katanomi 配置以启用 CorpWeChat 通知通道，并在 ACP Global 集群中关联通知模板：

```bash
cat <<EOF | kubectl patch configmap katanomi-config -n cpaas-system --patch-file /dev/stdin
data:
  # CorpWeChat 通知地址
  cloudeventsDelivery.sinkPluginAddress.corpwechat: http://katanomi-plugin.cpaas-system.svc/plugins/v1alpha1/notifications/corpwechat

  # 通知插件类型
  cloudeventsDelivery.sinkPluginclasses: |
    - corpwechat

  # 配置插件类型映射
  cloudeventsDelivery.sinkPluginclassesConfig: |
    - pluginClass: corpwechat
      aitMethod: CorpWeChat

  # 配置事件类型到通知模板的映射
  notification.templates: |
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvalpending.v1alpha1"
      templateRef:
        name: kubeevent.artifactpromotionrun.approvalpending
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvaldenied.v1alpha1"
      templateRef:
        name: kubeevent.artifactpromotionrun.approvaldenied
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.running.v1alpha1"
      templateRef:
        name: kubeevent.artifactpromotionrun.running
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.failed.v1alpha1"
      templateRef:
        name: kubeevent.artifactpromotionrun.failed
EOF
```

---

## 用户配置

本节由项目管理员或个人用户执行。

### 2.1 在 ACP 平台中配置用户 CorpWeChat ID

从您的 CorpWeChat 管理员处获取用户的 CorpWeChat ID，然后在 ACP 平台中进行配置：

- 导航到 **管理员 → 用户 → 用户**（对于管理员）
- 或在个人资料设置中更新（对于个人用户）

### 2.2 创建个人订阅

为每个需要接收通知的用户创建一个 `ClusterSubscription` 资源。此资源允许您：

- 定义订阅者信息
- 指定要订阅的事件类型及过滤条件
- 配置通知通道（例如，CorpWeChat）

#### 示例：为用户 `admin` 创建订阅

```bash
cat <<EOF | kubectl apply -f -
kind: ClusterSubscription
apiVersion: core.katanomi.dev/v1alpha1
metadata:
  name: "admin-artifactpromotionrun-subscription"
  annotations:
    # 指定通知通道：CorpWeChat
    "core.katanomi.dev/sink.pluginclasses": "corpwechat"
    # 用户所有权注释，必须与 spec.subscriber.name 匹配
    katanomi.dev/owned.username: "admin"
spec:
  subscriber:
    # 订阅者信息
    apiGroup: rbac.authorization.k8s.io
    kind: User
    name: admin
    info:
      # ACP 用户 ID
      id: 21232f297a57a5a743894a0e4a801fc3
      # ACP 用户邮箱
      mail: admin@example.com

  subscriptions:
  - object:
      # 订阅的资源类型
      kind: ArtifactPromotionRun
      apiVersion: artifacts.katanomi.dev/v1alpha1
      namespace: "devops"  # 订阅此命名空间

    events:
    # 1. 审批待定事件：对于审批者
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvalpending.v1alpha1"
      filter:
        exact:
          involvedobjectkind: ArtifactPromotionRun
          involvedobjectgroup: artifacts.katanomi.dev
        # CEL 表达式：仅在订阅者是审批者时通知
        cel: |
          ce.data.object.status.artifactPromotionSpec.approvalSpec.users.exists(item, item.name == "\$(subscriber.name)")

    # 2. 审批被拒事件：对于请求者
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvaldenied.v1alpha1"
      filter:
        exact:
          involvedobjectkind: ArtifactPromotionRun
          involvedobjectgroup: artifacts.katanomi.dev
        # CEL 表达式：仅在订阅者是请求者时通知
        cel: |
          ce.data.object.status.triggeredBy.user.name == "\$(subscriber.name)"

    # 3. 审批通过事件：对于请求者
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.running.v1alpha1"
      filter:
        exact:
          involvedobjectkind: ArtifactPromotionRun
          involvedobjectgroup: artifacts.katanomi.dev
        # CEL 表达式：仅在请求者是请求者时在第一次运行事件上通知
        cel: |
          !has(ce.data.event.message) && ce.data.object.status.triggeredBy.user.name == "\$(subscriber.name)"

    # 4. 推广失败事件：对于请求者
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.failed.v1alpha1"
      filter:
        exact:
          involvedobjectkind: ArtifactPromotionRun
          involvedobjectgroup: artifacts.katanomi.dev
        # CEL 表达式：仅在订阅者是请求者时通知
        cel: |
          ce.data.object.status.triggeredBy.user.name == "\$(subscriber.name)"
EOF
```

#### 所需参数定制

为每个用户定制以下参数：

| 参数                                                     | 描述                                                                          | 示例                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| `metadata.name`                                         | 唯一资源名称，标识订阅                                                       | `admin-artifactpromotionrun-subscription` |
| `metadata.annotations["katanomi.dev/owned.username"]`  | 通知接收者的用户名（必须与 `spec.subscriber.name` 匹配）                    | `admin`                                |
| `spec.subscriber.name`                                  | 订阅者的 Kubernetes 用户名                                                   | `admin`                                |
| `spec.subscriber.info.id`                               | ACP 用户 ID，通过 `kubectl get users` 获取并按 `{subscriber.name}` 过滤      | `21232f297a57a5a743894a0e4a801fc3`     |
| `spec.subscriber.info.mail`                             | 用户邮箱地址                                                                  | `admin@example.com`                    |
| `spec.subscriptions[].object.namespace`                 | 订阅事件的命名空间                                                          | `devops`                               |

**注意**：为每个用户创建一个单独的 `ClusterSubscription`。有关详细配置选项，请参阅 [高级配置](#advanced-configuration-and-references) 部分。

## 验证和测试

### 3.1 验证资源状态

```bash
# 1. 检查 APIServerSource 状态
kubectl -n kubeevent-watcher get apiserversource

# 2. 检查 ClusterSubscription 状态
kubectl get clustersubscription -A
```

### 3.2 使用 ArtifactPromotionRun 测试

使用 ACP DevOps v3 创建工件推广策略并发起推广请求以触发通知。

### 3.3 预期通知行为

当触发工件推广工作流时，用户应根据以下时间线接收通知：

- **审批待定**：当推广请求等待审批时，审批者接收通知
- **审批被拒**：当请求者的推广请求被拒绝时，请求者接收通知
- **审批通过**：当请求者的推广请求被批准并开始执行时，请求者接收通知
- **推广失败**：如果推广操作失败，请求者接收通知

## 故障排除

### 未接收 CorpWeChat 通知

如果用户未接收通知，请按照以下故障排除步骤操作：

1. **验证 CorpWeChat 服务器配置**：
   ```bash
   kubectl get secret -n cpaas-system platform-corpwechat-server -o yaml
   ```
   确保所有凭据已正确配置。

2. **确认用户 CorpWeChat ID**：
   验证用户的 CorpWeChat ID 是否在 ACP 平台中正确配置。

3. **检查 ClusterSubscription 状态**：
   ```bash
   kubectl get clustersubscription <subscription-name> -o yaml
   ```
   确保 `sink.pluginclasses` 注释包含 `corpwechat`，并且状态显示为 `Ready`。

4. **查看 kubeevent-enricher-sink 日志**：
   ```bash
   kubectl -n kubeevent-enricher logs -l app=kubeevent-enricher-sink --tail=100
   ```

5. **查看 katanomi-plugin 日志**：
   ```bash
   kubectl -n cpaas-system logs -l control-plane=katanomi-plugin --tail=100
   ```

---

## 高级配置和参考

### 订阅多个命名空间

要将单个用户订阅到多个命名空间的推广事件，请添加多个订阅条目：

```bash
kubectl apply -f - <<EOF
kind: ClusterSubscription
metadata:
  name: user1-subscription
spec:
  subscriptions:
  - object:
      kind: ArtifactPromotionRun
      apiVersion: artifacts.katanomi.dev/v1alpha1
      namespace: "devops-1"
    events:
      # . . .
  - object:
      kind: ArtifactPromotionRun
      apiVersion: artifacts.katanomi.dev/v1alpha1
      namespace: "devops-2"
    events:
      # . . .
EOF
```

### 自定义通知模板

要修改通知模板的内容，请编辑现有的模板资源：

```bash
# 编辑审批待定模板
kubectl edit notificationtemplate -n cpaas-system kubeevent.artifactpromotionrun.approvalpending
```

发送到通知模板的数据结构遵循 [CloudEvents 数据结构](#cloudevents-data-structure) 中描述的格式。

### ClusterSubscription 配置指南

#### 关键字段描述

| 字段                                                          | 描述                                                                                                      | 示例                                |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `metadata.annotations["core.katanomi.dev/sink.pluginclasses"]` | 通知通道（支持多个以逗号分隔的值）                                                                      | `"wechat,corpwechat,email"`         |
| `spec.subscriber.name`                                       | 订阅者的 Kubernetes 用户名                                                                                | `admin`                             |
| `spec.subscriber.info.id`                                    | 唯一的 ACP 用户 ID（通过 `kubectl get users` 获取，并按 `{subscriber.name}` 过滤 ACP Global 集群）      | `21232f297a57a5a743894a0e4a801fc3`  |
| `spec.subscriber.info.mail`                                  | 用户邮箱地址                                                                                             | `admin@example.com`                 |
| `subscriptions[].object.namespace`                           | 事件订阅的目标命名空间                                                                                   | `devops`                            |
| `subscriptions[].events[].filter.cel`                        | 用于精确事件过滤的 CEL 过滤表达式。使用 `ce.data` 访问 CloudEvent 数据字段                           | 参见下面的示例                     |

#### CEL 过滤表达式示例

```text
# 场景 1：订阅者是审批者
ce.data.object.status.artifactPromotionSpec.approvalSpec.users.exists(item, item.name == "$(subscriber.name)")

# 场景 2：订阅者是请求者
ce.data.object.status.triggeredBy.user.name == "$(subscriber.name)"
```

### CloudEvents 数据结构

以下示例显示 Kube Event Enricher 发出的 CloudEvents 的结构：

```json
{
  "specversion": "1.0",
  "type": "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvalpending.v1alpha1",
  "source": "/apis/artifacts.katanomi.dev/v1alpha1/namespaces/default/artifactpromotionrun/my-promotion/",
  "id": "abc-123",
  "involvedobjectgroup": "artifacts.katanomi.dev",
  "involvedobjectversion": "v1alpha1",
  "involvedobjectkind": "ArtifactPromotionRun",
  "involvedobjectname": "my-promotion",
  "involvedobjectnamespace": "default",
  "eventreason": "approvalpending",
  "eventtype": "Normal",
  "data": {
    "event": { /* 原始 K8s 事件 */ },
    "object": { /* 完整的 ArtifactPromotionRun CR */ }
  }
}
```

此数据结构可用于：

- 使用 CEL 表达式在 `ClusterSubscription` 资源中过滤 CloudEvents
- 在通知模板中呈现动态内容

## 参考

- [Knative Eventing 文档](https://knative.dev/docs/eventing/)
- [CEL 表达式语法](https://github.com/google/cel-spec)

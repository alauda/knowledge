---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500021
sourceSHA: bbdc2f35f1c502c88cc17904b00a41085738eb9f1db1b294c947b3a0ad48783f
---

# 通过 AlertmanagerConfig 将命名空间范围的 Prometheus 告警发送到电子邮件

## 问题

命名空间的拥有者在自己的命名空间中创建了一个 `PrometheusRule`，该规则正在触发 — `kubectl get prometheusrule` 显示告警处于 `Firing` 状态，用户工作负载的 Alertmanager Web UI 列出了它。但配置的电子邮件接收者从未看到通知。集群的平台侧 Alertmanager 仅转发已连接的路由树中的告警；来自工作负载命名空间的告警需要自己的路由树，通过命名空间范围的 `AlertmanagerConfig` CRD 暴露，Prometheus operator 堆栈支持用户工作负载监控。

本文将介绍如何启用用户工作负载监控路径，授予命名空间拥有者创建 AlertmanagerConfig 对象的权限，在命名空间内定义电子邮件接收者，连接 PrometheusRule，并验证通知是否到达收件箱。

## 解决方案

### 步骤 1 — 启用用户工作负载监控

平台的监控 CR 暴露了一个标志，用于开启一个专门针对用户命名空间的 Prometheus + Alertmanager 管道。确切的 ConfigMap 名称和键取决于平台的监控 operator；典型的结构如下：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-monitoring-config
  namespace: cpaas-monitoring
data:
  config.yaml: |
    enableUserWorkload: true
    alertmanagerMain: {}
    prometheusK8s: {}
```

应用后，确认用户工作负载的 Prometheus 和 Alertmanager StatefulSets 已调度：

```bash
kubectl -n cpaas-user-workload-monitoring get statefulset
```

### 步骤 2 — 启用命名空间范围的 AlertmanagerConfig 路由

用户工作负载的 Alertmanager 默认忽略命名空间范围的路由树。将用户工作负载配置中的 `enableAlertmanagerConfig` 标志切换为启用，以便 operator 从每个用户命名空间中获取 `AlertmanagerConfig` 对象：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: user-workload-monitoring-config
  namespace: cpaas-user-workload-monitoring
data:
  config.yaml: |
    alertmanager:
      enabled: true
      enableAlertmanagerConfig: true
```

在发布后，用户工作负载的 Alertmanager pod 日志应包含类似 `loaded AlertmanagerConfig <ns>/<name>` 的行，当创建命名空间范围的配置时。

### 步骤 3 — 授予命名空间拥有者权限

默认情况下，工作负载命名空间的用户无法管理其命名空间中的 AlertmanagerConfig。将上游的 `monitoring-rules-edit` ClusterRole（或平台的等效角色）绑定到用户，作用于目标命名空间：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: alice-monitoring-edit
  namespace: custom-alert
subjects:
  - kind: User
    name: alice@example.com
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: monitoring-rules-edit
  apiGroup: rbac.authorization.k8s.io
```

验证：

```bash
kubectl --as alice@example.com -n custom-alert auth can-i create alertmanagerconfig.monitoring.coreos.com
kubectl --as alice@example.com -n custom-alert auth can-i create prometheusrule.monitoring.coreos.com
```

两者应返回 `yes`。

### 步骤 4 — 创建 AlertmanagerConfig

在同一命名空间中将 SMTP 密码保存在 Secret 中；切勿将其内联到 AlertmanagerConfig YAML 中：

```bash
kubectl create namespace custom-alert
kubectl -n custom-alert create secret generic smtp-password \
  --from-literal=password="<the-smtp-account-password>"
```

定义 AlertmanagerConfig，包含一个电子邮件接收者和一个将该命名空间中的每个告警引导到它的路由：

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: custom-alert
  namespace: custom-alert
spec:
  route:
    groupBy: ["job"]
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 12h
    receiver: email_receiver
  receivers:
    - name: email_receiver
      emailConfigs:
        - to: ops-oncall@example.com
          from: alertmanager@example.com
          smarthost: smtp.example.com:587
          authUsername: alertmanager@example.com
          authPassword:
            name: smtp-password
            key: password
          requireTLS: true
```

应用它：

```bash
kubectl apply -f custom-alert.yaml
```

字段语义说明：

- `route.receiver` 必须引用在同一 AlertmanagerConfig 中定义的 `receivers[].name` — 不允许跨命名空间的接收者。
- 用户工作负载的 Alertmanager 的包装路由会默默地前缀一个命名空间相等匹配器，因此此 AlertmanagerConfig 仅看到 `namespace` 标签等于 `custom-alert` 的告警。跨命名空间转发需要平台管理员编辑顶级 Alertmanager 配置，而不是工作负载 AlertmanagerConfig。
- `requireTLS: true` 强制执行 STARTTLS — 仅在 SMTP 中继明确不支持时将其关闭（大多数云 SMTP 服务都支持）。

### 步骤 5 — 创建 PrometheusRule

一个简单的始终触发的规则是验证连接的最简单方法：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: prometheus-example-rules
  namespace: custom-alert
spec:
  groups:
    - name: example.rules
      rules:
        - alert: ExampleAlert
          expr: vector(1)
          labels:
            severity: warning
          annotations:
            summary: probe alert that always fires
```

应用它。用户工作负载的 Prometheus 会在 ~30 秒内获取该规则，将其发送到用户工作负载的 Alertmanager，而 AlertmanagerConfig 路由将其转发到电子邮件接收者。

### 步骤 6 — 验证

观察告警状态转换：

```bash
kubectl -n custom-alert get prometheusrule
kubectl -n cpaas-user-workload-monitoring exec -it sts/alertmanager-user-workload -- \
  amtool --alertmanager.url=http://localhost:9093 alert query | grep ExampleAlert
```

告警应显示为 `firing` 状态。然后检查配置在 `to:` 下的收件箱 — 一条主题类似于 `[FIRING:1] (ExampleAlert custom-alert)` 的消息应在 `groupWait`（示例中为 30 秒）内到达。

## 诊断步骤

如果告警在 Prometheus 中触发但电子邮件从未到达，请逐步检查链条。

**确认 Alertmanager 加载了 AlertmanagerConfig：**

```bash
kubectl -n cpaas-user-workload-monitoring logs sts/alertmanager-user-workload --tail=200 \
  | grep -E 'loaded AlertmanagerConfig|invalid'
```

`loaded AlertmanagerConfig custom-alert/custom-alert` 行确认配置已编译。`invalid` 或 `unmarshal` 错误指向 YAML 或模式问题（通常是 SMTP 字段中的拼写错误）。

**确认告警到达用户工作负载的 Alertmanager：**

```bash
kubectl -n cpaas-user-workload-monitoring port-forward sts/alertmanager-user-workload 9093:9093 &
amtool --alertmanager.url=http://localhost:9093 alert query
amtool --alertmanager.url=http://localhost:9093 silence query
```

如果这里缺少告警，则用户工作负载的 Prometheus 没有转发到用户工作负载的 Alertmanager — 重新检查 `enableUserWorkload: true` 和用户工作负载的 Alertmanager StatefulSet 的存在。

**独立于 Alertmanager 测试 SMTP：**

从集群直接运行 `swaks` 测试确认 SMTP 凭据和 TLS 工作，而不涉及 Alertmanager。在安装了 `swaks` 的调试 pod 中运行：

```bash
swaks --to ops-oncall@example.com \
      --from alertmanager@example.com \
      --server smtp.example.com:587 \
      --auth LOGIN --auth-user alertmanager@example.com \
      --auth-password "$(kubectl -n custom-alert get secret smtp-password \
                          -o jsonpath='{.data.password}' | base64 -d)" \
      --tls
```

成功运行将立即发送测试消息。失败将显示为众所周知的 SMTP 错误代码之一（5xx 认证失败，4xx 灰名单等），并确定是凭据、TLS 路径还是中继本身出现问题。

**如果接收者静默失败并显示 `email-config: TLS handshake failed`：**

检查 SMTP 服务器是否期望隐式 TLS（端口 465），而不是 STARTTLS（端口 587）。如果服务器使用隐式 TLS，请切换 `smarthost` 端口并将 `requireTLS: false` 设置为 false — 接收者从一开始就打开 TLS 连接，而不是升级。

**如果 AlertmanagerConfig 在编辑后未被识别：**

用户工作负载的 Alertmanager 在每次生成更改时重新加载；如果它卡住，请重启 StatefulSet：

```bash
kubectl -n cpaas-user-workload-monitoring rollout restart statefulset/alertmanager-user-workload
```

使用 `kubectl logs` 确认新 pod 加载了最新的 AlertmanagerConfig 生成。

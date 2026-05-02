---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500028
sourceSHA: 323dcd54a466756e99cb158bbb8382413b25fad6636940c0c3e84448ba19c129
---

# 部署一个临时 SMTP 接收器以测试 Alertmanager 邮件接收器配置

## 问题

在配置 Alertmanager 邮件接收器（`smtp_smarthost`、`smtp_auth_username`、`smtp_from`、`smtp_require_tls` 等）时，实际的传递路径会经过公司中继、反垃圾邮件过滤器和 TLS 链，这些可能会隔离、静默丢弃或限制测试告警的速率。这些层中的任何一个交付失败都使得很难判断配置错误是在 Alertmanager 中、在中继中，还是在收件人邮箱中。一个一次性集群内 SMTP 接收器可以让操作员在将 smarthost 切换回生产中继之前验证 Alertmanager 管道的端到端功能。

## 解决方案

### 步骤 1 — 在集群内部署一个临时 SMTP 接收器

[`mailhog`](https://github.com/mailhog/MailHog) 是一个单二进制的 SMTP 服务器，它将每条消息接受到内存存储中，并通过 HTTP UI 进行展示。将其作为一个由 ClusterIP 服务前置的单个 Pod 运行：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mailhog
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels: { app: mailhog }
  template:
    metadata:
      labels: { app: mailhog }
    spec:
      containers:
        - name: mailhog
          image: mailhog/mailhog:v1.0.1
          ports:
            - containerPort: 1025
              name: smtp
            - containerPort: 8025
              name: http
---
apiVersion: v1
kind: Service
metadata:
  name: mailhog
  namespace: monitoring
spec:
  selector: { app: mailhog }
  ports:
    - name: smtp
      port: 1025
      targetPort: 1025
    - name: http
      port: 8025
      targetPort: 8025
```

### 步骤 2 — 将 Alertmanager 指向接收器

编辑 Alertmanager 配置，使 `smtp_smarthost` 为 `mailhog.monitoring.svc.cluster.local:1025`，并禁用身份验证（接收器接受所有内容）：

```yaml
global:
  smtp_smarthost: 'mailhog.monitoring.svc.cluster.local:1025'
  smtp_from: 'alerts@example.com'
  smtp_require_tls: false
  smtp_hello: 'alertmanager'

route:
  receiver: smoke

receivers:
  - name: smoke
    email_configs:
      - to: 'oncall@example.com'
        require_tls: false
        send_resolved: true
```

如果 Alertmanager 是由 Prometheus Operator 管理的，相应的 `AlertmanagerConfig` CR 使用相同的 `email_configs` 结构；如果是通过名为 `alertmanager-main`（或类似名称）的 `Secret` 配置的，请编辑该 Secret 的 `alertmanager.yaml` 有效负载并重启 Alertmanager Pods。

### 步骤 3 — 触发测试告警

创建一个始终触发的 `PrometheusRule`，附加到 Alertmanager 监听的任何 `Prometheus` 实例：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: smoketest-always-firing
  namespace: monitoring
  labels:
    role: alert-rules
spec:
  groups:
    - name: smoketest
      rules:
        - alert: SmoketestAlert
          expr: vector(1)
          for: 0m
          labels:
            severity: info
          annotations:
            summary: Alertmanager 邮件路径烟雾测试
            description: 此告警始终触发；在 mailhog 中看到后可以安全忽略。
```

在一到两个抓取间隔内，告警会到达 Alertmanager，邮件接收器会触发。

### 步骤 4 — 验证消息是否到达

端口转发 mailhog HTTP UI：

```bash
kubectl -n monitoring port-forward svc/mailhog 8025:8025
```

打开 `http://127.0.0.1:8025`，确认测试告警出现，并带有配置的 `From:` 和 `To:` 头部以及渲染的 Alertmanager 正文。相同的数据可以通过 JSON API 获取：

```bash
curl -s http://127.0.0.1:8025/api/v2/messages | jq '.items[0] | {From, To, Subject: .Content.Headers.Subject}'
```

### 步骤 5 — 清理

删除烟雾测试的 PrometheusRule，将 Alertmanager 的 `smtp_smarthost` 切换回生产中继，并移除 mailhog 部署/服务。

## 诊断步骤

如果消息从未到达 mailhog：

- 检查 Alertmanager 是否实际接收到了来自 Prometheus 的告警：

  ```bash
  kubectl -n monitoring exec deploy/alertmanager-main -c alertmanager -- \
    wget -qO- http://localhost:9093/api/v2/alerts | jq '.[].labels.alertname'
  ```

- 查看 Alertmanager 日志以获取 SMTP 尝试的信息：

  ```bash
  kubectl -n monitoring logs deploy/alertmanager-main -c alertmanager --tail=50 | grep -i smtp
  ```

- 确认 Pod 到 Pod 的 DNS 是否解析接收器服务：

  ```bash
  kubectl -n monitoring exec deploy/alertmanager-main -- \
    nslookup mailhog.monitoring.svc.cluster.local
  ```

- 如果上游强制使用 TLS，请仅为烟雾测试设置 `smtp_require_tls: false` — 在指向生产中继之前重新启用它。

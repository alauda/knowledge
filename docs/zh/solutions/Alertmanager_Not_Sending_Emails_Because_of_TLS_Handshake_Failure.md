---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500157
sourceSHA: ffc458a2b5b49a2c8e96b7abdfb4766d3192701570d57d1e42dd00967f9b89df
---

# Alertmanager 无法将邮件发送到 ACP 上的 SMTP smarthost

## 问题

在安装了 `prometheus` ModulePlugin (v4.3.3) 的 Alauda 容器平台集群中，Alertmanager 工作负载在 `cpaas-system` 命名空间中运行，作为 kube-prometheus chart (`ait/chart-kube-prometheus` v4.3.1，发布名称为 `kube-prometheus` ) 的一部分。当操作员在平台默认设置的基础上添加 SMTP 邮件接收器，并且 smarthost 交互失败时——无论是在 TCP 连接、TLS 协商还是 SMTP 对话本身——警报都不会被发送。实际的日志行形状取决于交付失败的阶段，因此此类故障的诊断入口点是 `cpaas-system` 中 Alertmanager pod 的 alertmanager 容器日志。

## 根本原因

ACP 提供了一个默认的 Alertmanager 配置 (`configForACP` 在 kube-prometheus chart 中)，该配置仅定义了一个指向平台 CPAAS 路由的 webhook 接收器——默认情况下没有 SMTP 全局块和邮件接收器。邮件发送仅在操作员在默认设置上叠加 SMTP 全局部分和邮件接收器后才能工作，方法是编辑渲染的配置密钥或创建一个 `AlertmanagerConfig` 自定义资源。用户提供的叠加中配置错误的 `smtp_require_tls` / 每个接收器的 `require_tls` 切换是 SMTP 交付失败的典型来源，具体的日志行由接收器实际拒绝的连接 / TLS / SMTP 对话中的位置决定。

## 解决方案

Alertmanager 配置保存在与 Alertmanager 自定义资源相同命名空间中的名为 `alertmanager-<alertmanager-cr-name>` 的 Kubernetes Secret 中。在具有标准 kube-prometheus 发布的 ACP 集群中，这解析为 `cpaas-system` 中的 Secret `alertmanager-kube-prometheus`。该 Secret 的 `alertmanager.yaml` 键保存了渲染的配置，编辑该键后重新应用 Secret 是对接收器层进行任何更改的结构性解决方法。

读取当前渲染的配置，以便叠加在现有结构之上，而不是盲目替换它：

```bash
kubectl get secret -n cpaas-system alertmanager-kube-prometheus \
  -o jsonpath='{.data.alertmanager\.yaml}' | base64 -d
```

针对 smarthost 的 TLS 握手失败几乎总是意味着 Alertmanager 不信任 smarthost 的证书或服务器名称不匹配——而不是 TLS 本身应该被关闭。首先解决信任问题：将接收器指向正确的 CA 包，并在需要时匹配服务器名称，而不是禁用加密。`AlertmanagerConfig` CRD 通过 `spec.receivers[].emailConfigs[].tlsConfig` 直接暴露这一点（CA 证书、客户端证书/密钥和 `serverName`）；原始的 `alertmanager.yaml` 形式携带等效的 `email_configs[].tls_config` 块。提供 smarthost 的颁发 CA 以便证书验证是正确的解决方案，并保持 SMTP 会话加密。

```yaml
receivers:
- name: email-ops
  email_configs:
  - to: ops@example.internal
    tls_config:
      ca_file: /etc/alertmanager/smtp-ca/ca.crt
      server_name: smtp.example.internal
```

禁用 TLS 验证或 TLS 本身是最后的手段、临时解决方法——例如，在获取适当的 CA 包时确认 smarthost 是否可达。它以明文（或未经验证）发送凭据和警报内容，因此在生产环境中不得保留。如果必须临时应用，相关的上游键是集群范围的 `global.smtp_require_tls: false` 切换和每个接收器的 `email_configs[].require_tls: false` 切换（在 CRD 中键入为 `requireTLS: false`）；更倾向于使用 `tls_config.insecure_skip_verify: true`，它在跳过证书验证的同时保持通道加密，而不是 `require_tls: false`，后者完全放弃加密。

叠加在平台默认的 `configForACP` 之上的最小叠加大致如下——根据环境调整接收器名称和 smarthost，并优先使用上面的 `tls_config` CA 路径，而不是这里显示的 `*_require_tls: false` 切换：

```yaml
global:
  smtp_smarthost: smtp.example.internal:587
  smtp_from: alerts@example.internal
  smtp_auth_username: alerts@example.internal
  smtp_auth_password: redacted
  smtp_require_tls: false  # 仅作为最后手段的解决方法 — 请参阅上面的警告
receivers:
- name: email-ops
  email_configs:
  - to: ops@example.internal
    require_tls: false      # 仅作为最后手段的解决方法 — 更倾向于 tls_config CA
```

使用更新的 `alertmanager.yaml` 重新渲染密钥并将其应用回 `cpaas-system`。编辑配置密钥后，alertmanager pod 必须获取新配置；典型的操作是删除 alertmanager pod，以便 StatefulSet 重新创建它，并将 prometheus-operator 渲染的密钥重新挂载到容器中：

```bash
kubectl delete pod -n cpaas-system -l app.kubernetes.io/name=alertmanager
```

对于更倾向于使用类型化的、Kubernetes 原生接口而不是手动编辑的密钥负载的环境，`prometheus-operator` chart (`ait/chart-prometheus-operator`) 提供了 `AlertmanagerConfig` CRD；在此 ACP 安装中，提供的版本为 `monitoring.coreos.com/v1alpha1`。该 CRD 将 SMTP 和 TLS 接口建模为 `spec.receivers[].emailConfigs[]` 下的类型字段——包括 `smarthost`、`requireTLS`、`tlsConfig`（带 CA / 证书 / `insecureSkipVerify`）、`authUsername`、`authPassword`（Secret 引用）和 `forceImplicitTLS`——提供了直接编辑原始 `alertmanager.yaml` 密钥的替代方案。

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: email-ops
  namespace: cpaas-system
spec:
  receivers:
  - name: email-ops
    emailConfigs:
    - to: ops@example.internal
      smarthost: smtp.example.internal:587
      requireTLS: true
      tlsConfig:
        ca:
          secret:
            name: alertmanager-smtp-ca
            key: ca.crt
        serverName: smtp.example.internal
      authUsername: alerts@example.internal
      authPassword:
        name: alertmanager-smtp
        key: password
```

上述示例保持 TLS 开启（`requireTLS: true`）并通过 `tlsConfig` 提供 smarthost CA，以便证书验证——这是首选的形状。仅在上述临时、不安全的生产解决方法中设置 `requireTLS: false`。

## 诊断步骤

尾随 alertmanager 容器日志以观察 SMTP 交付失败的表面，并在叠加更改后验证恢复：

```bash
kubectl logs -n cpaas-system -l app.kubernetes.io/name=alertmanager \
  -c alertmanager --tail=200 -f
```

检查运行中的 pod 挂载的活动配置，以确保叠加到达工作负载，而不仅仅是 Secret 对象：

```bash
kubectl get secret -n cpaas-system alertmanager-kube-prometheus \
  -o jsonpath='{.data.alertmanager\.yaml}' | base64 -d
```

如果渲染的配置看起来正确，但日志仍然显示先前的失败，则 pod 尚未重新挂载更新的密钥；删除 alertmanager pod，以便 StatefulSet 重新创建它并获取新配置。

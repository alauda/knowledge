---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: 74330118ab9154b1d2a92bc8e4e1b5d670aaaf76dc6fc2be2b95858706089728
---

# 在 ACP 上为 Alertmanager 的 SMTP 邮件接收器配置自定义 CA 证书

## 问题

在安装了 `prometheus` ModulePlugin 的 Alauda 容器平台上（图表 `ait/chart-kube-prometheus` v4.3.3，镜像 `3rdparty/prometheus/alertmanager:v0.32.1-v4.3.4`），Alertmanager 的 SMTP 邮件接收器必须验证 smarthost 的 TLS 证书是否与容器内的信任存储一致。当 smarthost 证书由一个不在该信任存储中的私有或内部 CA 签名时，与 SMTP 服务器的 TLS 握手将失败，并出现 `x509: certificate signed by unknown authority` 的错误，配置的邮件通知将无法发送。

## 根本原因

在 `cpaas-system` 中提供的 Alertmanager 二进制文件是上游的 Alertmanager v0.32.1，它遵循上游的 `email_configs[].tls_config.ca_file` 字段。该字段接受一个指向 Alertmanager 容器内的文件系统路径，该路径指向一个用于验证 smarthost 证书的 PEM 编码 CA 包。如果未设置 `ca_file`（或未引用 smarthost 证书的颁发者），则连接仅会根据容器的默认信任存储进行验证——该存储不包括任意内部或私有 CA——接收器将记录 x509 验证失败，而不是发送邮件。

## 解决方案

通过在 `cpaas-system` 中创建 Kubernetes Secret 并在平台的 Alertmanager CR 中列出它，将私有 CA 包提供给 Alertmanager pod。支持的挂载表面是上游 prometheus-operator 的 `Alertmanager.spec.secrets[]` 字段——该字段与平台在 `Alertmanager` `cpaas-system/kube-prometheus` 上已经使用的字段相同，其实时的 `spec.secrets` 包括由 operator 挂载的 `callback-secret`。

创建持有 PEM 编码 CA 包的 Secret（将文件路径替换为实际的 CA 包路径）：

```bash
kubectl -n cpaas-system create secret generic smtp-ca-bundle \
  --from-file=ca.crt=/path/to/smtp-ca.pem
```

将 Secret 名称添加到 Alertmanager CR 的 `spec.secrets[]` 中。prometheus-operator 会协调 `spec.secrets[]` 并将每个条目挂载到 Alertmanager pod 的 `/etc/alertmanager/secrets/<secret-name>/`（只读），与当前在运行的 pod 上挂载的 `callback-secret` 相同：

```bash
kubectl -n cpaas-system patch alertmanager kube-prometheus \
  --type merge \
  -p '{"spec":{"secrets":["smtp-ca-bundle"]}}'
```

当需要多个 secrets 时，传递完整列表（补丁替换 `spec.secrets` 而不是追加），以便保留现有条目，例如 `callback-secret`。

通过 operator 生成的路径 `/etc/alertmanager/secrets/<secret-name>/<key-in-secret>` 从邮件接收器引用挂载的包。相同的路径模式已经在实时渲染的 `alertmanager.yaml` 中使用，其中 `bearer_token_file: /etc/alertmanager/secrets/callback-secret/token` 解析 `callback-secret` 挂载——CA 包使用相同的形状：

```yaml
receivers:
  - name: email-receiver
    email_configs:
      - to: ops@example.com
        from: alertmanager@example.com
        smarthost: smtp.example.internal:587
        auth_username: alertmanager@example.com
        auth_identity: alertmanager@example.com
        auth_password: <smtp-password>
        require_tls: true
        tls_config:
          ca_file: /etc/alertmanager/secrets/smtp-ca-bundle/ca.crt
```

在接收器上保持 `require_tls: true`（或省略它并依赖上游默认值），并且不要设置 `insecure_skip_verify: true`——启用跳过验证将完全绕过自定义 CA 挂载，并静默禁用证书验证，从而违背提供包的目的。

作为手动编辑渲染的 alertmanager 配置的替代方案，AlertmanagerConfig CRD (`alertmanagerconfigs.monitoring.coreos.com/v1alpha1`) 以类型字段公开相同的自定义 CA 功能。`spec.receivers[].emailConfigs[].tlsConfig.ca` 是一个带有 `{configMap, secret}` 选择器的对象——一个引用持有 PEM CA 包的 Secret + key 的 `SecretKeySelector`，而不是原始文件系统路径：

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: email-with-ca
  namespace: cpaas-system
spec:
  receivers:
    - name: email-receiver
      emailConfigs:
        - to: ops@example.com
          from: alertmanager@example.com
          smarthost: smtp.example.internal:587
          requireTLS: true
          tlsConfig:
            ca:
              secret:
                name: smtp-ca-bundle
                key: ca.crt
```

## 诊断步骤

通过跟踪 Alertmanager 容器日志确认症状；上游 Notify 路径会从 alertmanager 容器中逐字输出 x509 验证失败：

```bash
kubectl -n cpaas-system logs statefulset/alertmanager-kube-prometheus \
  -c alertmanager --tail=200 | grep -i 'x509\|certificate'
```

从调度器/通知路径中包含 `x509: certificate signed by unknown authority` 的日志行确认 SMTP smarthost 证书的颁发者不在容器信任存储中，并且需要自定义 `ca_file` 挂载。

在应用 Secret 并修补 `spec.secrets[]` 后，验证 operator 是否已将挂载连接到 Alertmanager pod 的预期路径：

```bash
kubectl -n cpaas-system get pod -l app.kubernetes.io/name=alertmanager \
  -o jsonpath='{range .items[*].spec.containers[?(@.name=="alertmanager")].volumeMounts[*]}{.mountPath}{"\n"}{end}' \
  | grep '/etc/alertmanager/secrets/'
```

输出应列出 `/etc/alertmanager/secrets/smtp-ca-bundle` 以及任何预先存在的条目，例如 `/etc/alertmanager/secrets/callback-secret`。

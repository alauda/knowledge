---
products:
  - Alauda Container Platform
kind:
  - Solution
id: KB250900006
sourceSHA: d56d9b12316a5f5614247b64ec82fbcca3306ecceaa967a9ecfd3a39ee8dbd53
---

# 如何支持 Prometheus 远程写入功能

## 环境信息

适用版本：4.0.x, 4.1.x

## 功能介绍

Prometheus 远程写入是一个功能，允许用户将指标数据远程发送到外部持久存储系统，而不是将其存储在 Prometheus 时间序列数据库中。这使得 Prometheus 数据能够与其他监控系统或存储解决方案集成，从而提供更大的灵活性和可扩展性。

## 配置方法

**前提条件**：远程写入解决方案需要第三方 Prometheus 版本 **v2.25 或更高**，并且必须修改参数以启用远程写入支持。

- 当通过 StatefulSet 直接部署 Prometheus 时：设置启动参数 `--web.enable-remote-write-receiver`。

  示例 StatefulSet 片段：

```yaml
apiVersion: apps/v1
kind: StatefulSet
spec:
  template:
    spec:
      containers:
      - name: prometheus
        args:
        - "--web.enable-remote-write-receiver"
        # ... 其他参数
```

- 当通过 Prometheus Operator 部署时：在 `prometheus.monitoring.coreos.com` 资源的 `spec` 部分添加 `enableRemoteWriteReceiver: true`。

  示例 Prometheus CR 片段：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  enableRemoteWriteReceiver: true
  # ... 其他 spec 字段
```

### 当 Prometheus 是单节点部署时，建议使用以下方法

登录到目标环境的 global 集群的主节点。
修改 minfo Prometheus 配置以添加 remoteWrite 设置：

#### 步骤 1：获取 Prometheus minfo 名称

```shell
kubectl get minfo -A | grep prometheus | grep <cluster-name>
```

#### 步骤 2：将 remoteWrite 配置添加到 minfo（将 \<minfo_name> 替换为步骤 1 中获得的名称）

```shell
kubectl edit minfo <minfo_name>
```

在 `spec` 下添加以下内容：

```yaml
spec:
  valuesOverride:
    ait/chart-kube-prometheus:
      prometheus:
        remoteWrite:
        ### 必需：第三方 Prometheus 的远程写入 URL。
        ### 此地址可以用于 Prometheus 或 VictoriaMetrics：
        ### - 对于平台监控组件 VictoriaMetrics: https://<platform-domain>/clusters/<clusters_name>/vminsert
        ### - 对于平台监控组件 Prometheus: https://<platform-domain>/clusters/<clusters_name>/prometheus-0/api/v1/write
        - url: "https://x.x.x.x/api/v1/write"
          ### 可选：写入超时（默认：30s）
          remoteTimeout: 60s
          ### 可选：URL 的 BasicAuth 配置。如果启用了身份验证，则需要在 `cpaas-system` 命名空间中创建一个 Secret。
          basicAuth:
            ### 可选：用户名。`name` 是 Secret 名称；`key` 是 Secret 中的用户名键。
            username:
              key: <username-key>
              name: <remote-secret-name>
            ### 可选：密码。`name` 是 Secret 名称；`key` 是 Secret 中的密码键。
            password:
              key: <password-key>
              name: <remote-secret-name>
          ### 可选：禁用证书验证
          tlsConfig:
            insecureSkipVerify: true
          writeRelabelConfigs:
          ### 示例：丢弃 nginx_http_connections 指标和以 kube_ 开头的指标，使用正则表达式匹配要丢弃的指标名称。可以使用多个规则进行匹配。
          - action: drop
            regex: nginx_http_connections|kube_.+
            sourceLabels:
            - __name__
          ### 示例：保留 up 指标和以 http_ 开头的指标，丢弃所有其他指标。
          - action: keep
            regex: up|http_.+
            sourceLabels:
            - __name__
          ### 示例：添加标签 `clusters="test"` 以区分数据。此标签仅添加到远程写入的数据；平台数据保持不变。
          - action: replace
            replacement: test
            targetLabel: clusters
```

### 当 Prometheus 以高可用配置部署时，建议使用以下方法：

登录到监控集群的主节点（需要配置远程写入的地方）。
修改 Prometheus 资源以添加 remoteWrite 设置。

#### 步骤 1：获取 Prometheus 资源名称。

```shell
kubectl get prometheus -A
```

#### 步骤 2：编辑 Prometheus 实例（例如，prometheus-0、prometheus-1 或 prometheus-2）

```shell
kubectl edit prometheus -n cpaas-system kube-prometheus-0
```

在 `spec` 下添加以下内容：

```yaml
spec:
  remoteWrite:
  - basicAuth:
      ### 可选：身份验证的用户名（name=secret 名称，key=username 键）
      username:
        key: <username-key>
        name: <remote-secret-name>
      ### 可选：身份验证的密码（name=secret 名称，key=password 键）
      password:
        key: <password-key>
        name: <remote-secret-name>
    ### 可选：写入超时（默认：30s）
    remoteTimeout: 60s
    ### 可选：禁用证书验证
    tlsConfig:
      insecureSkipVerify: true
    ### 必需：第三方 Prometheus 的远程写入 URL。
    ### 此地址可以用于 Prometheus 或 VictoriaMetrics：
    ### - 对于平台监控组件 VictoriaMetrics: https://<platform-domain>/clusters/<clusters_name>/vminsert
    ### - 对于平台监控组件 Prometheus: https://<platform-domain>/clusters/<clusters_name>/prometheus-0/api/v1/write
    url: https://x.x.x.x/api/v1/write
    writeRelabelConfigs:
    ### 示例：丢弃 nginx_http_connections 指标和以 kube_ 开头的指标，使用正则表达式匹配要丢弃的指标名称。可以使用多个规则进行匹配。
    - action: drop
      regex: nginx_http_connections|kube_.+
      sourceLabels:
      - __name__
    ### 示例：保留 up 指标和以 http_ 开头的指标，丢弃所有其他指标。
    - action: keep
      regex: up|http_.+
      sourceLabels:
      - __name__
    ### 示例：添加 clusters="test" 标签以区分数据（仅适用于远程写入的数据；平台数据保持不变）
    - action: replace
      replacement: test
      targetLabel: clusters
```

## 验证方法

通过查询第三方 Prometheus 的平台 Prometheus 指标进行检查。

```shell
curl -k -s -u username:password https://x.x.x.x/api/v1/query?query=up

{"status":"success","data":{xxxx}}
```

将地址、身份验证方式和指标 "up" 替换为实际值。如果结果中的响应状态为 "success"，则表示远程写入配置正常工作。

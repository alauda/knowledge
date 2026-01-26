---
products:
  - Alauda Application Services
kind:
  - Solution
id: KB260100022
sourceSHA: 8bec1f9f09de212e54bb10b455172799dcb38cf190d00bfc39fd34a841d5f73a
---

# 如何设置和更新 OpenSearch 管理员密码

> **注意**：适用版本：OpenSearch Operator \~= 2.8.x

要在创建集群时使用非默认的 `admin:admin` 管理员帐户，或在集群创建后更新管理员密码，请按照以下步骤操作。

## 1. 使用自定义密码创建 OpenSearchCluster 实例

### 1.1 创建管理员凭据 Secret

首先，创建一个包含管理员用户凭据的 Secret（例如，`admin-credentials-secret`）。此 Secret 将由 Operator 用于连接集群以进行健康检查和其他操作。

```bash
kubectl -n <namespace> create secret generic admin-credentials-secret --from-literal=username=admin --from-literal=password=admin123
```

> **注意**：
>
> - 将 `admin123` 替换为您的新密码。
> - 如果您已经创建了 `admin-credentials-secret`，请跳过此步骤。

### 1.2 生成密码哈希

在创建安全配置之前，您需要为新密码生成哈希。如果您安装了 Python 3.x，请使用以下命令（将 `admin123` 替换为您的新密码）：

```bash
python3 -c 'import bcrypt; print(bcrypt.hashpw("admin123".encode("utf-8"), bcrypt.gensalt(12, prefix=b"2a")).decode("utf-8"))'
```

### 1.3 创建安全配置 Secret

创建一个包含 `internal_users.yml` 的 Secret（例如，`securityconfig-secret`）。确保 `internal_users.yml` 中的 `hash` 字段与 `admin-credentials-secret` 中的密码匹配。**强烈建议保留 `kibanaserver` 用户**，因为它是 OpenSearch Dashboards 正常运行所必需的。

示例 `internal_users.yml` 内容：

```yaml
_meta:
  type: "internalusers"
  config_version: 2
admin:
  hash: "$2y$12$lJsHWchewGVcGlYgE3js/O4bkTZynETyXChAITarCHLz8cuaueIyq" # 用前一步生成的哈希替换
  reserved: true
  backend_roles:
  - "admin"
  description: "演示管理员用户"
kibanaserver:
  hash: "$2y$12$7N9cKpE4qvVvFQkHh8q6yeTqF5qYzGZQeO9Tn3lYp7dS5h3bC2u3a" # 建议为 kibanaserver 设置一个单独的复杂密码；这只是一个示例
  reserved: true
  description: "演示 kibanaserver 用户"
```

使用 `kubectl` 创建 Secret：

```bash
kubectl -n <namespace> create secret generic securityconfig-secret --from-file=internal_users.yml
```

### 1.4 配置 OpenSearch Dashboards 用户

默认情况下，OpenSearch Dashboards 可能配置为使用 `admin` 用户（不建议在生产环境中使用）。为了安全起见，配置 Dashboards 使用专用的 `kibanaserver` 用户。

创建一个包含 Dashboards 凭据的 Secret（例如，`dashboards-credentials-secret`）：

```bash
kubectl -n <namespace> create secret generic dashboards-credentials-secret --from-literal=username=kibanaserver --from-literal=password=admin123
```

> **注意**：
>
> - 将 `admin123` 替换为您的新密码。
> - 如果您已经创建了 `dashboards-credentials-secret`，请跳过此步骤。

### 1.5 配置 OpenSearch 集群规格

最后，在您的 `OpenSearchCluster` CR 中引用上述 Secrets：

```yaml
spec:
  security:
    config:
      adminCredentialsSecret:
        name: admin-credentials-secret # Operator 使用的管理员凭据 Secret
      securityConfigSecret:
        name: securityconfig-secret # 包含自定义安全配置的 Secret
    tls:
      transport:
        generate: true
      http:
        generate: true
  dashboards:
    enable: true
    opensearchCredentialsSecret:
      name: dashboards-credentials-secret # Dashboards 用于连接 OpenSearch 的凭据
```

## 2. 更新实例密码（当自定义密码已配置时）

:::warning 适用场景
以下步骤仅适用于在 OpenSearch 集群创建期间配置了自定义密码的情况。
:::

在集群创建后更改管理员密码时，您必须**同时更新两个 Secrets**。

:::warning 重要

**您必须更新 `securityconfig-secret` 和 `admin-credentials-secret`！** 如果您只更新其中一个，OpenSearch Operator 将无法连接到集群，导致健康检查失败和管理功能不可用。

> 如果您仅修改了 `securityconfig-secret`，实例中的所有 pod 将进入 `0/1` 状态。在这种情况下，请还原更改并等待实例恢复到 `green` 状态后再尝试。

:::

1. **更新 `securityconfig-secret`**

   - 生成新密码哈希。
   - 修改 Secret 中的 `internal_users.yml` 以更新 `hash` 字段。
   - 如果您还更改了 `kibanaserver` 密码，请在此时更新。

   ```bash
   kubectl -n <namespace> create secret generic securityconfig-secret --from-file=internal_users.yml --dry-run=client -o yaml | kubectl apply -f -
   ```

2. **更新 `admin-credentials-secret`**

   - 将 Secret 中的 `password` 字段更新为新密码（Base64 编码）。

   ```bash
   kubectl -n <namespace> create secret generic admin-credentials-secret --from-literal=username=admin --from-literal=password=<newpassword> --dry-run=client -o yaml | kubectl apply -f -
   ```

3. **更新 `dashboards-credentials-secret`（如果更改了 kibanaserver 密码）**

   - 如果您在第 1 步中修改了 `kibanaserver` 密码，请确保也更新此 Secret，否则 Dashboards 将无法连接。

   ```bash
   kubectl -n <namespace> create secret generic dashboards-credentials-secret --from-literal=username=kibanaserver --from-literal=password=<newpassword> --dry-run=client -o yaml | kubectl apply -f -
   ```

> **注意**：在更新相关 Secrets 后，Operator 将启动一个 Job 来应用新的安全配置。OpenSearch pods 不会重启。

## 3. 更新实例密码（当未配置自定义密码时）

:::warning 适用场景

以下步骤仅适用于在 OpenSearch 集群创建期间未配置自定义密码的情况（即，`admin` 帐户密码为 `admin`）。

:::

### 3.1 创建管理员凭据 Secret

创建一个包含管理员用户凭据的 Secret（例如，`admin-credentials-secret`）。此 Secret 将由 Operator 用于连接集群以进行健康检查和其他操作。

```bash
kubectl -n <namespace> create secret generic admin-credentials-secret --from-literal=username=admin --from-literal=password=admin123
```

### 3.2 生成密码哈希

在创建安全配置之前，您需要为新密码生成哈希。如果您安装了 Python 3.x，请使用以下命令（将 `admin123` 替换为您的新密码）：

```bash
python3 -c 'import bcrypt; print(bcrypt.hashpw("admin123".encode("utf-8"), bcrypt.gensalt(12, prefix=b"2a")).decode("utf-8"))'
```

### 3.3 创建安全配置 Secret

从正在运行的 OpenSearch 实例 Pod 中导出 `internal_users.yml` 文件。

```bash
kubectl -n <namespace> exec <instance-name>-masters-0 -- cat config/opensearch-security/internal_users.yml > internal_users.yml
```

修改 `internal_users.yml` 文件中的 `hash` 字段以更新 `admin` 用户的密码。然后创建 Secret：

```bash
kubectl -n <namespace> create secret generic securityconfig-secret --from-file=internal_users.yml
```

### 3.4 配置 OpenSearch 集群规格

最后，在您的 `OpenSearchCluster` CR 中引用上述 Secrets：

```yaml
spec:
  security:
    config:
      adminCredentialsSecret:
        name: admin-credentials-secret # Operator 使用的管理员凭据 Secret
      securityConfigSecret:
        name: securityconfig-secret # 包含自定义安全配置的 Secret
    tls:
      transport:
        generate: true
      http:
        generate: true
```

> **注意**：在更新 OpenSearchCluster CR 后，Operator 将启动一个 Job 来应用新的安全配置，OpenSearch 实例 pods 将执行滚动重启。

## 附录：OpenSearch 内置用户参考

OpenSearch 安全插件包括几个内置的内部用户。在默认配置（演示配置）中，**这些用户的默认密码通常与其用户名相同**。

| 用户名                | 目的                                                                                                                                                                     | 默认角色               |
| :-------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------- |
| **`admin`**           | **超级管理员**。拥有进行操作和管理的完整集群权限。                                                                                                                    | `admin`                 |
| **`kibanaserver`**    | **OpenSearch Dashboards 服务帐户**。由 Dashboards 用于连接 OpenSearch 和管理系统索引（例如，`.kibana`）。**无法用于登录 UI**。 | `kibana_server`         |
| **`kibanaro`**        | **Dashboards 只读用户**。具有只读权限的演示用户，无法修改数据或配置。                                                                                                  | `kibanauser`, `readall` |
| **`logstash`**        | **数据摄取用户**。通常与 Logstash 一起使用，具有写入权限。                                                                                                             | `logstash`              |
| **`readall`**         | **全局只读用户**。有权限查看所有索引数据，但无法修改。                                                                                                               | `readall`               |
| **`snapshotrestore`** | **备份和恢复用户**。专门用于执行快照和恢复操作。                                                                                                                       | `snapshotrestore`       |
| **`anomalyadmin`**    | **异常检测管理员**。用于管理 OpenSearch 异常检测插件功能的管理员用户。                                                                                                 | `anomaly_full_access`   |

:::warning 安全警告

**在生产环境中请勿使用默认密码！**

- 您**必须更改** `admin` 和 `kibanaserver` 的密码。
- 对于其他未使用的内置用户（如 `logstash`、`kibanaro` 等），建议在 `internal_users.yml` 中**删除**或**禁用**它们，或者至少将其更改为强密码以防止潜在的安全风险。

:::

## 参考文献

1. [自定义管理员用户](https://github.com/opensearch-project/opensearch-k8s-operator/blob/v2.8.0/docs/userguide/main.md#custom-admin-user)
2. [用户和角色管理](https://github.com/opensearch-project/opensearch-k8s-operator/blob/v2.8.0/docs/userguide/main.md#user-and-role-management)

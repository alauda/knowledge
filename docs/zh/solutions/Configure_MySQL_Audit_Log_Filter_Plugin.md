---
kind:
  - How To
products:
  - Alauda Application Services
ProductsVersion:
  - '4.0,4.1,4.2,4.3'
id: KB260515006
sourceSHA: c621ed5279ff9356ab27c16302a883875ae15b1b85d088bb4d1e612ef50e9b77
---

# 配置 MySQL 审计日志过滤插件

## 问题

您需要捕获 MySQL 8.0 实例上的连接事件、DDL 和 DML 的审计记录。MySQL Community Server 不提供 MySQL Enterprise 的专有 `audit_log.so` 插件，但 Percona Server 提供了一个可替代的插件 `audit_log_filter.so`，该插件会生成每个事件的 JSON 记录并支持事件类过滤。此操作指南在 `Mysql` CR 管理的实例上启用该插件，定义合理的默认过滤器集，并验证输出。

## 环境

- Alauda 原生应用服务 4.0 及更高版本
- MySQL Server 8.0.36 或更高版本（该插件需要此最低补丁级别）
- 通过 `kubectl` 访问集群

> 该插件作为 MySQL 8.0 中的预览功能提供，并在 MySQL 8.4 中正式可用。将其视为审计管道的功能稳定版本，但请注意在小版本发布之间可能会有变量名称的细微更改。

## 解决方案

### 1. 通过 `Mysql` CR 加载插件

在 `spec.params.mysql.mysqld` 下设置插件及其配置变量。使用 `loose_` 前缀的变量，以便在插件尚未加载时服务器不会拒绝启动：

```yaml
spec:
  params:
    mysql:
      mysqld:
        plugin_load_add: "audit_log_filter.so"
        loose_audit_log_filter_format: "JSON"
        loose_audit_log_filter_rotate_on_size: "104857600"
```

变量含义：

- `plugin_load_add` — 在启动时额外加载指定的插件。
- `loose_audit_log_filter_format` — 输出格式。推荐使用 `JSON` 以便后续解析。
- `loose_audit_log_filter_rotate_on_size` — 文件轮换大小（以字节为单位，此处为 100 MiB）。该插件默认保留最多 1 GiB 的轮换历史。

完整变量参考：[Percona 审计日志过滤变量](https://docs.percona.com/percona-server/8.0/audit-log-filter-variables.html)。

应用更改。操作员会对 MySQL Pod 执行滚动重启。

### 2. 验证插件是否已加载

在滚动重启完成后，连接到读写服务并检查插件状态及其变量：

```sql
SELECT PLUGIN_NAME, PLUGIN_STATUS
FROM information_schema.PLUGINS
WHERE PLUGIN_NAME LIKE '%audit%'\G

SHOW GLOBAL VARIABLES LIKE 'audit_log_filter%';
```

确认 `AUDIT_LOG_FILTER` 为 `ACTIVE`，并且变量值与您应用的 YAML 匹配。

### 3. 初始化插件

该插件提供一个初始化脚本，用于在 `mysql` 系统架构中创建其过滤器表。对读写端点运行一次：

```bash
mysql -h <cluster>-read-write -uroot -p \
  < /usr/share/percona-server/audit_log_filter_linux_install.sql
```

在提示时输入 root 密码。

### 4. 定义并附加过滤器

连接到读写端点并创建两个过滤器：

- `quiet` 用于操作员的健康检查和管理用户，以避免用无操作查询淹没日志。
- `default` 用于其他所有用户，记录连接/断开事件、一般语句和写入侧表访问。

在读写端点上运行以下命令：

```sql
SET @quiet = '
{
  "filter": {
    "class": [
      {
        "name": "table_access",
        "event": [
          { "name": "insert" },
          { "name": "delete" },
          { "name": "update" }
        ]
      }
    ]
  }
}';

SELECT audit_log_filter_set_filter('quiet', @quiet);
SELECT audit_log_filter_set_user('exporter@localhost',      'quiet');
SELECT audit_log_filter_set_user('manage@localhost',        'quiet');
SELECT audit_log_filter_set_user('healthchecker@localhost', 'quiet');

SET @default = '
{
  "filter": {
    "class": [
      {
        "name": "connection",
        "event": [
          { "name": "connect" },
          { "name": "disconnect" }
        ]
      },
      { "name": "general" },
      {
        "name": "table_access",
        "event": [
          { "name": "insert" },
          { "name": "delete" },
          { "name": "update" }
        ]
      }
    ]
  }
}';

SELECT audit_log_filter_set_filter('default', @default);
SELECT audit_log_filter_set_user('%', 'default');
```

根据您实际需要的审计范围调整过滤器 JSON。完整架构在 [审计日志过滤器定义](https://dev.mysql.com/doc/refman/8.4/en/audit-log-filter-definitions.html) 中有文档说明。

### 5. 分离或删除过滤器

从用户中分离过滤器（`%` 匹配所有未配置的用户；替换为实际的 `user@host` 以分离单个账户）：

```sql
SELECT audit_log_filter_remove_user('%');
```

删除过滤器定义：

```sql
SELECT audit_log_filter_remove_filter('default');
```

### 6. 检查审计日志文件

审计日志文件与 MySQL 数据目录一起位于每个 MySQL Pod 内。列出给定 Pod 上的文件：

```bash
kubectl -n <namespace> exec -it <pod> -c mysql -- \
  ls -lh /var/lib/mysql/audit_filter*
```

每个轮换的文件都是 JSON 行格式，准备发送到日志聚合器。

---
kind:
  - How To
products:
  - Alauda Application Services
ProductsVersion:
  - '4.0,4.1,4.2,4.3'
id: KB260515003
sourceSHA: 57f34513886c3cd99243a340ffbfe5bfc9cc80bdd45c3198400909acc31bd07c
---

# 配置 MySQL 连接控制插件以实现失败登录锁定

## 问题

默认情况下，MySQL 允许对任何账户进行无限次的密码重试。为了减轻暴力攻击，操作员通常需要在配置的连续失败登录尝试次数后引入逐步延迟。本指南将启用在 Alauda 原生应用服务管理的 MySQL 8.0 实例（组复制拓扑）上的上游 `CONNECTION_CONTROL` 插件，并验证其限流行为。

> 该插件适用于 MGR，因为路由器执行透明的 L4 路由并保留原始 MySQL 握手。该插件在 ProxySQL 前端的 Percona XtraDB Cluster (PXC) 部署后无效，因为 ProxySQL 终止并重新包装身份验证交换。

## 环境

- Alauda 原生应用服务 for MySQL 4.0 及更高版本
- 由 `Mysql` CR 支持的 MySQL 组复制 (MGR) 实例
- 通过 `kubectl` 访问集群

## 解决方案

### 1. 插件变量

该插件公开了三个变量，用于控制在连续失败连接尝试后应用的延迟：

| 变量                                              | 默认值           | 描述                                                                                                                         |
| ------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `connection_control_failed_connections_threshold` | `3`              | 连续失败尝试的次数，在达到该次数后开始延迟。`0` 禁用该功能。范围：`0`–`2147483647`。                                       |
| `connection_control_min_connection_delay`         | `1000` 毫秒     | 在达到阈值后，服务器对失败尝试的响应之前添加的最小延迟。范围：`1000`–`2147483647`。                                       |
| `connection_control_max_connection_delay`         | `2147483647` 毫秒 | 延迟的上限。范围：`1000`–`2147483647`。                                                                                     |

### 2. 通过 `Mysql` CR 启用插件

编辑 MGR 实例的 YAML，并在 `spec.params.mysql.mysqld` 下添加插件条目。以下示例在 5 次失败尝试后锁定账户，并将每次后续失败保持至少 5 分钟（300,000 毫秒）：

```yaml
spec:
  params:
    mysql:
      mysqld:
        plugin_load_add: "connection_control.so"
        connection_control_failed_connections_threshold: "5"
        connection_control_min_connection_delay: "300000"
```

应用更改。操作员执行 MGR pod 的滚动重启以加载插件。

### 3. 验证插件是否激活

滚动重启完成后，进入路由器 pod 并连接到只读服务：

```bash
kubectl -n <namespace> get svc | grep <instance>-read
# 注意 <instance>-read-only 的 cluster-ip，并将其用作连接主机。

kubectl -n <namespace> exec -it <instance>-router-<hash> -c router -- bash
mysql -uroot -h <read-only-svc-ip> -P 3306 -p"$MYSQL_PASSWORD"
```

检查插件状态和当前变量：

```sql
SELECT PLUGIN_NAME, PLUGIN_STATUS
FROM information_schema.plugins
WHERE PLUGIN_NAME LIKE 'CONNECTION%';

SHOW VARIABLES LIKE 'connection_control%';
```

预期输出：

```
+------------------------------------------+---------------+
| PLUGIN_NAME                              | PLUGIN_STATUS |
+------------------------------------------+---------------+
| CONNECTION_CONTROL                       | ACTIVE        |
| CONNECTION_CONTROL_FAILED_LOGIN_ATTEMPTS | ACTIVE        |
+------------------------------------------+---------------+

+-------------------------------------------------+------------+
| Variable_name                                   | Value      |
+-------------------------------------------------+------------+
| connection_control_failed_connections_threshold | 5          |
| connection_control_max_connection_delay         | 2147483647 |
| connection_control_min_connection_delay         | 300000     |
+-------------------------------------------------+------------+
```

### 4. 验证锁定行为

使用故意错误的密码触发多个失败登录，并记录每次尝试的时间。一旦超过阈值，连接时间应增加：

```bash
for i in $(seq 1 8); do
  time mysql -uroot -h <read-only-svc-ip> -P 3306 -p"wrongpass" -e "SELECT 1" || true
done
```

从任何会话检查每个账户的失败尝试计数器：

```sql
SELECT *
FROM performance_schema.connection_control_failed_login_attempts;
```

每一行显示用户/主机对及其当前持有的连续失败次数。成功登录将重置该对的计数器。

### 5. 回滚

要禁用锁定，请从 `spec.params.mysql.mysqld` 中删除 `plugin_load_add` 和 `connection_control_*` 条目，并重新应用 CR。操作员重启 pods，插件将不再加载。

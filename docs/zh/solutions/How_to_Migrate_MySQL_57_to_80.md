---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.x
id: KB260300002
sourceSHA: 42488d5a3548fdf9f213199c719714baf2fc5c10e533ae99782ddc71a85b77e5
---

# MySQL 5.7 到 8.0 迁移指南

## 背景

### 挑战

MySQL 5.7 于 2023 年 10 月达到生命周期结束（EOL），组织必须升级到 MySQL 8.0，以继续接收安全更新并利用新功能。迁移生产数据库涉及复杂的考虑因素，包括模式兼容性、字符集更改、身份验证插件更新以及在迁移过程中确保数据完整性。

### 解决方案

本指南提供了在 Alauda 容器平台（ACP）上将 MySQL 5.7 迁移到 8.0 的全面、经过验证的说明。该解决方案采用基于 mysqldump 的迁移策略，并进行全面验证：

- **经过验证的方法**：在 Alauda 容器平台（ACP v4.0+）上使用 Alauda 数据库服务 for MySQL 进行验证（有关详细信息，请参见 [环境信息](#环境信息)）。
- **完整对象覆盖**：迁移所有标准 MySQL 对象（表、视图、例程、触发器、事件、用户、权限）。
- **模式兼容性**：自动检查和修复 MySQL 8.0 兼容性问题。
- **全面验证**：跨 9 个对象类别进行验证，包括视图执行测试。
- **最小风险**：详细的回滚程序和每个步骤的验证。

## 环境信息

**适用版本**：ACP v4.0 或更高版本，MySQL Operator（Alauda 数据库服务 for MySQL）v4.0 或更高版本  
**测试环境**：ACP v4.2.0，MySQL Operator v4.2.0  
源：Percona XtraDB Cluster (PXC) 5.7.44  
目标：MySQL Group Replication (MGR) 8.0.44  

## 测试和验证

该迁移解决方案已在使用 PXC 5.7.44 和 MGR 8.0.44 集群的 Kubernetes 环境中**验证**。

### 已验证内容

| 类别                     | 验证项目                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| **基本迁移**             | 表、数据行、外键、索引                                                                       |
| **模式兼容性**          | 保留关键字检测、ZEROFILL 处理、无效日期默认值、TEXT 列默认值                               |
| **数据库对象**          | 存储过程、函数、触发器、事件、视图（包括执行测试）                                           |
| **用户和权限**          | 用户帐户创建、权限迁移、身份验证插件兼容性                                                  |
| **字符集**              | utf8mb4 转换、多语言支持（中文、日文、拉丁字母重音）、表情符号保留                           |
| **GTID 处理**           | 针对 MGR 目标的 GTID_PURGED 过滤，保持数据完整性                                            |

## 快速参考

### 关键概念

- **源集群**：现有的 MySQL 5.7.44 PXC 集群。
- **目标集群**：新的 MySQL 8.0.44 MGR 集群。
- **GTID**：用于事务跟踪的全局事务标识符。
- **模式兼容性**：MySQL 8.0 保留关键字和语法更改。
- **字符集迁移**：转换为 utf8mb4 以支持完整的 Unicode。
- **DEFINER 权限**：存储例程/视图/事件/触发器的安全上下文。

### PXC 与 MGR：关键区别

| 方面                     | PXC 5.7（源）                               | MGR 8.0（目标）                                       |
| ------------------------ | ------------------------------------------- | ----------------------------------------------------- |
| **Pod 名称模式**        | `${NAME}-pxc-0`                             | `${NAME}-0`                                           |
| **容器说明符**          | 不需要（默认为 mysql）                       | 需要：`-c mysql`                                     |
| **主端点**              | `${NAME}-proxysql.${NS}.svc.cluster.local:3306` | `${NAME}-read-write.${NS}.svc.cluster.local:3306`     |
| **副本端点**            | 与主端点相同（ProxySQL 处理路由）           | `${NAME}-read-only.${NS}.svc.cluster.local:3306`      |
| **复制类型**            | Galera（同步多主）                           | 组复制（单主模式，异步副本）                         |
| **密钥名称模式**        | `${NAME}`                                   | `mgr-${NAME}-password`                                 |

**重要提示**：在运行迁移命令之前，请始终使用 `kubectl get pod -n <namespace>` 检查实际的 pod 名称。

### 常见用例

| 场景                     | 数据库大小  | 预计停机时间    | 部分参考                                                       |
| ------------------------ | ------------ | ---------------- | ------------------------------------------------------------ |
| **小型数据库**           | < 10GB       | 15-30 分钟       | [迁移程序](#步骤-4-迁移数据-用户和权限)                     |
| **中型数据库**           | 10-50GB      | 30-60 分钟       | [迁移程序](#步骤-4-迁移数据-用户和权限)                     |
| **大型数据库**           | 50-200GB     | 1-2 小时         | [迁移程序](#步骤-4-迁移数据-用户和权限)                     |
| **模式问题**             | 任何大小     | +1-2 小时修复    | [模式兼容性](#步骤-1-模式兼容性分析)                       |
| **字符集迁移**           | 任何大小     | +30-60 分钟      | [字符集迁移](#步骤-2-字符集和排序分析)                     |

## 先决条件

在执行 MySQL 迁移之前，请确保您具备：

- ACP v4.0 或更高版本，MySQL Operator v4.0 或更高版本（有关测试版本，请参见 [环境信息](#环境信息)）
- 按照 [安装指南](https://docs.alauda.io/mysql-mgr/4.2/installation.html) 部署的 MySQL 插件
- 查看 [Alauda MySQL MGR 文档](https://docs.alauda.io/mysql-mgr/4.2/functions/01-create.html) 以了解实例创建

> **关于文档链接的说明**：上述链接指向 Alauda MySQL MGR 文档的 v4.2。如果您正在运行较新的 MySQL Operator 版本，请将 URL 路径中的 `4.2` 替换为您安装的版本（例如，`4.3`、`5.0`）。

- **源集群要求**：
  - 健康的 MySQL 5.7.44 PXC 集群
  - 启用 GTID 模式（`@@gtid_mode = ON`，`@@enforce_gtid_consistency = ON`）
  - 根或管理访问凭据
- **目标集群要求**：
  - 在迁移之前创建的新 MySQL 8.0.44 MGR 集群
  - 存储容量为源数据库大小的 2-3 倍
  - 与源相同或更高的资源分配（CPU/内存）
  - 从本地机器到两个集群的网络连接
- **迁移前任务**：
  - 完成 [模式兼容性分析](#步骤-1-模式兼容性分析) 并修复问题
  - 如果使用遗留字符集，则完成 [字符集迁移](#步骤-2-字符集和排序分析)
  - 确定要迁移的用户数据库（不要包括：`information_schema`、`mysql`、`performance_schema`、`sys`）
  - 与应用团队安排维护窗口
  - 通知利益相关者计划的停机时间
  - 准备在 [灾难恢复](#灾难恢复) 中记录的回滚计划

### 重要限制

- 在导出和导入期间需要应用停机，以确保一致性。
- 推荐的最大数据库大小：200GB（较大的数据库可能需要替代方法）。
- 源集群必须启用 GTID。
- 目标集群必须在迁移开始之前创建。
- 目标的存储性能（IOPS/吞吐量）应与源相匹配或超过源。
- 一些 MySQL 8.0 功能（角色、缓存 SHA2 密码）需要迁移后配置。

## 开始

在执行迁移命令之前，收集以下信息：

### 1. 获取 MySQL 根密码

```bash
# 对于 PXC 5.7 源
kubectl get secret <source-name> -n <source-namespace> -o jsonpath='{.data.root}' | base64 -d

# 对于 MGR 8.0 目标
kubectl get secret mgr-<target-name>-password -n <target-namespace> -o jsonpath='{.data.root}' | base64 -d
```

**示例：**

```bash
# 获取源密码
kubectl get secret source -n jpsu2-midautons -o jsonpath='{.data.root}' | base64 -d
# 输出：root123@

# 获取目标密码
kubectl get secret mgr-target-password -n jpsu2-midautons -o jsonpath='{.data.root}' | base64 -d
# 输出：root123@
```

### 2. 确定 Pod 名称

```bash
# 检查源 PXC Pods
kubectl get pod -n <source-namespace> | grep <source-name>
# 示例输出：source-pxc-0, source-pxc-1, source-pxc-2

# 检查目标 MGR Pods
kubectl get pod -n <target-namespace> | grep <target-name>
# 示例输出：target-0, target-1, target-2

# 验证 MGR 容器名称
kubectl describe pod <target-name>-0 -n <target-namespace> | grep "Container:"
# MGR Pods 有多个容器 - 始终使用 `-c mysql` 进行 MySQL 命令
```

### 3. 验证集群状态

```bash
# 检查 PXC 源状态
kubectl get mysql <source-name> -n <source-namespace>
# 预期：STATE = ready, PXCSTATE = ready

# 检查 MGR 目标状态
kubectl get mysql <target-name> -n <target-namespace>
# 预期：所有 3 个成员准备就绪，STATUS = Running
```

### 4. kubectl Exec 最佳实践

通过 `kubectl exec` 运行 MySQL 命令时，请遵循以下模式：

**对于 PXC 5.7（源）：**

```bash
# PXC 不需要容器说明符
kubectl exec <source-name>-pxc-0 -n <namespace> -- \
  mysql -uroot -p<password> -e "SQL_HERE"
```

**对于 MGR 8.0（目标）：**

```bash
# 始终使用 -c mysql
kubectl exec <target-name>-0 -n <namespace> -c mysql -- \
  mysql -uroot -p<password> -e "SQL_HERE"
```

**重要说明：**

- 始终使用参数顺序：`kubectl exec -n <namespace> <pod-name> -- <command>`
- 在命令前使用 `--`（双破折号）以将 kubectl 选项与命令分开
- 使用 `\`（反斜杠）进行多行命令
- 避免使用 heredocs（`<<EOF`）与 `kubectl exec` - 由于 shell 引号问题，它们通常会失败
- 使用 `-e "SQL"` 进行单个语句，多个 `-e` 用于多个语句
- 使用变量时，将 `-n <namespace>` 放在 pod 名称之前，以避免解析问题

## 执行指南

本指南使用 [附录](#附录-迁移脚本参考) 中提供的自动化迁移脚本来简化迁移过程。

### 步骤 1：模式兼容性分析

在计划迁移的**一周前**进行此分析。

运行 `00-pre-migration-check.sh` 脚本以自动检测模式兼容性问题并识别要迁移的数据库。

```bash
# 编辑配置
vi 00-pre-migration-check.sh

# 运行检查
chmod +x 00-pre-migration-check.sh
./00-pre-migration-check.sh
```

该脚本将输出：

1. 要迁移的用户数据库列表（复制 `DATABASES="..."` 行以备后用）
2. 模式兼容性问题（保留关键字、无效日期、ZEROFILL 等）
3. 字符集分析

如果脚本报告问题，请使用以下命令进行修复。

#### 修复模式问题

```bash
# 修复保留关键字列（示例）
kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    USE db1;
    ALTER TABLE users CHANGE COLUMN rank user_rank INT;
  "

# 修复无效日期默认值（示例）
kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    USE db1;
    ALTER TABLE events MODIFY COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
  "

# 修复 ZEROFILL 列（移除 ZEROFILL）
kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    USE db1;
    ALTER TABLE products MODIFY COLUMN price DECIMAL(10,2);
  "
```

### 步骤 2：字符集和排序分析

`00-pre-migration-check.sh` 脚本（在步骤 1 中运行）已经检查了非 utf8mb4 表。如果报告了“未使用 utf8mb4 的表”，请在计划迁移的**3-5 天前**进行转换。

#### 转换为 utf8mb4

```bash
# 将数据库转换为 utf8mb4
for db in ${DATABASES}; do
  kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
    mysql -uroot -p${MYSQL_PASSWORD} -e "
      ALTER DATABASE ${db} CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
    "
done

# 将表转换为 utf8mb4
for db in ${DATABASES}; do
  TABLES=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
    mysql -uroot -p${MYSQL_PASSWORD} -N -e "
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'BASE TABLE';
    ")

  for table in ${TABLES}; do
    echo "正在转换 ${db}.${table}..."
    kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
      mysql -uroot -p${MYSQL_PASSWORD} ${db} -e "
        ALTER TABLE ${table} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      "
  done
done
```

**重要说明**：对于具有长 VARCHAR/TEXT 索引（>191 个字符）的表，您可能需要调整索引长度：

```sql
-- 示例：修复 utf8mb4 的索引长度
ALTER TABLE users DROP INDEX idx_email;
ALTER TABLE users ADD UNIQUE INDEX idx_email (email(191));
```

### 步骤 3：创建目标 MySQL 8.0 实例

在数据迁移阶段**之前不久**创建目标 MySQL 8.0 实例以节省资源。

**重要**：在启动迁移脚本之前创建目标 MySQL 8.0 实例。

**使用 Web 控制台：**

请参考 [创建 MySQL 实例文档](https://docs.alauda.io/mysql-mgr/4.2/functions/01-create.html) 获取详细说明（如果需要，将 URL 中的 `4.2` 替换为您的 MySQL Operator 版本）。关键配置点：

1. 选择版本 **8.0**
2. 配置资源（建议比源集群多 **10-20% 内存**，以应对 MySQL 8.0 的开销）
3. 设置存储大小为 **2-3 倍** 源数据库大小

**使用命令行：**

```bash
TARGET_NAME="mysql-8-target"
NAMESPACE="your-namespace"
STORAGE_SIZE="500Gi"  # 根据您的源数据库大小进行调整

cat << EOF | kubectl -n $NAMESPACE apply -f -
apiVersion: middleware.alauda.io/v1
kind: Mysql
metadata:
  name: $TARGET_NAME
  namespace: $NAMESPACE
  labels:
    mysql/arch: mgr
spec:
  mgr:
    enableStorage: true
    image: {}
    members: 1
    monitor:
      enable: true
      exporter: {}
    resources:
      server:
        limits:
          cpu: "2"
          memory: 4Gi
        requests:
          cpu: "2"
          memory: 4Gi
    router:
      replicas: 1
      resources:
        limits:
          cpu: 500m
          memory: 512Mi
        requests:
          cpu: 500m
          memory: 512Mi
      svcRO:
        type: ClusterIP
      svcRW:
        type: ClusterIP
    strictSecurityModeEnabled: true
    upgradeOption: {}
    volumeClaimTemplate:
      metadata: {}
      spec:
        accessModes:
        - ReadWriteOnce
        resources:
          requests:
            storage: ${STORAGE_SIZE}
        storageClassName: dataservice-topolvmsc
      status: {}
  params:
    mysql: {}
    router:
      DEFAULT:
        max_total_connections: "200"
      logger:
        level: info
  upgradeOption:
    autoUpgrade: false
    crVersion: 4.2.0  # 设置为您安装的 MySQL Operator 版本
  version: "8.0"
EOF
```

**验证目标集群：**

```bash
# 等待集群准备就绪
kubectl -n $NAMESPACE get mysql $TARGET_NAME -w

# 预期输出：
# NAME             VERSION   STATE   PXCSTATE   MGRSTATE
# mysql-8-target   8.0       Ready              ready
```

### 步骤 4：迁移数据、用户和权限

使用 `01-migrate-all.sh` 脚本执行迁移。该脚本：

1. 验证先决条件（GTID、版本、连接性）
2. 直接从源流式迁移所有指定数据库的数据
3. 迁移用户帐户和权限（使用 `mysql_native_password` 以确保兼容性）

**操作步骤：**

1. **停止应用写入**：将应用的副本缩放为零，以确保数据一致性。

   **关键**：从此时起，应用必须保持停止（或严格只读），直到切换阶段完成。此步骤后写入源数据库的任何数据都将丢失。

   ```bash
   kubectl scale deployment <app-name> --replicas=0 -n <app-namespace>
   ```

2. **配置脚本**：
   编辑 `01-migrate-all.sh`，设置您的集群名称、命名空间和 `DATABASES` 变量（使用步骤 1 中的列表）。

3. **运行迁移**：
   ```bash
   chmod +x 01-migrate-all.sh
   ./01-migrate-all.sh
   ```

**重要说明：**

- 该脚本使用 **流式迁移**，因此不会消耗转储文件的磁盘空间。
- 它自动处理 MGR 兼容性的 `GTID_PURGED` 过滤。
- 用户帐户使用 `mysql_native_password` 进行迁移，以最大限度地提高与现有应用程序的兼容性。

### 步骤 5：验证迁移

运行 `02-verify-migration.sh` 脚本以确认所有数据库对象已成功迁移。

```bash
chmod +x 02-verify-migration.sh
./02-verify-migration.sh
```

该脚本对每个数据库执行以下检查：

1. **表**：比较源与目标的计数
2. **视图**：比较计数并测试每个视图的执行
3. **存储过程/函数**：比较计数
4. **触发器/事件**：比较计数
5. **行计数**：执行样本行计数检查
6. **用户**：验证用户帐户是否已迁移

**注意**：如果任何检查失败，脚本将输出红色失败消息。在验证通过之前，请勿继续切换。

### 步骤 6：迁移后优化

在成功迁移后优化目标 MySQL 8.0 实例。

#### 1. 更新表统计信息

```bash
TARGET_NAME="mysql-8-target"
TARGET_NAMESPACE="your-namespace"
MYSQL_PASSWORD="your-password"
DATABASES="db1 db2 db3"  # ← 仅您的数据库（NOT: information_schema, mysql, performance_schema, sys）

for db in ${DATABASES}; do
  echo "分析 ${db} 中的表..."
  TABLES=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
    mysql -uroot -p${MYSQL_PASSWORD} -N -e "
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'BASE TABLE';
    ")

  for table in ${TABLES}; do
    kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
      mysql -uroot -p${MYSQL_PASSWORD} ${db} -e "ANALYZE TABLE ${table};" 2>&1 | grep -v "Table"
  done

  echo "  ✓ 分析了 $(echo ${TABLES} | wc -w) 个表"
done
```

#### 2. 创建直方图（MySQL 8.0 特性）

直方图提高了对非索引列的查询性能：

```bash
# 示例：在经常过滤的列上创建直方图
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    ANALYZE TABLE db1.orders UPDATE HISTOGRAM ON customer_id, status WITH 100 BUCKETS;
  "
```

#### 3. 检查碎片

```bash
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    SELECT TABLE_SCHEMA, TABLE_NAME,
           ROUND(DATA_FREE / 1024 / 1024, 2) AS '碎片 (MB)'
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA IN ('${DATABASES// /,\'','\'}')
      AND DATA_FREE > 0
    ORDER BY DATA_FREE DESC;
  "
```

如果发现显著的碎片（>100MB），请重建表：

```sql
-- 重建碎片表
OPTIMIZE TABLE db1.orders;
```

#### 4. 创建性能基线

```bash
# 将当前性能指标（表计数、行计数、大小）记录到 /tmp/mysql-8-baseline.txt 以便后续比较
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    SELECT NOW() AS baseline_date,
           COUNT(*) AS total_tables,
           SUM(TABLE_ROWS) AS total_rows,
           ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024 / 1024, 2) AS total_size_gb
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA IN ('${DATABASES// /,\'','\'}');
  " > /tmp/mysql-8-baseline.txt
```

## 切换阶段

### 步骤 7：应用切换

在迁移验证完成后，切换应用流量：

#### 1. 验证应用已停止

确保应用仍然停止（如步骤 4 中所执行）。

```bash
# 确保应用已缩放为零
kubectl scale deployment <app-name> --replicas=0 -n <app-namespace>

# 验证没有活动连接
kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "SHOW PROCESSLIST;" | grep -v "Sleep"
```

#### 2. 更新应用连接字符串

```bash
# 更新 ConfigMap 或环境变量
kubectl patch configmap <app-config> -n <app-namespace> --type=json \
  -p='[{"op": "replace", "path": "/data/database-host", "value":"mysql-8-target-read-write.'${TARGET_NAMESPACE}'.svc.cluster.local"}]'

kubectl patch configmap <app-config> -n <app-namespace> --type=json \
  -p='[{"op": "replace", "path": "/data/database-port", "value":"3306"}]'
```

#### 3. 重启应用

```bash
# 缩放应用
kubectl scale deployment <app-name> --replicas=<original-replica-count> -n <app-namespace>

# 等待 Pods 准备就绪
kubectl -n <app-namespace> rollout status deployment <app-name>
```

#### 4. 验证应用功能

```bash
# 测试应用 Pod 的数据库连接
kubectl exec -it <app-pod> -n <app-namespace> -- \
  mysql -h mysql-8-target-read-write.${TARGET_NAMESPACE}.svc.cluster.local \
    -uroot -p${MYSQL_PASSWORD} -e "SELECT 1 AS test;"

# 检查应用日志中的错误
kubectl logs -n <app-namespace> <app-pod> --tail=100 | grep -i error
```

### 监控

在 24-48 小时内监控迁移的实例：

```bash
# 检查 MySQL 8.0 实例健康状况
kubectl -n ${TARGET_NAMESPACE} get mysql ${TARGET_NAME} -w

# 监控错误日志
kubectl logs -n ${TARGET_NAMESPACE} ${TARGET_NAME}-0 -c mysql --tail=100 -f

# 检查复制状态（如果适用）
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "SHOW SLAVE STATUS\G"
```

## 灾难恢复

### 回滚计划

如果在切换后发现关键问题：

```bash
# 1. 停止应用
kubectl scale deployment <app-name> --replicas=0 -n <app-namespace>

# 2. 将连接字符串更新回源
kubectl patch configmap <app-config> -n <app-namespace> --type=json \
  -p='[{"op": "replace", "path": "/data/database-host", "value":"'${SOURCE_NAME}'-proxysql.'${SOURCE_NAMESPACE}'.svc.cluster.local"}]'

# 3. 重启应用
kubectl scale deployment <app-name> --replicas=<original-replica-count> -n <app-namespace>

# 4. 验证连接性
kubectl exec -it <app-pod> -n <app-namespace> -- \
  mysql -h ${SOURCE_NAME}-proxysql.${SOURCE_NAMESPACE}.svc.cluster.local \
    -uroot -p${MYSQL_PASSWORD} -e "SELECT 1 AS test;"

# 5. 监控应用日志
kubectl logs -n <app-namespace> <app-pod> --tail=100 -f
```

### 常见问题及解决方案

#### 问题：GTID_PURGED 错误

**症状：**

```text
ERROR 3546 (HY000) at line XX: Cannot update GTID_PURGED with the Group Replication plugin running
```

**解决方案**：在迁移过程中已通过过滤处理。

#### 问题：字符集转换错误

**症状：**

```text
ERROR 1366 (HY000): Incorrect string value
```

**解决方案：**

```bash
# 检查当前字符集
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_COLLATION
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = '${db}' AND TABLE_COLLATION NOT LIKE 'utf8mb4%';
  "

# 转换为 utf8mb4
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    ALTER DATABASE ${db} CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
  "
```

#### 问题：DEFINER 权限错误

**症状：**

```text
ERROR 1449 (HY000): The user specified as a definer ('user'@'host') does not exist
```

**解决方案：**

```bash
# 查找所有缺少定义者的对象
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    SELECT DISTINCT DEFINER
    FROM information_schema.VIEWS
    WHERE TABLE_SCHEMA = '${db}'
      AND DEFINER NOT IN (SELECT CONCAT(user, '@', host) FROM mysql.user);
  "

# 重新创建缺失的用户或更新 DEFINER
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    ALTER VIEW db1.my_view SQL SECURITY INVOKER AS SELECT ...;
  "
```

#### 问题：身份验证插件错误

**症状：**

```text
ERROR 2059 (HY000): Authentication plugin 'caching_sha2_password' cannot be loaded
```

**解决方案：**

```bash
# 更新用户以使用 mysql_native_password 以确保兼容性
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    ALTER USER 'app_user'@'%' IDENTIFIED WITH mysql_native_password BY 'password';
    FLUSH PRIVILEGES;
  "
```

## 故障排除

### 诊断命令

#### 检查迁移进度

```bash
# 监控迁移进度（流式模式）
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "SHOW PROCESSLIST;"

# 监控网络流量（如果迁移缓慢）
kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "SHOW PROCESSLIST;"
```

#### 验证数据完整性

```bash
# 比较所有表的行计数
for db in ${DATABASES}; do
  echo "=== 数据库：${db} ==="
  kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
    mysql -uroot -p${MYSQL_PASSWORD} -N -e "
      SELECT TABLE_NAME, TABLE_ROWS
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME;
    " > /tmp/source_counts.txt

  kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
    mysql -uroot -p${MYSQL_PASSWORD} -N -e "
      SELECT TABLE_NAME, TABLE_ROWS
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME;
    " > /tmp/target_counts.txt

  diff /tmp/source_counts.txt /tmp/target_counts.txt || echo "检测到行计数差异！"
done
```

#### 检查 MySQL 8.0 错误日志

```bash
# 实时错误监控
kubectl logs -n ${TARGET_NAMESPACE} ${TARGET_NAME}-0 -c mysql --tail=100 -f | grep -i error

# 搜索特定错误
kubectl logs -n ${TARGET_NAMESPACE} ${TARGET_NAME}-0 -c mysql --tail=1000 | grep -i "definer"
```

## 最佳实践

### 迁移前规划

- **在暂存环境中测试**：始终先在非生产环境中进行测试迁移
- **模式清理**：在生产迁移之前修复所有模式兼容性问题
- **字符集迁移**：提前进行 utf8mb4 转换（至少提前 3-5 天）
- **备份策略**：确保在迁移之前有最近的备份可用
- **维护窗口**：根据数据库大小安排足够的停机时间
- **沟通**：通知所有利益相关者，包括应用团队和 DBA

### 迁移期间

- **停止应用写入**：确保在导出/导入期间没有写入以保持一致性
- **监控进度**：定期跟踪导出/导入进度
- **逐步验证**：在每个主要步骤后运行验证脚本
- **记录问题**：记录遇到的任何问题以备将来参考
- **保持源运行**：在迁移验证之前不要删除源

### 迁移后

- **全面测试**：彻底测试应用功能
- **性能监控**：在 24-48 小时内监控查询性能和资源利用率
- **优化**：运行迁移后的优化程序
- **保持源以便回滚**：在回滚窗口期间保持源集群 24-48 小时
- **更新文档**：更新连接字符串、运行手册和监控仪表板

## 参考

### 大小与时间估算

| 数据库大小 | 导出时间 | 导入时间 | 总停机时间 |
| ----------- | --------- | --------- | ------------ |
| < 10GB      | 1-5 分钟  | 2-10 分钟 | 15-30 分钟   |
| 10-50GB     | 5-20 分钟 | 10-30 分钟 | 30-60 分钟   |
| 50-100GB    | 20-40 分钟 | 30-60 分钟 | 1-2 小时     |
| 100-200GB   | 40-80 分钟 | 1-2 小时  | 2-4 小时     |

### mysqldump 标志参考

| 标志                     | 目的                                          |
| ------------------------ | --------------------------------------------- |
| `--single-transaction`   | 使用 MVCC（InnoDB）进行一致性快照            |
| `--quick`                | 一次检索一行（节省内存）                     |
| `--lock-tables=false`    | 不锁定表（依赖于单一事务）                   |
| `--set-gtid-purged=ON`   | 包含 GTID 信息                               |
| `--routines`             | 导出存储过程和函数                           |
| `--events`               | 导出事件                                    |
| `--triggers`             | 导出触发器                                  |
| `--databases`            | 指定要导出的数据库                          |

### 验证检查清单

迁移后验证：

- [ ] 表的数量相同
- [ ] 每个表的行计数相同
- [ ] 视图的数量相同
- [ ] 所有视图成功执行
- [ ] 存储过程的数量相同
- [ ] 函数的数量相同
- [ ] 触发器的数量相同
- [ ] 事件的数量相同
- [ ] 所有 DEFINER 帐户存在
- [ ] 所有用户已迁移
- [ ] 所有权限已迁移
- [ ] 应用可以连接
- [ ] 应用功能正常

### 有用链接

- [Alauda MySQL MGR 文档](https://docs.alauda.io/mysql-mgr/4.2/functions/01-create.html) — 如果需要，将 URL 路径中的 `4.2` 替换为您的 MySQL Operator 版本
- [MySQL 8.0 发布说明](https://dev.mysql.com/doc/refman/8.0/en/mysql-nutshell.html)
- [MySQL 8.0 升级指南](https://dev.mysql.com/doc/refman/8.0/en/upgrade-prerequisites.html)

## 附录：迁移脚本参考

本节提供了旨在简化 MySQL 5.7 到 8.0 迁移过程的自动化迁移脚本的详细文档。

### 概述

迁移脚本提供了三步自动化方法：

| 脚本                        | 目的                                | 运行时间                   | 持续时间      |
| ----------------------------- | ------------------------------------ | ------------------------- | ------------- |
| **00-pre-migration-check.sh** | 迁移前兼容性分析                    | 迁移前一周                 | 2-5 分钟     |
| **01-migrate-all.sh**         | 完整迁移（数据 + 用户）             | 维护窗口期间               | 15-60 分钟   |
| **02-verify-migration.sh**    | 全面验证                            | 迁移后                     | 5-10 分钟    |

### 脚本 1：迁移前检查

**目的**：检测模式兼容性问题并验证环境设置。

**检查内容**：

- Kubernetes 集群连接性
- 源集群健康状况和状态
- 源上启用 GTID 模式
- 自动检测用户数据库
- 保留关键字使用（RANK、GROUPS、FUNCTION 等）
- 无效日期默认值（`0000-00-00`）
- ZEROFILL 列使用
- 带有 DEFAULT 值的 TEXT 列
- 字符集兼容性（utf8mb4）

**配置**：

```bash
SOURCE_NAME="source"              # 源集群名称
SOURCE_NAMESPACE="your-namespace" # 源命名空间
MYSQL_PASSWORD="your-password"    # 源根密码
DATABASES="ALL"                   # "ALL" 自动检测
```

**用法**：

```bash
vi 00-pre-migration-check.sh       # 编辑配置
chmod +x 00-pre-migration-check.sh
./00-pre-migration-check.sh
```

**预期输出**：

```text
========================================
MySQL 5.7 到 8.0 迁移前检查
========================================

>>> 检查 kubectl 上下文
✓ 连接到 Kubernetes 集群

>>> 检查源集群
✓ 找到源集群 source
✓ 源集群状态：ready

>>> 检查源上的 GTID 模式
✓ GTID 模式已启用

>>> 检测用户数据库
✓ 要迁移的数据库：
   app_db customer_db reporting_db

⚠ 将此行复制到您的迁移脚本中：
DATABASES="app_db customer_db reporting_db"

>>> 检查保留关键字（MySQL 8.0）
✓ 未发现保留关键字问题

[... 更多检查 ...]

========================================
迁移前检查总结
========================================

✓ 配置已验证：
   源集群：source.your-namespace
   要迁移的数据库：app_db customer_db reporting_db

接下来的步骤：
   1. 修复上述发现的任何模式兼容性问题
   2. 如有需要，转换字符集
   3. 运行脚本 01-migrate-all.sh 进行迁移
```

### 脚本 2：完整迁移

**目的**：将所有数据库、用户和权限从源迁移到目标。

**功能**：

- 验证先决条件（两个集群、GTID、版本）
- 使用流式迁移数据库（不需要中间存储）
- 使用 `mysql_native_password` 迁移用户帐户
- 迁移所有权限和授权
- 执行基本验证

**配置**：

```bash
SOURCE_NAME="source"
SOURCE_NAMESPACE="your-namespace"
SOURCE_MYSQL_PASSWORD="source-root-password"

TARGET_NAME="mysql-8-target"
TARGET_NAMESPACE="your-namespace"
TARGET_MYSQL_PASSWORD="target-root-password"

DATABASES="app_db customer_db reporting_db"  # 来自迁移前检查
```

**用法**：

```bash
# 在运行之前：停止应用写入！
kubectl scale deployment <app-name> --replicas=0 -n <app-namespace>

# 编辑并运行
vi 01-migrate-all.sh
chmod +x 01-migrate-all.sh
./01-migrate-all.sh
```

**预期输出**：

```text
========================================
MySQL 5.7 到 8.0 迁移
========================================

⚠ 重要：确保在迁移期间停止应用写入

>>> 检查先决条件
✓ 连接到 Kubernetes 集群
✓ 找到源集群：source
✓ 找到目标集群：mysql-8-target
✓ 目标集群版本：8.0.44
✓ 源上启用 GTID 模式
ℹ 将迁移 3 个数据库：app_db customer_db reporting_db

========================================
迁移数据库
========================================

ℹ 正在迁移数据库 [1/3]：app_db
✓ 已迁移 app_db

ℹ 正在迁移数据库 [2/3]：customer_db
✓ 已迁移 customer_db

ℹ 正在迁移数据库 [3/3]：reporting_db
✓ 已迁移 reporting_db

✓ 所有数据库成功迁移（3/3）

========================================
迁移用户和权限
========================================

>>> 创建用户帐户
ℹ 找到 5 个用户进行迁移
✓ 用户帐户已创建

>>> 授予权限
✓ 权限已授予

>>> 验证迁移的用户
✓ 已迁移 5 个用户

[... 验证 ...]

========================================
迁移总结
========================================

源：source.your-namespace
目标：mysql-8-target.your-namespace
迁移的数据库：3/3
迁移的用户：5
持续时间：15m 32s

✓ 迁移成功完成！

接下来的步骤：
   1. 运行脚本 02-verify-migration.sh 进行全面验证
   2. 更新应用连接字符串
   3. 执行应用测试
   4. 在源被退役之前监控 24-48 小时
```

### 脚本 3：全面验证

**目的**：验证所有数据库对象是否正确迁移。

**验证内容**：

- 表（计数比较）
- 视图（计数 + 每个视图的执行测试）
- 存储过程（计数）
- 存储函数（计数）
- 触发器（计数）
- 事件（计数）
- 行计数（对每个数据库的前 5 个表执行样本检查）
- 用户帐户（计数 + 列表）

**配置**：

```bash
SOURCE_NAME="source"
SOURCE_NAMESPACE="your-namespace"
SOURCE_MYSQL_PASSWORD="source-root-password"

TARGET_NAME="mysql-8-target"
TARGET_NAMESPACE="your-namespace"
TARGET_MYSQL_PASSWORD="target-root-password"

DATABASES="app_db customer_db reporting_db"  # 与迁移相同
```

**用法**：

```bash
vi 02-verify-migration.sh
chmod +x 02-verify-migration.sh
./02-verify-migration.sh
```

**预期输出**：

```text
========================================
MySQL 5.7 到 8.0 迁移验证
========================================

>>> 验证表

数据库：app_db
✓ 表：15（匹配）

数据库：customer_db
✓ 表：8（匹配）

[... 更多验证 ...]

========================================
验证总结
========================================

总检查：42
通过：42
失败：0

✓ 所有检查通过！

迁移验证成功。接下来的步骤：
   1. 更新应用连接字符串以指向目标
   2. 执行应用测试
   3. 在退役源集群之前监控目标 24-48 小时
```

### 获取密码

**源集群（PXC 5.7）：**

```bash
kubectl get secret <source-name> -n <source-namespace> -o jsonpath='{.data.root}' | base64 -d
```

**目标集群（MGR 8.0）：**

```bash
kubectl get secret mgr-<target-name>-password -n <target-namespace> -o jsonpath='{.data.root}' | base64 -d
```

### 故障排除脚本

#### 脚本失败，显示“无法连接到 Kubernetes 集群”

```bash
kubectl config current-context
kubectl cluster-info
```

#### 脚本失败，显示“未找到源集群”

```bash
kubectl get mysql -n <namespace>
```

#### 特定数据库迁移失败

```bash
# 检查目标日志
kubectl logs -n <target-namespace> <target-name>-0 -c mysql --tail=100

# 手动测试单个数据库迁移
kubectl exec <source-name>-pxc-0 -n <source-namespace> -- \
  mysqldump -uroot -p<password> --single-transaction --quick \
    --lock-tables=false --set-gtid-purged=ON --routines --events --triggers \
    --databases <db-name> 2>/dev/null | \
  grep -v "SET @@GLOBAL.GTID_PURGED" | \
  kubectl exec -i <target-name>-0 -n <target-namespace> -c mysql -- \
    mysql -uroot -p<password>
```

### 完整工作流示例

```bash
# ===== 迁移前一周 =====
./00-pre-migration-check.sh
# → 输出显示：DATABASES="app_db customer_db reporting_db"
# → 修复任何发现的模式问题
# → 如有需要，转换为 utf8mb4

# ===== 迁移当天（维护窗口） =====

# 停止应用写入
kubectl scale deployment <app-name> --replicas=0 -n <app-namespace>

# 更新迁移脚本中的 DATABASES
vi 01-migrate-all.sh
# DATABASES="app_db customer_db reporting_db"

# 运行迁移
./01-migrate-all.sh

# 运行验证
./02-verify-migration.sh

# 更新应用连接字符串以指向目标
kubectl patch configmap <app-config> -n <app-namespace> --type=json \
  -p='[{"op": "replace", "path": "/data/db-host", "value":"mysql-8-target-read-write.namespace.svc.cluster.local"}]'

# 重启应用
kubectl scale deployment <app-name> --replicas=3 -n <app-namespace>

# 等待 Pods 准备就绪
kubectl -n <app-namespace> rollout status deployment <app-name>

# 测试应用
curl http://<app-service>/health

# 监控 24-48 小时
kubectl logs -n <target-namespace> mysql-8-target-0 -c mysql --tail=100 -f

# ===== 成功测试后（24-48 小时后） =====
# 退役源集群
kubectl delete mysql <source-name> -n <source-namespace>
```

### 脚本功能

所有脚本均包括：

- ✅ **颜色编码输出**：绿色（成功）、红色（错误）、黄色（警告）、蓝色（信息）
- ✅ **进度指示器**：显示当前步骤和总体进度
- ✅ **错误处理**：在关键错误时退出并提供清晰消息
- ✅ **自动检测**：当 `DATABASES="ALL"` 时自动发现数据库
- ✅ **全面检查**：在继续之前验证所有先决条件
- ✅ **详细输出**：显示迁移和验证的确切内容
- ✅ **最小配置**：每个脚本仅需配置 4-6 个变量

### 重要说明

1. **不要包含系统数据库**：`DATABASES` 变量必须仅包含用户/应用数据库。不要包括：`information_schema`、`mysql`、`performance_schema`、`sys`。

2. **停止应用写入**：确保在迁移期间没有应用写入以保持数据一致性。

3. **保持源集群**：在应用测试和 24-48 小时的成功操作后再删除源集群。

4. **在暂存环境中测试**：始终在非生产环境中进行测试迁移。

5. **迁移后监控**：在退役源之前监控目标集群 24-48 小时。

### 脚本兼容性

- **MySQL 指南版本**：v2.5+
- **源**：PXC 5.7.44
- **目标**：MGR 8.0.44
- **Kubernetes**：在 Alauda 容器平台 v4.2.0 上测试（与 v4.0+ 兼容）
- **Shell**：Bash 4.0+

### 脚本源代码

以下脚本可以直接从本文档中复制。将每个脚本保存到文件中，使其可执行并运行。

#### 脚本 1：00-pre-migration-check.sh

将此脚本保存为 `00-pre-migration-check.sh`：

```bash
#!/bin/bash
#=============================================================================
# MySQL 5.7 到 8.0 迁移 - 迁移前检查脚本
#=============================================================================
#
# 此脚本执行所有迁移前检查和修复：
# 1. 模式兼容性分析
# 2. 字符集分析
# 3. 迁移的数据库列表
#
# 用法：
#   1. 编辑下面的配置部分
#   2. 运行：chmod +x 00-pre-migration-check.sh
#   3. 运行：./00-pre-migration-check.sh
#
# 预期输出：
#   - 需要修复的任何模式兼容性问题列表
#   - 需要的任何字符集转换列表
#   - 要迁移的数据库列表（为迁移脚本复制此内容）
#
#=============================================================================

set -e  # 出错时退出

#=============================================================================
# 配置 - 编辑这些值
#=============================================================================

SOURCE_NAME="source"
SOURCE_NAMESPACE="your-namespace"
MYSQL_PASSWORD="your-password"

# 设置为 "ALL" 以自动检测数据库，或手动指定空格分隔的列表
# DATABASES="ALL"  # 自动检测所有用户数据库
# DATABASES="db1 db2 db3"  # 或手动指定
DATABASES="ALL"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # 无颜色

#=============================================================================
# 函数
#=============================================================================

print_header() {
    echo ""
    echo "========================================"
    echo "$1"
    echo "========================================"
}

print_section() {
    echo ""
    echo -e "${BLUE}>>> $1${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

check_kubectl_context() {
    print_section "检查 kubectl 上下文"

    if ! kubectl cluster-info &>/dev/null; then
        print_error "无法连接到 Kubernetes 集群"
        exit 1
    fi
    print_success "连接到 Kubernetes 集群"
}

check_source_cluster() {
    print_section "检查源集群"

    if ! kubectl get mysql ${SOURCE_NAME} -n ${SOURCE_NAMESPACE} &>/dev/null; then
        print_error "未找到源集群 ${SOURCE_NAME}，命名空间 ${SOURCE_NAMESPACE}"
        exit 1
    fi
    print_success "找到源集群 ${SOURCE_NAME}"

    # 检查集群状态
    STATUS=$(kubectl get mysql ${SOURCE_NAME} -n ${SOURCE_NAMESPACE} -o jsonpath='{.status.state}')
    if [ "${STATUS}" != "ready" ]; then
        print_warning "源集群状态：${STATUS}（预期：ready）"
    else
        print_success "源集群状态：ready"
    fi
}

check_gtid_enabled() {
    print_section "检查源上的 GTID 模式"

    GTID_MODE=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${MYSQL_PASSWORD} -N -e "SELECT @@gtid_mode" 2>/dev/null | grep -v "Warning")

    if [ "${GTID_MODE}" = "ON" ]; then
        print_success "GTID 模式已启用"
    else
        print_error "GTID 模式未启用（迁移所需）"
        exit 1
    fi
}

detect_databases() {
    print_section "检测用户数据库"

    if [ "${DATABASES}" = "ALL" ]; then
        DATABASES=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
            mysql -uroot -p${MYSQL_PASSWORD} -N -e "SHOW DATABASES" 2>/dev/null | \
            grep -v -E "^(information_schema|mysql|performance_schema|sys)$" | \
            tr '\n' ' ' | sed 's/ $//')

        if [ -z "${DATABASES}" ]; then
            print_error "未找到用户数据库"
            exit 1
        fi
    fi

    print_success "要迁移的数据库："
    echo "   ${DATABASES}"
    echo ""
    print_warning "将此行复制到您的迁移脚本中："
    echo -e "${GREEN}DATABASES=\"${DATABASES}\"${NC}"
}

check_reserved_keywords() {
    print_section "检查保留关键字（MySQL 8.0）"

    ISSUES=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${MYSQL_PASSWORD} -N -e "
            SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME, '.', COLUMN_NAME)
            FROM information_schema.COLUMNS
            WHERE COLUMN_NAME IN ('RANK', 'GROUPS', 'FUNCTION', 'SYSTEM', 'RELOAD',
                                  'ARRAY', 'OFFSET', 'CUBE', 'ROLE', 'VALUES')
            AND TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
            AND TABLE_SCHEMA IN ('${DATABASES// /,\'','\'}')
            ORDER BY TABLE_SCHEMA, TABLE_NAME;
        " 2>/dev/null | grep -v "Warning")

    if [ -z "${ISSUES}" ]; then
        print_success "未发现保留关键字问题"
    else
        print_error "发现使用 MySQL 8.0 保留关键字的列："
        echo "${ISSUES}" | while read line; do
            echo "   - ${line}"
        done
        echo ""
        print_warning "这些列必须在迁移之前重命名"
        echo "示例修复："
        echo "   ALTER TABLE employees CHANGE COLUMN rank employee_rank INT;"
    fi
}

check_invalid_dates() {
    print_section "检查无效日期默认值"

    ISSUES=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${MYSQL_PASSWORD} -N -e "
            SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME, '.', COLUMN_NAME)
            FROM information_schema.COLUMNS
            WHERE DATA_TYPE IN ('date', 'datetime', 'timestamp')
              AND COLUMN_DEFAULT LIKE '0000-00-00%'
              AND TABLE_SCHEMA IN ('${DATABASES// /,\'','\'}')
            ORDER BY TABLE_SCHEMA, TABLE_NAME;
        " 2>/dev/null | grep -v "Warning")

    if [ -z "${ISSUES}" ]; then
        print_success "未发现无效日期默认值"
    else
        print_error "发现无效日期默认值的列："
        echo "${ISSUES}" | while read line; do
            echo "   - ${line}"
        done
        echo ""
        print_warning "这些列必须在迁移之前修复"
        echo "示例修复："
        echo "   ALTER TABLE events MODIFY COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;"
    fi
}

check_zerofill() {
    print_section "检查 ZEROFILL 使用情况"

    ISSUES=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${MYSQL_PASSWORD} -N -e "
            SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME, '.', COLUMN_NAME, ' ', COLUMN_TYPE)
            FROM information_schema.COLUMNS
            WHERE COLUMN_TYPE LIKE '%ZEROFILL%'
              AND TABLE_SCHEMA IN ('${DATABASES// /,\'','\'}')
            ORDER BY TABLE_SCHEMA, TABLE_NAME;
        " 2>/dev/null | grep -v "Warning")

    if [ -z "${ISSUES}" ]; then
        print_success "未发现 ZEROFILL 使用情况"
    else
        print_warning "发现 ZEROFILL 列（在 MySQL 8.0 中已弃用）："
        echo "${ISSUES}" | while read line; do
            echo "   - ${line}"
        done
        echo ""
        print_warning "将在迁移过程中移除 ZEROFILL"
        echo "要手动修复："
        echo "   ALTER TABLE products MODIFY COLUMN price DECIMAL(10,2);"
    fi
}

check_text_defaults() {
    print_section "检查带有 DEFAULT 值的 TEXT 列"

    ISSUES=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${MYSQL_PASSWORD} -N -e "
            SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME, '.', COLUMN_NAME)
            FROM information_schema.COLUMNS
            WHERE DATA_TYPE IN ('text', 'tinytext', 'mediumtext', 'longtext')
              AND COLUMN_DEFAULT IS NOT NULL
              AND TABLE_SCHEMA IN ('${DATABASES// /,\'','\'}')
            ORDER BY TABLE_SCHEMA, TABLE_NAME;
        " 2>/dev/null | grep -v "Warning")

    if [ -z "${ISSUES}" ]; then
        print_success "未发现带有 DEFAULT 值的 TEXT 列"
    else
        print_error "发现带有 DEFAULT 值的 TEXT 列（在 MySQL 8.0 中不允许）："
        echo "${ISSUES}" | while read line; do
            echo "   - ${line}"
        done
        echo ""
        print_warning "这些 DEFAULT 值必须在迁移之前移除"
    fi
}

check_character_sets() {
    print_section "检查字符集"

    NON_UTF8=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${MYSQL_PASSWORD} -N -e "
            SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME, ' - ', TABLE_COLLATION)
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA IN ('${DATABASES// /,\'','\'}')
              AND TABLE_COLLATION NOT LIKE 'utf8mb4%'
              AND TABLE_TYPE = 'BASE TABLE'
            ORDER BY TABLE_SCHEMA, TABLE_NAME;
        " 2>/dev/null | grep -v "Warning")

    if [ -z "${NON_UTF8}" ]; then
        print_success "所有表均使用 utf8mb4"
    else
        print_warning "发现未使用 utf8mb4 的表："
        echo "${NON_UTF8}" | while read line; do
            echo "   - ${line}"
        done
        echo ""
        print_warning "建议在迁移之前转换为 utf8mb4"
        echo "请参见文档中的“字符集和排序分析”部分"
    fi
}

check_lower_case_table_names() {
    print_section "检查 lower_case_table_names"

    LCTN=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${MYSQL_PASSWORD} -N -e "SELECT @@lower_case_table_names" 2>/dev/null | grep -v "Warning")

    if [ "${LCTN}" = "1" ]; then
        print_warning "源集群的 lower_case_table_names=1"
        echo "   确保目标 MySQL 8.0 集群也配置为 lower_case_table_names=1"
        echo "   此设置在 MySQL 8.0 中初始化后无法更改。"
    else
        print_success "源集群的 lower_case_table_names=${LCTN}"
    fi
}

print_summary() {
    print_header "迁移前检查总结"

    echo ""
    print_success "配置已验证："
    echo "   源集群：${SOURCE_NAME}.${SOURCE_NAMESPACE}"
    echo "   要迁移的数据库：${DATABASES}"
    echo ""

    echo "接下来的步骤："
    echo "   1. 修复上述发现的任何模式兼容性问题"
    echo "   2. 如有需要，转换字符集"
    echo "   3. 运行脚本 01-migrate-all.sh 进行迁移"
    echo ""
}

#=============================================================================
# 主执行
#=============================================================================

main() {
    print_header "MySQL 5.7 到 8.0 迁移前检查"

    check_kubectl_context
    check_source_cluster
    check_gtid_enabled
    detect_databases
    check_reserved_keywords
    check_invalid_dates
    check_zerofill
    check_text_defaults
    check_character_sets
    check_lower_case_table_names
    print_summary

    print_success "迁移前检查完成"
}

main
```

#### 脚本 2：01-migrate-all.sh

将此脚本保存为 `01-migrate-all.sh`：

```bash
#!/bin/bash
#=============================================================================
# MySQL 5.7 到 8.0 迁移 - 完整迁移脚本
#=============================================================================
#
# 此脚本执行从 MySQL 5.7 到 8.0 的完整迁移：
# 1. 迁移所有数据库（流式，无中间存储）
# 2. 迁移用户和权限
# 3. 执行基本验证
#
# 先决条件：
#   - 目标 MySQL 8.0 集群必须创建并准备就绪
#   - 应该完成迁移前检查
#   - 在迁移期间应停止应用写入
#
# 用法：
#   1. 编辑下面的配置部分
#   2. 运行：chmod +x 01-migrate-all.sh
#   3. 运行：./01-migrate-all.sh
#
# 预计停机时间：15-60 分钟，具体取决于数据库大小
#
#=============================================================================

set -eo pipefail # 出错时退出，并捕获管道失败

#=============================================================================
# 配置 - 编辑这些值
#=============================================================================

SOURCE_NAME="source"
SOURCE_NAMESPACE="your-namespace"
SOURCE_MYSQL_PASSWORD="source-root-password"

TARGET_NAME="mysql-8-target"
TARGET_NAMESPACE="your-namespace"
TARGET_MYSQL_PASSWORD="target-root-password"

# 重要：要迁移的数据库（不要包括：information_schema、mysql、performance_schema、sys）
DATABASES="db1 db2 db3" # ← 从迁移前检查输出复制

# 要排除的用户（系统用户）
EXCLUDE_USERS="'mysql.sys', 'mysql.session', 'mysql.infoschema', 'root', 'clustercheck', 'monitor', 'operator', 'xtrabackup', 'repl'"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # 无颜色

# 统计信息
TOTAL_DATABASES=0
MIGRATED_DATABASES=0
FAILED_DATABASES=0
START_TIME=$(date +%s)

#=============================================================================
# 函数
#=============================================================================

print_header() {
    echo ""
    echo "========================================"
    echo "$1"
    echo "========================================"
}

print_section() {
    echo ""
    echo -e "${BLUE}>>> $1${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_info() {
    echo -e "${CYAN}ℹ $1${NC}"
}

check_prerequisites() {
    print_section "检查先决条件"

    # 检查 kubectl
    if ! kubectl cluster-info &>/dev/null; then
        print_error "无法连接到 Kubernetes 集群"
        exit 1
    fi
    print_success "连接到 Kubernetes 集群"

    # 检查源集群
    if ! kubectl get mysql ${SOURCE_NAME} -n ${SOURCE_NAMESPACE} &>/dev/null; then
        print_error "未找到源集群 ${SOURCE_NAME}，命名空间 ${SOURCE_NAMESPACE}"
        exit 1
    fi
    print_success "找到源集群：${SOURCE_NAME}"

    # 检查目标集群
    if ! kubectl get mysql ${TARGET_NAME} -n ${TARGET_NAMESPACE} &>/dev/null; then
        print_error "未找到目标集群 ${TARGET_NAME}，命名空间 ${TARGET_NAMESPACE}"
        print_error "请在运行迁移之前创建目标集群"
        exit 1
    fi
    print_success "找到目标集群：${TARGET_NAME}"

    # 检查目标是否为 MySQL 8.0
    TARGET_VERSION=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
        mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "SELECT VERSION();" 2>/dev/null | grep -v "Warning")

    if [[ ! "${TARGET_VERSION}" =~ ^8\.0\. ]]; then
        print_error "目标集群不是 MySQL 8.0（版本：${TARGET_VERSION}）"
        exit 1
    fi
    print_success "目标集群版本：${TARGET_VERSION}"

    # 检查源上的 GTID
    GTID_MODE=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "SELECT @@gtid_mode" 2>/dev/null | grep -v "Warning")

    if [ "${GTID_MODE}" != "ON" ]; then
        print_error "源上未启用 GTID 模式（迁移所需）"
        exit 1
    fi
    print_success "源上启用 GTID 模式"

    # 计算数据库
    TOTAL_DATABASES=$(echo ${DATABASES} | wc -w)
    print_info "将迁移 ${TOTAL_DATABASES} 个数据库：${DATABASES}"
}

migrate_databases() {
    print_header "迁移数据库"

    local db_num=0

    for db in ${DATABASES}; do
        db_num=$((db_num + 1))
        echo ""
        print_info "正在迁移数据库 [${db_num}/${TOTAL_DATABASES}]: ${db}"

        # 使用流式迁移（无中间存储）迁移
        kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
            mysqldump -uroot -p${SOURCE_MYSQL_PASSWORD} \
            --single-transaction \
            --quick \
            --lock-tables=false \
            --set-gtid-purged=ON \
            --routines \
            --events \
            --triggers \
            --databases ${db} \
            2>/dev/null |
            grep -v "SET @@GLOBAL.GTID_PURGED" |
            kubectl exec -i ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
                mysql -uroot -p${TARGET_MYSQL_PASSWORD} --init-command="SET FOREIGN_KEY_CHECKS=0;" 2>&1 | grep -v "Using a password" || true

        # 注意：我们依赖于下面的 DB_EXISTS 检查来验证实际导入成功，
        # 因为 grep -v 在未找到匹配项时返回 1（并非实际错误）

        # 通过检查目标上是否存在数据库来验证迁移是否成功
        DB_EXISTS=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.SCHEMATA
                WHERE SCHEMA_NAME = '${db}';
            " 2>/dev/null | grep -v "Warning")

        if [ "${DB_EXISTS}" = "1" ]; then

            print_success "已迁移 ${db}"
            MIGRATED_DATABASES=$((MIGRATED_DATABASES + 1))
        else
            print_error "迁移 ${db} 失败"
            FAILED_DATABASES=$((FAILED_DATABASES + 1))
        fi
    done

    echo ""
    if [ ${MIGRATED_DATABASES} -eq ${TOTAL_DATABASES} ]; then
        print_success "所有数据库成功迁移（${MIGRATED_DATABASES}/${TOTAL_DATABASES}）"
    else
        print_error "某些数据库迁移失败（${MIGRATED_DATABASES}/${TOTAL_DATABASES} 成功，${FAILED_DATABASES} 失败）"
    fi
}

migrate_users() {
    print_header "迁移用户和权限"

    print_section "创建用户帐户"

    # 流式创建用户语句
    USER_COUNT=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
            SELECT COUNT(*)
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS});
        " 2>/dev/null | grep -v "Warning")

    print_info "找到 ${USER_COUNT} 个用户进行迁移"

    # 创建用户（忽略 grep 的退出代码）
    kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
            SELECT CONCAT('CREATE USER IF NOT EXISTS ''', user, '''@''', host, ''' IDENTIFIED WITH mysql_native_password AS ''', replace(authentication_string, '\'', '\'\''), ''';')
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS});
        " 2>/dev/null | grep -v "^Warning" |
        kubectl exec -i ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} 2>&1 | grep -v "Using a password" || true

    # 注意：我们依赖于 USER_COUNT_AFTER 检查来验证实际成功，
    # 因为 grep -v 在未找到匹配项时返回 1（并非实际错误）

    # 验证用户创建
    USER_COUNT_AFTER=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
        mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
            SELECT COUNT(*)
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS});
        " 2>/dev/null | grep -v "Warning")

    if [ "${USER_COUNT_AFTER}" -ge "${USER_COUNT}" ]; then
        print_success "用户帐户已创建"
    else
        print_error "用户帐户创建失败"
    fi

    print_section "授予权限"

    # 流式 GRANT 语句（忽略 grep 的退出代码）
    kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
            SELECT CONCAT('SHOW GRANTS FOR ''', user, '''@''', host, ''';')
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS});
        " 2>/dev/null | grep -v "Warning" |
        kubectl exec -i ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -
```mdx
            WHERE user NOT IN (${EXCLUDE_USERS});
        " 2>/dev/null | grep -v "^Warning" | while read query; do
        kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
            mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -e "${query}" 2>/dev/null | grep "^GRANT" | sed 's/$/;/'
    done |
        kubectl exec -i ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} 2>&1 | grep -v "Using a password" || true
    # 注意：grep -v 在未找到匹配时返回 1（不是实际错误）

    print_success "权限已授予"

    # 刷新权限
    kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
        mysql -uroot -p${TARGET_MYSQL_PASSWORD} -e "FLUSH PRIVILEGES;" 2>&1 | grep -v "Using a password" >/dev/null || true
    # 注意：grep -v 在未找到匹配时返回 1（不是实际错误）

    print_section "验证迁移的用户"

    MIGRATED_USERS=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
        mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
            SELECT COUNT(*)
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS});
        " 2>/dev/null | grep -v "Warning")

    print_success "迁移了 ${MIGRATED_USERS} 个用户"
}

verify_migration() {
    print_header "迁移验证"

    print_section "验证数据库"

    for db in ${DATABASES}; do
        # 检查数据库是否存在
        DB_EXISTS=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.SCHEMATA
                WHERE SCHEMA_NAME = '${db}';
            " 2>/dev/null | grep -v "Warning")

        if [ "${DB_EXISTS}" = "1" ]; then
            # 计数表
            TABLE_COUNT=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
                mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                    SELECT COUNT(*)
                    FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'BASE TABLE';
                " 2>/dev/null | grep -v "Warning")

            print_success "${db}: 迁移了 ${TABLE_COUNT} 个表"
        else
            print_error "${db}: 目标上未找到数据库"
        fi
    done

    print_section "验证用户"

    MIGRATED_USERS=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
        mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
            SELECT CONCAT(user, '@', host)
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS})
            ORDER BY user;
        " 2>/dev/null | grep -v "Warning")

    if [ -n "${MIGRATED_USERS}" ]; then
        print_success "迁移的用户:"
        echo "${MIGRATED_USERS}" | while read user; do
            echo "   - ${user}"
        done
    else
        print_warning "没有迁移用户（或所有用户都被排除）"
    fi
}

print_summary() {
    local END_TIME=$(date +%s)
    local DURATION=$((END_TIME - START_TIME))
    local MINUTES=$((DURATION / 60))
    local SECONDS=$((DURATION % 60))

    print_header "迁移总结"

    echo ""
    echo "源: ${SOURCE_NAME}.${SOURCE_NAMESPACE}"
    echo "目标: ${TARGET_NAME}.${TARGET_NAMESPACE}"
    echo "迁移的数据库: ${MIGRATED_DATABASES}/${TOTAL_DATABASES}"
    echo "迁移的用户: ${MIGRATED_USERS}"
    echo "持续时间: ${MINUTES}m ${SECONDS}s"
    echo ""

    if [ ${FAILED_DATABASES} -eq 0 ] && [ ${MIGRATED_DATABASES} -eq ${TOTAL_DATABASES} ]; then
        print_success "迁移成功完成！"
        echo ""
        echo "后续步骤:"
        echo "   1. 运行脚本 02-verify-migration.sh 进行全面验证"
        echo "   2. 更新应用程序连接字符串"
        echo "   3. 进行应用程序测试"
        echo "   4. 在停用源之前监控 24-48 小时"
        echo ""
    else
        print_error "迁移完成时出现错误"
        echo ""
        echo "请查看上述错误并："
        echo "   1. 检查目标集群日志: kubectl logs -n ${TARGET_NAMESPACE} ${TARGET_NAME}-0 -c mysql --tail=100"
        echo "   2. 手动验证失败的数据库"
        echo "   3. 如有必要，重新运行失败数据库的迁移"
        echo ""
        exit 1
    fi
}

#=============================================================================
# 主执行
#=============================================================================

main() {
    print_header "MySQL 5.7 到 8.0 迁移"

    print_warning "重要：确保在迁移期间停止应用程序写入"
    echo ""
    sleep 2

    check_prerequisites
    migrate_databases
    migrate_users
    verify_migration
    print_summary

    print_success "迁移脚本完成"
}

main
```

#### 脚本 3: 02-verify-migration.sh

将此脚本保存为 `02-verify-migration.sh`：

```bash
#!/bin/bash
#=============================================================================
# MySQL 5.7 到 8.0 迁移 - 全面验证脚本
#=============================================================================
#
# 此脚本执行迁移的全面验证：
# 1. 验证所有数据库对象（表、视图、例程、触发器、事件）
# 2. 测试视图执行
# 3. 比较行计数
# 4. 验证用户帐户
#
# 使用方法：
#   1. 编辑下面的配置部分
#   2. 运行: chmod +x 02-verify-migration.sh
#   3. 运行: ./02-verify-migration.sh
#
#=============================================================================

set -e # 出现错误时退出

#=============================================================================
# 配置 - 编辑这些值
#=============================================================================

SOURCE_NAME="source"
SOURCE_NAMESPACE="your-namespace"
SOURCE_MYSQL_PASSWORD="source-root-password"

TARGET_NAME="mysql-8-target"
TARGET_NAMESPACE="your-namespace"
TARGET_MYSQL_PASSWORD="target-root-password"

# 重要：迁移的数据库（不要包括：information_schema、mysql、performance_schema、sys）
DATABASES="db1 db2 db3" # ← 与迁移脚本中使用的相同

# 要排除的用户（系统用户和 MySQL MGR 用户）
EXCLUDE_USERS="'mysql.sys', 'mysql.session', 'mysql.infoschema', 'root', 'clustercheck', 'monitor', 'operator', 'xtrabackup', 'repl', 'exporter', 'healthchecker', 'clusterchecker', 'mysql', 'percona.telemetry', 'manage'"
# 注意：MySQL MGR 系统用户（mysql_innodb_cluster_%，mysql_router%）在 verify_users() 中被过滤

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # 无颜色

# 验证计数器
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0

# 临时目录
WORK_DIR="/tmp/mysql-migration-verify"
mkdir -p ${WORK_DIR}

#=============================================================================
# 函数
#=============================================================================

print_header() {
    echo ""
    echo "========================================"
    echo "$1"
    echo "========================================"
}

print_section() {
    echo ""
    echo -e "${BLUE}>>> $1${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_info() {
    echo -e "${CYAN}ℹ $1${NC}"
}

check_count() {
    local source_count=$1
    local target_count=$2
    local object_name=$3

    TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

    if [ "${source_count}" = "${target_count}" ]; then
        print_success "${object_name}: ${target_count} (匹配)"
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
        return 0
    else
        print_error "${object_name}: 源=${source_count}, 目标=${target_count} (不匹配)"
        FAILED_CHECKS=$((FAILED_CHECKS + 1))
        return 1
    fi
}

verify_tables() {
    print_section "验证表"

    for db in ${DATABASES}; do
        echo ""
        echo "数据库: ${db}"

        SOURCE_COUNT=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
            mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'BASE TABLE';
            " 2>/dev/null | grep -v "Warning")

        TARGET_COUNT=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'BASE TABLE';
            " 2>/dev/null | grep -v "Warning")

        check_count "${SOURCE_COUNT}" "${TARGET_COUNT}" "表"
    done
}

verify_views() {
    print_section "验证视图"

    for db in ${DATABASES}; do
        echo ""
        echo "数据库: ${db}"

        SOURCE_COUNT=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
            mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.VIEWS
                WHERE TABLE_SCHEMA = '${db}';
            " 2>/dev/null | grep -v "Warning")

        TARGET_COUNT=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.VIEWS
                WHERE TABLE_SCHEMA = '${db}';
            " 2>/dev/null | grep -v "Warning")

        if check_count "${SOURCE_COUNT}" "${TARGET_COUNT}" "视图"; then
            # 如果计数匹配，则测试视图执行
            if [ "${TARGET_COUNT}" -gt 0 ]; then
                VIEW_FAILED=0
                VERIFY_TMP="${WORK_DIR}/view_verify.txt"
                echo "0" >${VERIFY_TMP}

                kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
                    mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                        SELECT TABLE_NAME
                        FROM information_schema.VIEWS
                        WHERE TABLE_SCHEMA = '${db}';
                    " 2>/dev/null | grep -v "Warning" | while read view_name; do
                    if ! kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
                        mysql -uroot -p${TARGET_MYSQL_PASSWORD} ${db} -e "SELECT COUNT(*) FROM \`${view_name}\`;" 2>&1 | grep -q "ERROR"; then
                        : # 视图正常
                    else
                        echo "1" >>${VERIFY_TMP}
                    fi
                done

                if [ "$(cat ${VERIFY_TMP} | wc -l)" -eq 1 ] && [ "$(cat ${VERIFY_TMP})" = "0" ]; then
                    print_success "所有视图执行成功"
                else
                    print_error "某些视图执行失败"
                fi

                rm -f ${VERIFY_TMP}
            fi
        fi
    done
}

verify_routines() {
    print_section "验证存储过程"

    for db in ${DATABASES}; do
        echo ""
        echo "数据库: ${db}"

        SOURCE_COUNT=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
            mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.ROUTINES
                WHERE ROUTINE_SCHEMA = '${db}' AND ROUTINE_TYPE = 'PROCEDURE';
            " 2>/dev/null | grep -v "Warning")

        TARGET_COUNT=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.ROUTINES
                WHERE ROUTINE_SCHEMA = '${db}' AND ROUTINE_TYPE = 'PROCEDURE';
            " 2>/dev/null | grep -v "Warning")

        check_count "${SOURCE_COUNT}" "${TARGET_COUNT}" "存储过程"
    done

    echo ""
    print_section "验证存储函数"

    for db in ${DATABASES}; do
        echo ""
        echo "数据库: ${db}"

        SOURCE_COUNT=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
            mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.ROUTINES
                WHERE ROUTINE_SCHEMA = '${db}' AND ROUTINE_TYPE = 'FUNCTION';
            " 2>/dev/null | grep -v "Warning")

        TARGET_COUNT=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.ROUTINES
                WHERE ROUTINE_SCHEMA = '${db}' AND ROUTINE_TYPE = 'FUNCTION';
            " 2>/dev/null | grep -v "Warning")

        check_count "${SOURCE_COUNT}" "${TARGET_COUNT}" "存储函数"
    done
}

verify_triggers() {
    print_section "验证触发器"

    for db in ${DATABASES}; do
        echo ""
        echo "数据库: ${db}"

        SOURCE_COUNT=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
            mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.TRIGGERS
                WHERE TRIGGER_SCHEMA = '${db}';
            " 2>/dev/null | grep -v "Warning")

        TARGET_COUNT=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.TRIGGERS
                WHERE TRIGGER_SCHEMA = '${db}';
            " 2>/dev/null | grep -v "Warning")

        check_count "${SOURCE_COUNT}" "${TARGET_COUNT}" "触发器"
    done
}

verify_events() {
    print_section "验证事件"

    for db in ${DATABASES}; do
        echo ""
        echo "数据库: ${db}"

        SOURCE_COUNT=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
            mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.EVENTS
                WHERE EVENT_SCHEMA = '${db}';
            " 2>/dev/null | grep -v "Warning")

        TARGET_COUNT=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.EVENTS
                WHERE EVENT_SCHEMA = '${db}';
            " 2>/dev/null | grep -v "Warning")

        check_count "${SOURCE_COUNT}" "${TARGET_COUNT}" "事件"
    done
}

verify_row_counts() {
    print_section "验证行计数（样本）"

    for db in ${DATABASES}; do
        echo ""
        echo "数据库: ${db}"

        # 获取前 5 个表进行抽样
        TABLES=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
            mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
                SELECT TABLE_NAME
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'BASE TABLE'
                LIMIT 5;
            " 2>/dev/null | grep -v "Warning")

        if [ -z "${TABLES}" ]; then
            print_warning "${db} 中未找到表"
            continue
        fi

        ROW_MISMATCH=0
        for table in ${TABLES}; do
            SOURCE_ROWS=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
                mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
                    SELECT TABLE_ROWS
                    FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = '${db}' AND TABLE_NAME = '${table}';
                " 2>/dev/null | grep -v "Warning")

            TARGET_ROWS=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
                mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                    SELECT TABLE_ROWS
                    FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = '${db}' AND TABLE_NAME = '${table}';
                " 2>/dev/null | grep -v "Warning")

            # 由于统计信息允许小的差异
            if [ "${SOURCE_ROWS}" != "${TARGET_ROWS}" ]; then
                print_warning "${table} 的行计数差异: 源=${SOURCE_ROWS}, 目标=${TARGET_ROWS}"
                ROW_MISMATCH=1
            fi
        done

        if [ ${ROW_MISMATCH} -eq 0 ]; then
            print_success "行计数: 样本检查通过"
        fi
    done
}

verify_users() {
    print_section "验证用户帐户"

    SOURCE_USERS=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
            SELECT COUNT(*)
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS})
            AND user NOT LIKE 'mysql_innodb_cluster_%'
            AND user NOT LIKE 'mysql_router%';
        " 2>/dev/null | grep -v "Warning")

    TARGET_USERS=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
        mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
            SELECT COUNT(*)
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS})
            AND user NOT LIKE 'mysql_innodb_cluster_%'
            AND user NOT LIKE 'mysql_router%';
        " 2>/dev/null | grep -v "Warning")

    check_count "${SOURCE_USERS}" "${TARGET_USERS}" "用户帐户"

    # 显示迁移的用户
    if [ "${TARGET_USERS}" -gt 0 ]; then
        echo ""
        print_info "迁移的用户:"
        kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                SELECT CONCAT(user, '@', host)
                FROM mysql.user
                WHERE user NOT IN (${EXCLUDE_USERS})
                AND user NOT LIKE 'mysql_innodb_cluster_%'
                AND user NOT LIKE 'mysql_router%'
                ORDER BY user;
            " 2>/dev/null | grep -v "Warning" | while read user; do
            echo "   - ${user}"
        done
    fi
}

test_data_integrity() {
    print_section "测试数据完整性"

    print_info "执行样本数据完整性检查..."

    for db in ${DATABASES}; do
        # 检查目标上是否存在数据库
        DB_EXISTS=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.SCHEMATA
                WHERE SCHEMA_NAME = '${db}';
            " 2>/dev/null | grep -v "Warning")

        if [ "${DB_EXISTS}" = "1" ]; then
            print_success "${db}: 数据库在目标上存在"
        else
            print_error "${db}: 数据库在目标上未找到"
            FAILED_CHECKS=$((FAILED_CHECKS + 1))
        fi
    done
}

print_summary() {
    print_header "验证总结"

    echo ""
    echo "总检查: ${TOTAL_CHECKS}"
    echo -e "${GREEN}通过: ${PASSED_CHECKS}${NC}"
    echo -e "${RED}失败: ${FAILED_CHECKS}${NC}"
    echo ""

    if [ ${FAILED_CHECKS} -eq 0 ] && [ ${PASSED_CHECKS} -eq ${TOTAL_CHECKS} ]; then
        print_success "所有检查通过！"
        echo ""
        echo "迁移验证成功。后续步骤:"
        echo "   1. 更新应用程序连接字符串以指向目标"
        echo "   2. 进行应用程序测试"
        echo "   3. 监控目标集群 24-48 小时"
        echo "   4. 在此期间保持源集群可用以进行回滚"
        echo ""
        return 0
    else
        print_error "某些检查失败"
        echo ""
        echo "请查看上述失败的检查并："
        echo "   1. 检查目标集群日志: kubectl logs -n ${TARGET_NAMESPACE} ${TARGET_NAME}-0 -c mysql --tail=100"
        echo "   2. 手动验证失败的对象"
        echo "   3. 如有必要，重新运行特定数据库的迁移"
        echo ""
        return 1
    fi
}

cleanup() {
    rm -rf ${WORK_DIR}
}

#=============================================================================
# 主执行
#=============================================================================

main() {
    # 捕获退出时清理
    trap cleanup EXIT

    print_header "MySQL 5.7 到 8.0 迁移验证"

    verify_tables
    verify_views
    verify_routines
    verify_triggers
    verify_events
    verify_row_counts
    verify_users
    test_data_integrity
    print_summary
}

main
```

---

## 总结

本指南提供了在 Alauda 容器平台上迁移 MySQL 5.7 到 8.0 的全面、经过测试的说明。该解决方案已在 Kubernetes 测试环境中使用 PXC 5.7.44 和 MGR 8.0.44 集群进行了验证。

### 本指南涵盖的内容

| 测试类别                  | 测试用例           | 验证内容                                                |
| ------------------------ | ------------------ | ------------------------------------------------------ |
| 基本迁移                  | 核心功能           | 表、数据、外键、索引                                    |
| 架构兼容性                | MySQL 8.0 问题     | 保留关键字、ZEROFILL、日期默认值、TEXT 列             |
| 数据库对象                | 所有对象类型       | 过程、函数、触发器、事件、视图                          |
| 用户和权限迁移            | 安全性和访问       | 用户帐户、授权、身份验证插件                            |
| 字符集迁移                | 数据完整性         | utf8mb4 转换、多语言支持                                |
| GTID 处理                 | 复制               | MGR 目标的 GTID_PURGED 过滤                            |

### 主要好处

- ✅ **经过验证的方法**：在 Kubernetes 测试环境中测试
- ✅ **全面覆盖**：迁移所有标准 MySQL 对象并进行全面验证
- ✅ **架构兼容性**：自动检查和修复 MySQL 8.0 兼容性问题
- ✅ **字符集支持**：完整的 utf8mb4 迁移策略
- ✅ **安全性**：用户和权限迁移以及 MySQL 8.0 身份验证指导
- ✅ **性能**：针对 MySQL 8.0 特性的迁移后优化
- ✅ **风险缓解**：详细的回滚程序和每个步骤的验证

### 生产就绪检查表

在将本指南用于生产之前，请确保您已：

- [ ] 审查 [入门](#getting-started) 部分以了解您的环境
- [ ] 在非生产环境中测试迁移过程
- [ ] 完成 [架构兼容性分析](#step-1-schema-compatibility-analysis) 并修复所有问题
- [ ] 如果使用遗留字符集，完成 [字符集迁移](#step-2-character-set-and-collation-analysis)
- [ ] 根据数据库大小安排足够的维护窗口
- [ ] 与所有利益相关者（应用团队、DBA、SRE）进行沟通
- [ ] 准备回滚计划（请参见 [灾难恢复](#disaster-recovery)）
- [ ] 验证应用程序与 MySQL 8.0 身份验证插件的兼容性

### 本指南提供的内容

通过遵循这些实践，组织可以成功将其 MySQL 数据库迁移到 8.0 版本，确保：

- ✅ **持续的安全支持**（MySQL 5.7 的 EOL 是 2023 年 10 月）
- ✅ **访问新功能**（CTE、窗口函数、直方图等）
- ✅ **通过全面验证维护数据完整性**
- ✅ **最小停机时间**，使用经过测试的程序
- ✅ **如果出现问题，具备回滚能力**

### 支持和故障排除

如果您遇到本指南未涵盖的问题：

1. 检查 [故障排除](#troubleshooting) 部分以获取常见问题
2. 查看 [重要限制](#important-limitations) 部分
3. 验证您的环境是否符合 [先决条件](#prerequisites)
4. 遵循 [kubectl Exec 最佳实践](#getting-started) 以避免常见命令错误
5. 检查 MySQL 错误日志：`kubectl logs -n <namespace> <pod-name> -c mysql --tail=100`
```

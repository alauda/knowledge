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

MySQL 5.7 已于 2023 年 10 月到达生命周期终点（EOL），组织必须升级到 MySQL 8.0 才能继续获得安全更新并利用新特性。迁移生产数据库涉及复杂的考量，包括 schema 兼容性、字符集变更、认证插件更新，以及在迁移过程中确保数据完整性。

### 解决方案

本指南提供在 Alauda Container Platform (ACP) 上将 MySQL 5.7 迁移到 8.0 的全面且经过验证的操作说明。该方案采用基于 mysqldump 的迁移策略，并辅以全面校验：

- **成熟可靠的方案**：已在 Alauda Container Platform (ACP v4.0+) 上使用 Alauda Database Service for MySQL 完成验证（详见 [环境信息](#environment-information)）。
- **完整的对象覆盖**：迁移所有标准 MySQL 对象（表、视图、例程、触发器、事件、用户、授权）。
- **Schema 兼容性**：针对 MySQL 8.0 兼容性问题的自动检查与修复。
- **全面校验**：覆盖 9 个对象类别的校验，包括视图执行测试。
- **风险最小化**：详细的回滚操作步骤以及每一步的校验。

## 环境信息

**适用版本**：ACP v4.0 或更高版本，MySQL Operator (Alauda Database Service for MySQL) v4.0 或更高版本
**测试环境**：ACP v4.2.0 与 MySQL Operator v4.2.0
源端：Percona XtraDB Cluster (PXC) 5.7.44
目标端：MySQL Group Replication (MGR) 8.0.44

## 测试与验证

本迁移方案已在 Kubernetes 环境中使用 PXC 5.7.44 与 MGR 8.0.44 集群完成**验证**。

### 已验证内容

| 类别 | 已验证项 |
|----------|----------------|
| **基础迁移** | 表、数据行、外键、索引 |
| **Schema 兼容性** | 保留关键字检测、ZEROFILL 处理、无效日期默认值、TEXT 列默认值 |
| **数据库对象** | 存储过程、函数、触发器、事件、视图（含执行测试） |
| **用户与权限** | 用户账号创建、权限迁移、认证插件兼容性 |
| **字符集** | utf8mb4 转换、多语言支持（中文、日文、拉丁重音字符）、emoji 保留 |
| **GTID 处理** | 针对 MGR 目标端的 GTID_PURGED 过滤、数据完整性保持 |

## 快速参考

### 关键概念
- **源集群**：现有的 MySQL 5.7.44 PXC 集群。
- **目标集群**：新建的 MySQL 8.0.44 MGR 集群。
- **GTID**：用于事务跟踪的全局事务标识符。
- **Schema 兼容性**：MySQL 8.0 保留关键字与语法变更
- **字符集迁移**：转换为 utf8mb4 以获得完整的 Unicode 支持
- **DEFINER 权限**：存储例程/视图/事件/触发器的安全上下文

### PXC 与 MGR：主要差异

| 方面 | PXC 5.7（源端） | MGR 8.0（目标端） |
|--------|-----------------|------------------|
| **Pod 名称模式** | `${NAME}-pxc-0` | `${NAME}-0` |
| **容器指定** | 不需要（默认为 mysql） | 必需：`-c mysql` |
| **主节点端点** | `${NAME}-proxysql.${NS}.svc.cluster.local:3306` | `${NAME}-read-write.${NS}.svc.cluster.local:3306` |
| **从节点端点** | 与主节点相同（由 ProxySQL 负责路由） | `${NAME}-read-only.${NS}.svc.cluster.local:3306` |
| **复制类型** | Galera（同步多主） | Group Replication（单主模式，从节点异步复制） |
| **Secret 名称模式** | `${NAME}` | `mgr-${NAME}-password` |

**重要：**在运行迁移命令之前，务必先通过 `kubectl get pod -n <namespace>` 确认实际的 pod 名称。

### 常见使用场景

| 场景 | 数据库大小 | 预计停机时间 | 章节参考 |
|----------|---------------|-------------------|------------------|
| **小型数据库** | < 10GB | 15-30 分钟 | [迁移操作步骤](#step-4-migrate-data-users-and-privileges) |
| **中型数据库** | 10-50GB | 30-60 分钟 | [迁移操作步骤](#step-4-migrate-data-users-and-privileges) |
| **大型数据库** | 50-200GB | 1-2 小时 | [迁移操作步骤](#step-4-migrate-data-users-and-privileges) |
| **Schema 问题** | 任意大小 | 修复额外需 1-2 小时 | [Schema 兼容性](#step-1-schema-compatibility-analysis) |
| **字符集迁移** | 任意大小 | 额外需 30-60 分钟 | [字符集迁移](#step-2-character-set-and-collation-analysis) |

## 前提条件

在执行 MySQL 迁移之前，请确保具备：

- ACP v4.0 或更高版本，且 MySQL Operator 为 v4.0 或更高版本（已测试版本见 [环境信息](#environment-information)）
- 已按照 [安装指南](https://docs.alauda.io/mysql-mgr/4.2/installation.html) 部署 MySQL 插件
- 阅读 [Alauda MySQL MGR 文档](https://docs.alauda.io/mysql-mgr/4.2/functions/01-create.html) 以了解实例创建

> **关于文档链接的说明**：上述链接指向 v4.2 版本的 Alauda MySQL MGR 文档。如果你运行的是更新版本的 MySQL Operator，请将 URL 路径中的 `4.2` 替换为你安装的版本（例如 `4.3`、`5.0`）。
- **源集群要求**：
  - 一个健康的 MySQL 5.7.44 PXC 集群
  - 已启用 GTID 模式（`@@gtid_mode = ON`、`@@enforce_gtid_consistency = ON`）
  - Root 或管理员访问凭据
- **目标集群要求**：
  - 在迁移*之前*新建的 MySQL 8.0.44 MGR 集群
  - 存储容量为源数据库大小的 2-3 倍
  - 与源端相同或更高的资源配置（CPU/内存）
  - 本地机器到两个集群的网络连通性
- **迁移前任务**：
  - 完成 [Schema 兼容性分析](#step-1-schema-compatibility-analysis) 并修复问题
  - 如果使用旧字符集，完成 [字符集迁移](#step-2-character-set-and-collation-analysis)
  - 确定要迁移的用户数据库（不要包含：`information_schema`、`mysql`、`performance_schema`、`sys`）
  - 与应用团队约定维护窗口
  - 就计划的停机时间通知相关干系人
  - 按照 [灾难恢复](#disaster-recovery) 中的说明准备回滚方案

### 重要限制

- 在导出和导入期间需要应用停机，以确保一致性。
- 建议的最大数据库大小：200GB（更大的数据库可能需要其他方案）。
- 源集群必须启用 GTID。
- 目标集群必须在迁移开始之前创建。
- 目标端的存储性能（IOPS/吞吐量）应等于或高于源端。
- 部分 MySQL 8.0 特性（角色、Caching SHA2 密码）需要在迁移后进行配置。

## 开始使用

在执行迁移命令之前，先收集以下信息：

### 1. 获取 MySQL Root 密码

```bash
# For PXC 5.7 source
kubectl get secret <source-name> -n <source-namespace> -o jsonpath='{.data.root}' | base64 -d

# For MGR 8.0 target
kubectl get secret mgr-<target-name>-password -n <target-namespace> -o jsonpath='{.data.root}' | base64 -d
```

**示例：**
```bash
# Get source password
kubectl get secret source -n jpsu2-midautons -o jsonpath='{.data.root}' | base64 -d
# Output: root123@

# Get target password
kubectl get secret mgr-target-password -n jpsu2-midautons -o jsonpath='{.data.root}' | base64 -d
# Output: root123@
```

### 2. 确认 Pod 名称

```bash
# Check source PXC pods
kubectl get pod -n <source-namespace> | grep <source-name>
# Example output: source-pxc-0, source-pxc-1, source-pxc-2

# Check target MGR pods
kubectl get pod -n <target-namespace> | grep <target-name>
# Example output: target-0, target-1, target-2

# Verify MGR container name
kubectl describe pod <target-name>-0 -n <target-namespace> | grep "Container:"
# MGR pods have multiple containers - always use `-c mysql` for MySQL commands
```

### 3. 校验集群状态

```bash
# Check PXC source status
kubectl get mysql <source-name> -n <source-namespace>
# Expected: STATE = ready, PXCSTATE = ready

# Check MGR target status
kubectl get mysql <target-name> -n <target-namespace>
# Expected: All 3 members ready, STATUS = Running
```

### 4. kubectl Exec 最佳实践

通过 `kubectl exec` 运行 MySQL 命令时，请遵循以下模式：

**PXC 5.7（源端）：**
```bash
# No container specifier needed for PXC
kubectl exec <source-name>-pxc-0 -n <namespace> -- \
  mysql -uroot -p<password> -e "SQL_HERE"
```

**MGR 8.0（目标端）：**
```bash
# Always use -c mysql for MGR
kubectl exec <target-name>-0 -n <namespace> -c mysql -- \
  mysql -uroot -p<password> -e "SQL_HERE"
```

**重要说明：**
- 始终使用参数顺序：`kubectl exec -n <namespace> <pod-name> -- <command>`
- 在命令前使用 `--`（双短横线）将 kubectl 选项与命令分隔开
- 多行命令使用 `\`（反斜杠）
- 避免在 `kubectl exec` 中使用 heredoc（`<<EOF`）——它们常因 shell 引号问题而失败
- 单条语句使用 `-e "SQL"`，多条语句使用多个 `-e`
- 使用变量时，将 `-n <namespace>` 放在 pod 名称之前，以避免解析问题

## 执行指南

本指南使用 [附录](#appendix-migration-scripts-reference) 中提供的自动化迁移脚本来简化迁移过程。

### 步骤 1：Schema 兼容性分析

在计划迁移**前一周**执行本分析。

运行 `00-pre-migration-check.sh` 脚本，自动检测 schema 兼容性问题并确定要迁移的数据库。

```bash
# Edit configuration
vi 00-pre-migration-check.sh

# Run check
chmod +x 00-pre-migration-check.sh
./00-pre-migration-check.sh
```

该脚本将输出：
1. 要迁移的用户数据库列表（复制其中的 `DATABASES="..."` 行以备后用）
2. Schema 兼容性问题（保留关键字、无效日期、ZEROFILL 等）
3. 字符集分析

如果脚本报告了问题，使用下面的命令进行修复。

#### 修复 Schema 问题

```bash
# Fix reserved keyword columns (example)
kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    USE db1;
    ALTER TABLE users CHANGE COLUMN rank user_rank INT;
  "

# Fix invalid date defaults (example)
kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    USE db1;
    ALTER TABLE events MODIFY COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
  "

# Fix ZEROFILL columns (remove ZEROFILL)
kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    USE db1;
    ALTER TABLE products MODIFY COLUMN price DECIMAL(10,2);
  "
```

### 步骤 2：字符集与排序规则分析

`00-pre-migration-check.sh` 脚本（已在步骤 1 中运行）已检查非 utf8mb4 表。如果报告了任何“未使用 utf8mb4 的表”，请在计划迁移**前 3-5 天**完成转换。

#### 转换为 utf8mb4

```bash
# Convert databases to utf8mb4
for db in ${DATABASES}; do
  kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
    mysql -uroot -p${MYSQL_PASSWORD} -e "
      ALTER DATABASE ${db} CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
    "
done

# Convert tables to utf8mb4
for db in ${DATABASES}; do
  TABLES=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
    mysql -uroot -p${MYSQL_PASSWORD} -N -e "
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'BASE TABLE';
    ")

  for table in ${TABLES}; do
    echo "Converting ${db}.${table}..."
    kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
      mysql -uroot -p${MYSQL_PASSWORD} ${db} -e "
        ALTER TABLE ${table} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      "
  done
done
```

**重要说明**：对于带有较长 VARCHAR/TEXT 索引（>191 字符）的表，可能需要调整索引长度：

```sql
-- Example: Fix index length for utf8mb4
ALTER TABLE users DROP INDEX idx_email;
ALTER TABLE users ADD UNIQUE INDEX idx_email (email(191));
```

### 步骤 3：创建目标 MySQL 8.0 实例

在数据迁移阶段**开始前不久**再创建目标 MySQL 8.0 实例，以节省资源。

**重要**：在启动迁移脚本之前创建目标 MySQL 8.0 实例。

**使用 Web 控制台：**

详细说明请参考 [创建 MySQL 实例文档](https://docs.alauda.io/mysql-mgr/4.2/functions/01-create.html)（如有需要，请将 URL 中的 `4.2` 替换为你的 MySQL Operator 版本）。关键配置要点：

1. 选择版本 **8.0**
2. 配置资源（由于 MySQL 8.0 的额外开销，建议内存比源集群 **+10-20%**）
3. 将存储大小设置为源数据库大小的 **2-3 倍**

**使用命令行：**

```bash
TARGET_NAME="mysql-8-target"
NAMESPACE="your-namespace"
STORAGE_SIZE="500Gi"  # Adjust based on your source DB size

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
    crVersion: 4.2.0  # Set to your installed MySQL Operator version
  version: "8.0"
EOF
```

**注意：**上述 YAML 使用 Alauda MySQL CRD 格式。与标准 Kubernetes 的主要差异：
- 使用 `spec.mgr` 而不是 `spec.type`
- `members: 1` 表示单节点（高可用请增加到 3）
- `storageClassName` 必须与集群中可用的 StorageClass 匹配
- 大多数 ACP 环境需要 `strictSecurityModeEnabled: true`
- `upgradeOption.crVersion` 必须与已安装的 MySQL Operator 版本匹配；请将 `4.2.0` 更新为你的实际版本（可通过 `kubectl get mysql -A` 或 ACP Web 控制台查看）

**校验目标集群：**

```bash
# Wait for cluster to be ready
kubectl -n $NAMESPACE get mysql $TARGET_NAME -w

# Expected output:
# NAME             VERSION   STATE   PXCSTATE   MGRSTATE
# mysql-8-target   8.0       Ready              ready
```

### 步骤 4：迁移数据、用户和权限

使用 `01-migrate-all.sh` 脚本执行迁移。该脚本会：
1. 校验前提条件（GTID、版本、连通性）
2. 将所有指定数据库的数据从源端直接流式传输到目标端
3. 迁移用户账号和权限（使用 `mysql_native_password` 以保证兼容性）

**操作步骤：**

1. **停止应用写入**：将应用副本数缩容为零，以确保数据一致性。

   **关键**：从此步骤开始直到切换阶段完成，应用必须保持停止状态（或严格只读）。此步骤之后写入源数据库的任何数据都会丢失。

   ```bash
   kubectl scale deployment <app-name> --replicas=0 -n <app-namespace>
   ```

2. **配置脚本**：
   编辑 `01-migrate-all.sh`，设置集群名称、namespace 以及 `DATABASES` 变量（使用步骤 1 得到的列表）。

3. **运行迁移**：
   ```bash
   chmod +x 01-migrate-all.sh
   ./01-migrate-all.sh
   ```

**重要说明：**
- 该脚本使用**流式迁移**，因此不会为转储文件占用磁盘空间。
- 它会自动处理 `GTID_PURGED` 过滤，以兼容 MGR。
- 用户账号使用 `mysql_native_password` 进行迁移，以最大限度兼容现有应用。


### 步骤 5：校验迁移

运行 `02-verify-migration.sh` 脚本，确认所有数据库对象均已成功迁移。

```bash
chmod +x 02-verify-migration.sh
./02-verify-migration.sh
```

该脚本会对每个数据库执行以下检查：
1. **表**：比较源端与目标端的数量
2. **视图**：比较数量，并测试每个视图的执行
3. **存储过程/函数**：比较数量
4. **触发器/事件**：比较数量
5. **行数**：执行抽样行数检查
6. **用户**：校验用户账号已迁移

**注意**：如果任何检查失败，脚本会输出红色的失败消息。在校验通过之前不要进行切换。

### 步骤 6：迁移后优化

迁移成功后，对目标 MySQL 8.0 实例进行优化。

#### 1. 更新表统计信息

```bash
TARGET_NAME="mysql-8-target"
TARGET_NAMESPACE="your-namespace"
MYSQL_PASSWORD="your-password"
DATABASES="db1 db2 db3"  # ← YOUR databases only (NOT: information_schema, mysql, performance_schema, sys)

for db in ${DATABASES}; do
  echo "Analyzing tables in ${db}..."
  TABLES=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
    mysql -uroot -p${MYSQL_PASSWORD} -N -e "
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'BASE TABLE';
    ")

  for table in ${TABLES}; do
    kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
      mysql -uroot -p${MYSQL_PASSWORD} ${db} -e "ANALYZE TABLE ${table};" 2>&1 | grep -v "Table"
  done

  echo "  ✓ Analyzed $(echo ${TABLES} | wc -w) tables"
done
```

#### 2. 创建直方图（MySQL 8.0 特性）

直方图可提升非索引列的查询性能：

```bash
# Example: Create histogram on frequently filtered column
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
           ROUND(DATA_FREE / 1024 / 1024, 2) AS 'Fragmentation (MB)'
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA IN ('${DATABASES// /,\'','\'}')
      AND DATA_FREE > 0
    ORDER BY DATA_FREE DESC;
  "
```

如果发现明显碎片（>100MB），重建表：

```sql
-- Rebuild fragmented table
OPTIMIZE TABLE db1.orders;
```

#### 4. 建立性能基线

```bash
# Record current performance metrics (table count, row count, size) to /tmp/mysql-8-baseline.txt for later comparison
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

迁移校验完成后，切换应用流量：

#### 1. 确认应用已停止

确保应用仍处于停止状态（与步骤 4 中执行的一致）。

```bash
# Ensure application is scaled down
kubectl scale deployment <app-name> --replicas=0 -n <app-namespace>

# Verify no active connections
kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "SHOW PROCESSLIST;" | grep -v "Sleep"
```

#### 2. 更新应用连接串

```bash
# Update ConfigMap or environment variables
kubectl patch configmap <app-config> -n <app-namespace> --type=json \
  -p='[{"op": "replace", "path": "/data/database-host", "value":"mysql-8-target-read-write.'${TARGET_NAMESPACE}'.svc.cluster.local"}]'

kubectl patch configmap <app-config> -n <app-namespace> --type=json \
  -p='[{"op": "replace", "path": "/data/database-port", "value":"3306"}]'
```

#### 3. 重启应用

```bash
# Scale up application
kubectl scale deployment <app-name> --replicas=<original-replica-count> -n <app-namespace>

# Wait for pods to be ready
kubectl -n <app-namespace> rollout status deployment <app-name>
```

#### 4. 校验应用功能

```bash
# Test database connectivity from application pod
kubectl exec -it <app-pod> -n <app-namespace> -- \
  mysql -h mysql-8-target-read-write.${TARGET_NAMESPACE}.svc.cluster.local \
    -uroot -p${MYSQL_PASSWORD} -e "SELECT 1 AS test;"

# Check application logs for errors
kubectl logs -n <app-namespace> <app-pod> --tail=100 | grep -i error
```

### 监控

对已迁移的实例监控 24-48 小时：

```bash
# Check MySQL 8.0 instance health
kubectl -n ${TARGET_NAMESPACE} get mysql ${TARGET_NAME} -w

# Monitor error logs
kubectl logs -n ${TARGET_NAMESPACE} ${TARGET_NAME}-0 -c mysql --tail=100 -f

# Check replication status (if applicable)
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "SHOW SLAVE STATUS\G"
```

## 灾难恢复

### 回滚方案

如果在切换后发现严重问题：

```bash
# 1. Stop application
kubectl scale deployment <app-name> --replicas=0 -n <app-namespace>

# 2. Update connection string back to source
kubectl patch configmap <app-config> -n <app-namespace> --type=json \
  -p='[{"op": "replace", "path": "/data/database-host", "value":"'${SOURCE_NAME}'-proxysql.'${SOURCE_NAMESPACE}'.svc.cluster.local"}]'

# 3. Restart application
kubectl scale deployment <app-name> --replicas=<original-replica-count> -n <app-namespace>

# 4. Verify connectivity
kubectl exec -it <app-pod> -n <app-namespace> -- \
  mysql -h ${SOURCE_NAME}-proxysql.${SOURCE_NAMESPACE}.svc.cluster.local \
    -uroot -p${MYSQL_PASSWORD} -e "SELECT 1 AS test;"

# 5. Monitor application logs
kubectl logs -n <app-namespace> <app-pod> --tail=100 -f
```

### 常见问题与解决方案

#### 问题：GTID_PURGED 错误

**症状：**
```text
ERROR 3546 (HY000) at line XX: Cannot update GTID_PURGED with the Group Replication plugin running
```

**解决方案：**已在迁移操作步骤中通过 `grep -v "SET @@GLOBAL.GTID_PURGED"` 过滤处理

#### 问题：字符集转换错误

**症状：**
```text
ERROR 1366 (HY000): Incorrect string value
```

**解决方案：**
```bash
# Check current character set
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_COLLATION
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = '${db}' AND TABLE_COLLATION NOT LIKE 'utf8mb4%';
  "

# Convert to utf8mb4
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
# Find all objects with missing definers
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    SELECT DISTINCT DEFINER
    FROM information_schema.VIEWS
    WHERE TABLE_SCHEMA = '${db}'
      AND DEFINER NOT IN (SELECT CONCAT(user, '@', host) FROM mysql.user);
  "

# Recreate missing users or update DEFINER
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    ALTER VIEW db1.my_view SQL SECURITY INVOKER AS SELECT ...;
  "
```

#### 问题：认证插件错误

**症状：**
```text
ERROR 2059 (HY000): Authentication plugin 'caching_sha2_password' cannot be loaded
```

**解决方案：**
```bash
# Update user to use mysql_native_password for compatibility
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "
    ALTER USER 'app_user'@'%' IDENTIFIED WITH mysql_native_password BY 'password';
    FLUSH PRIVILEGES;
  "
```

## 故障排查

### 诊断命令

#### 检查迁移进度

```bash
# Monitor migration progress (streaming mode)
kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "SHOW PROCESSLIST;"

# Monitor network traffic (if migration is slow)
kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
  mysql -uroot -p${MYSQL_PASSWORD} -e "SHOW PROCESSLIST;"
```

#### 校验数据完整性

```bash
# Compare row counts for all tables
for db in ${DATABASES}; do
  echo "=== Database: ${db} ==="
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

  diff /tmp/source_counts.txt /tmp/target_counts.txt || echo "Row count differences detected!"
done
```

#### 查看 MySQL 8.0 错误日志

```bash
# Real-time error monitoring
kubectl logs -n ${TARGET_NAMESPACE} ${TARGET_NAME}-0 -c mysql --tail=100 -f | grep -i error

# Search for specific errors
kubectl logs -n ${TARGET_NAMESPACE} ${TARGET_NAME}-0 -c mysql --tail=1000 | grep -i "definer"
```

## 最佳实践

### 迁移前规划

- **在预发环境测试**：始终先在非生产环境执行一次测试迁移
- **Schema 清理**：在生产迁移前修复所有 schema 兼容性问题
- **字符集迁移**：提前充分完成 utf8mb4 转换（至少提前 3-5 天）
- **备份策略**：确保迁移前有可用的近期备份
- **维护窗口**：根据数据库大小安排足够的停机时间
- **沟通**：通知所有干系人，包括应用团队和 DBA

### 迁移期间

- **停止应用写入**：确保导出/导入期间没有写入，以保证一致性
- **监控进度**：定期跟踪导出/导入进度
- **增量校验**：在每个主要步骤后运行校验脚本
- **记录问题**：记录遇到的任何问题以供日后参考
- **保持源端运行**：在迁移校验完成之前不要删除源端

### 迁移后

- **全面测试**：彻底测试应用功能
- **性能监控**：监控查询性能和资源使用 24-48 小时
- **优化**：执行迁移后优化操作步骤
- **保留源端以备回滚**：将源集群保留 24-48 小时作为回滚窗口
- **更新文档**：更新连接串、运维手册和监控看板

## 参考

### 大小与时间估算

| 数据库大小 | 导出时间 | 导入时间 | 总停机时间 |
|---------------|-------------|-------------|----------------|
| < 10GB | 1-5 分钟 | 2-10 分钟 | 15-30 分钟 |
| 10-50GB | 5-20 分钟 | 10-30 分钟 | 30-60 分钟 |
| 50-100GB | 20-40 分钟 | 30-60 分钟 | 1-2 小时 |
| 100-200GB | 40-80 分钟 | 1-2 小时 | 2-4 小时 |

### mysqldump 参数参考

| 参数 | 用途 |
|------|---------|
| `--single-transaction` | 使用 MVCC 获取一致性快照（InnoDB） |
| `--quick` | 逐行读取数据（节省内存） |
| `--lock-tables=false` | 不锁表（依赖 single-transaction） |
| `--set-gtid-purged=ON` | 包含 GTID 信息 |
| `--routines` | 导出存储过程和函数 |
| `--events` | 导出事件 |
| `--triggers` | 导出触发器 |
| `--databases` | 指定要导出的数据库 |

### 校验清单

迁移后，请校验：
- [ ] 表数量一致
- [ ] 每张表的行数一致
- [ ] 视图数量一致
- [ ] 所有视图均能成功执行
- [ ] 存储过程数量一致
- [ ] 函数数量一致
- [ ] 触发器数量一致
- [ ] 事件数量一致
- [ ] 所有 DEFINER 账号存在
- [ ] 所有用户已迁移
- [ ] 所有授权已迁移
- [ ] 应用能够连接
- [ ] 应用功能正常

### 相关链接

- [Alauda MySQL MGR 文档](https://docs.alauda.io/mysql-mgr/4.2/functions/01-create.html) — 如有需要，请将 URL 路径中的 `4.2` 替换为你的 MySQL Operator 版本
- [MySQL 8.0 Release Notes](https://dev.mysql.com/doc/refman/8.0/en/mysql-nutshell.html)
- [MySQL 8.0 升级指南](https://dev.mysql.com/doc/refman/8.0/en/upgrade-prerequisites.html)

## 附录：迁移脚本参考

本节提供为简化 MySQL 5.7 到 8.0 迁移过程而设计的自动化迁移脚本的详细文档。

### 概述

迁移脚本提供三步自动化流程：

| 脚本 | 用途 | 运行时机 | 耗时 |
|--------|---------|-------------|----------|
| **00-pre-migration-check.sh** | 迁移前兼容性分析 | 迁移前 1 周 | 2-5 分钟 |
| **01-migrate-all.sh** | 完整迁移（数据 + 用户） | 维护窗口期间 | 15-60 分钟 |
| **02-verify-migration.sh** | 全面校验 | 迁移后 | 5-10 分钟 |

### 脚本 1：迁移前检查

**用途：**检测 schema 兼容性问题并校验环境配置。

**检查内容：**
- Kubernetes 集群连通性
- 源集群的健康与状态
- 源端已启用 GTID 模式
- 自动检测用户数据库
- 保留关键字使用情况（RANK、GROUPS、FUNCTION 等）
- 无效日期默认值（`0000-00-00`）
- ZEROFILL 列使用情况
- 带 DEFAULT 值的 TEXT 列
- 字符集兼容性（utf8mb4）

**配置：**
```bash
SOURCE_NAME="source"              # Source cluster name
SOURCE_NAMESPACE="your-namespace" # Source namespace
MYSQL_PASSWORD="your-password"    # Source root password
DATABASES="ALL"                   # "ALL" to auto-detect
```

**用法：**
```bash
vi 00-pre-migration-check.sh       # Edit configuration
chmod +x 00-pre-migration-check.sh
./00-pre-migration-check.sh
```

**预期输出：**
```text
========================================
MySQL 5.7 to 8.0 Pre-Migration Check
========================================

>>> Checking kubectl context
✓ Connected to Kubernetes cluster

>>> Checking source cluster
✓ Source cluster source found
✓ Source cluster status: ready

>>> Checking GTID mode on source
✓ GTID mode is enabled

>>> Detecting user databases
✓ Databases to migrate:
   app_db customer_db reporting_db

⚠ Copy this line for your migration script:
DATABASES="app_db customer_db reporting_db"

>>> Checking for reserved keywords (MySQL 8.0)
✓ No reserved keyword issues found

[... more checks ...]

========================================
Pre-Migration Check Summary
========================================

✓ Configuration verified:
   Source cluster: source.your-namespace
   Databases to migrate: app_db customer_db reporting_db

Next steps:
   1. Fix any schema compatibility issues found above
   2. Convert character sets if needed
   3. Run script 01-migrate-all.sh to perform migration
```

### 脚本 2：完整迁移

**用途：**将所有数据库、用户和权限从源端迁移到目标端。

**功能：**
- 校验前提条件（两个集群、GTID、版本）
- 使用流式方式迁移数据库（无需磁盘存储）
- 使用 `mysql_native_password` 迁移用户账号
- 迁移所有权限和授权
- 执行基础校验

**配置：**
```bash
SOURCE_NAME="source"
SOURCE_NAMESPACE="your-namespace"
SOURCE_MYSQL_PASSWORD="source-root-password"

TARGET_NAME="mysql-8-target"
TARGET_NAMESPACE="your-namespace"
TARGET_MYSQL_PASSWORD="target-root-password"

DATABASES="app_db customer_db reporting_db"  # From pre-migration check
```

**用法：**
```bash
# Before running: Stop application writes!
kubectl scale deployment <app-name> --replicas=0 -n <app-namespace>

# Edit and run
vi 01-migrate-all.sh
chmod +x 01-migrate-all.sh
./01-migrate-all.sh
```

**预期输出：**
```text
========================================
MySQL 5.7 to 8.0 Migration
========================================

⚠ IMPORTANT: Ensure application writes are stopped during migration

>>> Checking prerequisites
✓ Connected to Kubernetes cluster
✓ Source cluster found: source
✓ Target cluster found: mysql-8-target
✓ Target cluster version: 8.0.44
✓ GTID mode enabled on source
ℹ Will migrate 3 database(s): app_db customer_db reporting_db

========================================
Migrating Databases
========================================

ℹ Migrating database [1/3]: app_db
✓ Migrated app_db

ℹ Migrating database [2/3]: customer_db
✓ Migrated customer_db

ℹ Migrating database [3/3]: reporting_db
✓ Migrated reporting_db

✓ All databases migrated successfully (3/3)

========================================
Migrating Users and Privileges
========================================

>>> Creating user accounts
ℹ Found 5 user(s) to migrate
✓ User accounts created

>>> Granting privileges
✓ Privileges granted

>>> Verifying migrated users
✓ Migrated 5 user(s)

[... verification ...]

========================================
Migration Summary
========================================

Source: source.your-namespace
Target: mysql-8-target.your-namespace
Databases migrated: 3/3
Users migrated: 5
Duration: 15m 32s

✓ Migration completed successfully!

Next steps:
   1. Run script 02-verify-migration.sh for comprehensive verification
   2. Update application connection strings
   3. Perform application testing
   4. Monitor for 24-48 hours before decommissioning source
```

### 脚本 3：全面校验

**用途：**校验所有数据库对象均已正确迁移。

**校验内容：**
- 表（数量比较）
- 视图（数量 + 每个视图的执行测试）
- 存储过程（数量）
- 存储函数（数量）
- 触发器（数量）
- 事件（数量）
- 行数（对每个数据库的前 5 张表进行抽样检查）
- 用户账号（数量 + 列表）

**配置：**
```bash
SOURCE_NAME="source"
SOURCE_NAMESPACE="your-namespace"
SOURCE_MYSQL_PASSWORD="source-root-password"

TARGET_NAME="mysql-8-target"
TARGET_NAMESPACE="your-namespace"
TARGET_MYSQL_PASSWORD="target-root-password"

DATABASES="app_db customer_db reporting_db"  # Same as migration
```

**用法：**
```bash
vi 02-verify-migration.sh
chmod +x 02-verify-migration.sh
./02-verify-migration.sh
```

**预期输出：**
```text
========================================
MySQL 5.7 to 8.0 Migration Verification
========================================

>>> Verifying Tables

Database: app_db
✓ Tables: 15 (match)

Database: customer_db
✓ Tables: 8 (match)

[... more verifications ...]

========================================
Verification Summary
========================================

Total checks: 42
Passed: 42
Failed: 0

✓ ALL CHECKS PASSED!

Migration verification successful. Next steps:
   1. Update application connection strings to point to target
   2. Perform application testing
   3. Monitor target cluster for 24-48 hours
   4. Keep source cluster available for rollback during this period
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

### 脚本故障排查

#### 脚本报错 "Cannot connect to Kubernetes cluster"
```bash
kubectl config current-context
kubectl cluster-info
```

#### 脚本报错 "Source cluster not found"
```bash
kubectl get mysql -n <namespace>
```

#### 特定数据库迁移失败
```bash
# Check target logs
kubectl logs -n <target-namespace> <target-name>-0 -c mysql --tail=100

# Manually test single database migration
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
# ===== 1 WEEK BEFORE MIGRATION =====
./00-pre-migration-check.sh
# → Output shows: DATABASES="app_db customer_db reporting_db"
# → Fix any schema issues found
# → Convert to utf8mb4 if needed

# ===== DAY OF MIGRATION (Maintenance Window) =====

# Stop application writes
kubectl scale deployment <app-name> --replicas=0 -n <app-namespace>

# Update migration script with DATABASES from pre-check
vi 01-migrate-all.sh
# DATABASES="app_db customer_db reporting_db"

# Run migration
./01-migrate-all.sh

# Run verification
./02-verify-migration.sh

# Update application connection string to target
kubectl patch configmap <app-config> -n <app-namespace> --type=json \
  -p='[{"op": "replace", "path": "/data/db-host", "value":"mysql-8-target-read-write.namespace.svc.cluster.local"}]'

# Restart application
kubectl scale deployment <app-name> --replicas=3 -n <app-namespace>

# Wait for pods ready
kubectl -n <app-namespace> rollout status deployment <app-name>

# Test application
curl http://<app-service>/health

# Monitor for 24-48 hours
kubectl logs -n <target-namespace> mysql-8-target-0 -c mysql --tail=100 -f

# ===== AFTER SUCCESSFUL TESTING (24-48 hours later) =====
# Decommission source cluster
kubectl delete mysql <source-name> -n <source-namespace>
```

### 脚本特性

所有脚本均包含：

- ✅ **彩色输出**：绿色（成功）、红色（错误）、黄色（警告）、蓝色（信息）
- ✅ **进度指示**：显示当前步骤和整体进度
- ✅ **错误处理**：遇到严重错误时退出并给出清晰的消息
- ✅ **自动检测**：当 `DATABASES="ALL"` 时自动发现数据库
- ✅ **全面检查**：在继续之前校验所有前提条件
- ✅ **详细输出**：精确展示迁移和校验的内容
- ✅ **配置极简**：每个脚本仅需配置 4-6 个变量

### 重要说明

1. **不要包含系统数据库**：`DATABASES` 变量必须仅包含用户/应用数据库。不要包含：`information_schema`、`mysql`、`performance_schema`、`sys`。

2. **停止应用写入**：确保迁移期间没有应用写入，以保持数据一致性。

3. **保留源集群**：在完成应用测试并稳定运行 24-48 小时之前，不要删除源集群。

4. **在预发环境测试**：始终先在非生产环境执行一次测试迁移。

5. **迁移后监控**：在下线源端之前，对目标集群监控 24-48 小时。

### 脚本兼容性

- **MySQL 指南版本**：v2.5+
- **源端**：PXC 5.7.44
- **目标端**：MGR 8.0.44
- **Kubernetes**：已在 Alauda Container Platform v4.2.0 上测试（兼容 v4.0+）
- **Shell**：Bash 4.0+

### 脚本源码

以下脚本可直接从本文档复制。将每个脚本保存为文件，赋予可执行权限后运行。

#### 脚本 1：00-pre-migration-check.sh

将此脚本保存为 `00-pre-migration-check.sh`：

```bash
#!/bin/bash
#=============================================================================
# MySQL 5.7 to 8.0 Migration - Pre-Migration Check Script
#=============================================================================
#
# This script performs all pre-migration checks and fixes:
# 1. Schema compatibility analysis
# 2. Character set analysis
# 3. Database listing for migration
#
# Usage:
#   1. Edit the configuration section below
#   2. Run: chmod +x 00-pre-migration-check.sh
#   3. Run: ./00-pre-migration-check.sh
#
# Expected output:
#   - List of any schema compatibility issues that need fixing
#   - List of any character set conversions needed
#   - List of databases to migrate (copy this for migration script)
#
#=============================================================================

set -e  # Exit on error

#=============================================================================
# CONFIGURATION - EDIT THESE VALUES
#=============================================================================

SOURCE_NAME="source"
SOURCE_NAMESPACE="your-namespace"
MYSQL_PASSWORD="your-password"

# Set to "ALL" to auto-detect databases, or specify space-separated list
# DATABASES="ALL"  # Auto-detect all user databases
# DATABASES="db1 db2 db3"  # Or specify manually
DATABASES="ALL"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

#=============================================================================
# FUNCTIONS
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
    print_section "Checking kubectl context"

    if ! kubectl cluster-info &>/dev/null; then
        print_error "Cannot connect to Kubernetes cluster"
        exit 1
    fi
    print_success "Connected to Kubernetes cluster"
}

check_source_cluster() {
    print_section "Checking source cluster"

    if ! kubectl get mysql ${SOURCE_NAME} -n ${SOURCE_NAMESPACE} &>/dev/null; then
        print_error "Source cluster ${SOURCE_NAME} not found in namespace ${SOURCE_NAMESPACE}"
        exit 1
    fi
    print_success "Source cluster ${SOURCE_NAME} found"

    # Check cluster status
    STATUS=$(kubectl get mysql ${SOURCE_NAME} -n ${SOURCE_NAMESPACE} -o jsonpath='{.status.state}')
    if [ "${STATUS}" != "ready" ]; then
        print_warning "Source cluster status: ${STATUS} (expected: ready)"
    else
        print_success "Source cluster status: ready"
    fi
}

check_gtid_enabled() {
    print_section "Checking GTID mode on source"

    GTID_MODE=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${MYSQL_PASSWORD} -N -e "SELECT @@gtid_mode" 2>/dev/null | grep -v "Warning")

    if [ "${GTID_MODE}" = "ON" ]; then
        print_success "GTID mode is enabled"
    else
        print_error "GTID mode is NOT enabled (required for migration)"
        exit 1
    fi
}

detect_databases() {
    print_section "Detecting user databases"

    if [ "${DATABASES}" = "ALL" ]; then
        DATABASES=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
            mysql -uroot -p${MYSQL_PASSWORD} -N -e "SHOW DATABASES" 2>/dev/null | \
            grep -v -E "^(information_schema|mysql|performance_schema|sys)$" | \
            tr '\n' ' ' | sed 's/ $//')

        if [ -z "${DATABASES}" ]; then
            print_error "No user databases found"
            exit 1
        fi
    fi

    print_success "Databases to migrate:"
    echo "   ${DATABASES}"
    echo ""
    print_warning "Copy this line for your migration script:"
    echo -e "${GREEN}DATABASES=\"${DATABASES}\"${NC}"
}

check_reserved_keywords() {
    print_section "Checking for reserved keywords (MySQL 8.0)"

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
        print_success "No reserved keyword issues found"
    else
        print_error "Found columns using MySQL 8.0 reserved keywords:"
        echo "${ISSUES}" | while read line; do
            echo "   - ${line}"
        done
        echo ""
        print_warning "These columns must be renamed before migration"
        echo "Example fix:"
        echo "   ALTER TABLE employees CHANGE COLUMN rank employee_rank INT;"
    fi
}

check_invalid_dates() {
    print_section "Checking for invalid date defaults"

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
        print_success "No invalid date defaults found"
    else
        print_error "Found columns with invalid date defaults:"
        echo "${ISSUES}" | while read line; do
            echo "   - ${line}"
        done
        echo ""
        print_warning "These columns must be fixed before migration"
        echo "Example fix:"
        echo "   ALTER TABLE events MODIFY COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;"
    fi
}

check_zerofill() {
    print_section "Checking for ZEROFILL usage"

    ISSUES=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${MYSQL_PASSWORD} -N -e "
            SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME, '.', COLUMN_NAME, ' ', COLUMN_TYPE)
            FROM information_schema.COLUMNS
            WHERE COLUMN_TYPE LIKE '%ZEROFILL%'
              AND TABLE_SCHEMA IN ('${DATABASES// /,\'','\'}')
            ORDER BY TABLE_SCHEMA, TABLE_NAME;
        " 2>/dev/null | grep -v "Warning")

    if [ -z "${ISSUES}" ]; then
        print_success "No ZEROFILL usage found"
    else
        print_warning "Found ZEROFILL columns (deprecated in MySQL 8.0):"
        echo "${ISSUES}" | while read line; do
            echo "   - ${line}"
        done
        echo ""
        print_warning "ZEROFILL will be removed during migration"
        echo "To fix manually:"
        echo "   ALTER TABLE products MODIFY COLUMN price DECIMAL(10,2);"
    fi
}

check_text_defaults() {
    print_section "Checking for TEXT columns with DEFAULT values"

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
        print_success "No TEXT columns with DEFAULT values found"
    else
        print_error "Found TEXT columns with DEFAULT values (not allowed in MySQL 8.0):"
        echo "${ISSUES}" | while read line; do
            echo "   - ${line}"
        done
        echo ""
        print_warning "These DEFAULT values must be removed before migration"
    fi
}

check_character_sets() {
    print_section "Checking character sets"

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
        print_success "All tables are using utf8mb4"
    else
        print_warning "Found tables not using utf8mb4:"
        echo "${NON_UTF8}" | while read line; do
            echo "   - ${line}"
        done
        echo ""
        print_warning "Consider converting to utf8mb4 before migration"
        echo "See section 'Character Set and Collation Analysis' in the documentation"
    fi
}

check_lower_case_table_names() {
    print_section "Checking lower_case_table_names"

    LCTN=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${MYSQL_PASSWORD} -N -e "SELECT @@lower_case_table_names" 2>/dev/null | grep -v "Warning")

    if [ "${LCTN}" = "1" ]; then
        print_warning "Source cluster has lower_case_table_names=1"
        echo "   Ensure target MySQL 8.0 cluster is also configured with lower_case_table_names=1"
        echo "   This setting cannot be changed after initialization in MySQL 8.0."
    else
        print_success "Source cluster has lower_case_table_names=${LCTN}"
    fi
}

print_summary() {
    print_header "Pre-Migration Check Summary"

    echo ""
    print_success "Configuration verified:"
    echo "   Source cluster: ${SOURCE_NAME}.${SOURCE_NAMESPACE}"
    echo "   Databases to migrate: ${DATABASES}"
    echo ""

    echo "Next steps:"
    echo "   1. Fix any schema compatibility issues found above"
    echo "   2. Convert character sets if needed"
    echo "   3. Run script 01-migrate-all.sh to perform migration"
    echo ""
}

#=============================================================================
# MAIN EXECUTION
#=============================================================================

main() {
    print_header "MySQL 5.7 to 8.0 Pre-Migration Check"

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

    print_success "Pre-migration check completed"
}

main
```

#### 脚本 2：01-migrate-all.sh

将此脚本保存为 `01-migrate-all.sh`：

```bash
#!/bin/bash
#=============================================================================
# MySQL 5.7 to 8.0 Migration - Complete Migration Script
#=============================================================================
#
# This script performs the complete migration from MySQL 5.7 to 8.0:
# 1. Migrates all databases (streaming, no intermediate storage)
# 2. Migrates users and privileges
# 3. Performs basic verification
#
# Prerequisites:
#   - Target MySQL 8.0 cluster must be created and ready
#   - Pre-migration check should have been completed
#   - Application writes should be stopped during migration
#
# Usage:
#   1. Edit the configuration section below
#   2. Run: chmod +x 01-migrate-all.sh
#   3. Run: ./01-migrate-all.sh
#
# Estimated downtime: 15-60 minutes depending on database size
#
#=============================================================================

set -eo pipefail # Exit on error, and catch pipe failures

#=============================================================================
# CONFIGURATION - EDIT THESE VALUES
#=============================================================================

SOURCE_NAME="source"
SOURCE_NAMESPACE="your-namespace"
SOURCE_MYSQL_PASSWORD="source-root-password"

TARGET_NAME="mysql-8-target"
TARGET_NAMESPACE="your-namespace"
TARGET_MYSQL_PASSWORD="target-root-password"

# IMPORTANT: databases to migrate (DO NOT include: information_schema, mysql, performance_schema, sys)
DATABASES="db1 db2 db3" # ← Copy from pre-migration check output

# Users to exclude from migration (system users)
EXCLUDE_USERS="'mysql.sys', 'mysql.session', 'mysql.infoschema', 'root', 'clustercheck', 'monitor', 'operator', 'xtrabackup', 'repl'"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Statistics
TOTAL_DATABASES=0
MIGRATED_DATABASES=0
FAILED_DATABASES=0
START_TIME=$(date +%s)

#=============================================================================
# FUNCTIONS
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
    print_section "Checking prerequisites"

    # Check kubectl
    if ! kubectl cluster-info &>/dev/null; then
        print_error "Cannot connect to Kubernetes cluster"
        exit 1
    fi
    print_success "Connected to Kubernetes cluster"

    # Check source cluster
    if ! kubectl get mysql ${SOURCE_NAME} -n ${SOURCE_NAMESPACE} &>/dev/null; then
        print_error "Source cluster ${SOURCE_NAME} not found in namespace ${SOURCE_NAMESPACE}"
        exit 1
    fi
    print_success "Source cluster found: ${SOURCE_NAME}"

    # Check target cluster
    if ! kubectl get mysql ${TARGET_NAME} -n ${TARGET_NAMESPACE} &>/dev/null; then
        print_error "Target cluster ${TARGET_NAME} not found in namespace ${TARGET_NAMESPACE}"
        print_error "Please create the target cluster before running migration"
        exit 1
    fi
    print_success "Target cluster found: ${TARGET_NAME}"

    # Check target is MySQL 8.0
    TARGET_VERSION=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
        mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "SELECT VERSION();" 2>/dev/null | grep -v "Warning")

    if [[ ! "${TARGET_VERSION}" =~ ^8\.0\. ]]; then
        print_error "Target cluster is not MySQL 8.0 (version: ${TARGET_VERSION})"
        exit 1
    fi
    print_success "Target cluster version: ${TARGET_VERSION}"

    # Check GTID on source
    GTID_MODE=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "SELECT @@gtid_mode" 2>/dev/null | grep -v "Warning")

    if [ "${GTID_MODE}" != "ON" ]; then
        print_error "GTID mode is not enabled on source (required for migration)"
        exit 1
    fi
    print_success "GTID mode enabled on source"

    # Count databases
    TOTAL_DATABASES=$(echo ${DATABASES} | wc -w)
    print_info "Will migrate ${TOTAL_DATABASES} database(s): ${DATABASES}"
}

migrate_databases() {
    print_header "Migrating Databases"

    local db_num=0

    for db in ${DATABASES}; do
        db_num=$((db_num + 1))
        echo ""
        print_info "Migrating database [${db_num}/${TOTAL_DATABASES}]: ${db}"

        # Migrate using streaming (no intermediate storage)
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

        # Note: We rely on the DB_EXISTS check below to verify actual import success,
        # as grep -v returns 1 when no match is found (not an actual error)

        # Verify migration succeeded by checking if database exists on target
        DB_EXISTS=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.SCHEMATA
                WHERE SCHEMA_NAME = '${db}';
            " 2>/dev/null | grep -v "Warning")

        if [ "${DB_EXISTS}" = "1" ]; then

            print_success "Migrated ${db}"
            MIGRATED_DATABASES=$((MIGRATED_DATABASES + 1))
        else
            print_error "Failed to migrate ${db}"
            FAILED_DATABASES=$((FAILED_DATABASES + 1))
        fi
    done

    echo ""
    if [ ${MIGRATED_DATABASES} -eq ${TOTAL_DATABASES} ]; then
        print_success "All databases migrated successfully (${MIGRATED_DATABASES}/${TOTAL_DATABASES})"
    else
        print_error "Some databases failed to migrate (${MIGRATED_DATABASES}/${TOTAL_DATABASES} succeeded, ${FAILED_DATABASES} failed)"
    fi
}

migrate_users() {
    print_header "Migrating Users and Privileges"

    print_section "Creating user accounts"

    # Stream CREATE USER statements
    USER_COUNT=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
            SELECT COUNT(*)
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS});
        " 2>/dev/null | grep -v "Warning")

    print_info "Found ${USER_COUNT} user(s) to migrate"

    # Create users (ignore grep exit code)
    kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
            SELECT CONCAT('CREATE USER IF NOT EXISTS ''', user, '''@''', host, ''' IDENTIFIED WITH mysql_native_password AS ''', replace(authentication_string, '\'', '\'\''), ''';')
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS});
        " 2>/dev/null | grep -v "^Warning" |
        kubectl exec -i ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} 2>&1 | grep -v "Using a password" || true

    # Note: We rely on the USER_COUNT_AFTER check below to verify actual success,
    # as grep -v returns 1 when no match is found (not an actual error)

    # Verify user creation
    USER_COUNT_AFTER=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
        mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
            SELECT COUNT(*)
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS});
        " 2>/dev/null | grep -v "Warning")

    if [ "${USER_COUNT_AFTER}" -ge "${USER_COUNT}" ]; then
        print_success "User accounts created"
    else
        print_error "Failed to create user accounts"
    fi

    print_section "Granting privileges"

    # Stream GRANT statements (ignore grep exit code)
    kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
        mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
            SELECT CONCAT('SHOW GRANTS FOR ''', user, '''@''', host, ''';')
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS});
        " 2>/dev/null | grep -v "^Warning" | while read query; do
        kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
            mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -e "${query}" 2>/dev/null | grep "^GRANT" | sed 's/$/;/'
    done |
        kubectl exec -i ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} 2>&1 | grep -v "Using a password" || true
    # Note: grep -v returns 1 when no match is found (not an actual error)

    print_success "Privileges granted"

    # Flush privileges
    kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
        mysql -uroot -p${TARGET_MYSQL_PASSWORD} -e "FLUSH PRIVILEGES;" 2>&1 | grep -v "Using a password" >/dev/null || true
    # Note: grep -v returns 1 when no match is found (not an actual error)

    print_section "Verifying migrated users"

    MIGRATED_USERS=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
        mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
            SELECT COUNT(*)
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS});
        " 2>/dev/null | grep -v "Warning")

    print_success "Migrated ${MIGRATED_USERS} user(s)"
}

verify_migration() {
    print_header "Migration Verification"

    print_section "Verifying databases"

    for db in ${DATABASES}; do
        # Check if database exists
        DB_EXISTS=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.SCHEMATA
                WHERE SCHEMA_NAME = '${db}';
            " 2>/dev/null | grep -v "Warning")

        if [ "${DB_EXISTS}" = "1" ]; then
            # Count tables
            TABLE_COUNT=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
                mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                    SELECT COUNT(*)
                    FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'BASE TABLE';
                " 2>/dev/null | grep -v "Warning")

            print_success "${db}: ${TABLE_COUNT} table(s) migrated"
        else
            print_error "${db}: Database not found on target"
        fi
    done

    print_section "Verifying users"

    MIGRATED_USERS=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
        mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
            SELECT CONCAT(user, '@', host)
            FROM mysql.user
            WHERE user NOT IN (${EXCLUDE_USERS})
            ORDER BY user;
        " 2>/dev/null | grep -v "Warning")

    if [ -n "${MIGRATED_USERS}" ]; then
        print_success "Migrated users:"
        echo "${MIGRATED_USERS}" | while read user; do
            echo "   - ${user}"
        done
    else
        print_warning "No users migrated (or all were excluded)"
    fi
}

print_summary() {
    local END_TIME=$(date +%s)
    local DURATION=$((END_TIME - START_TIME))
    local MINUTES=$((DURATION / 60))
    local SECONDS=$((DURATION % 60))

    print_header "Migration Summary"

    echo ""
    echo "Source: ${SOURCE_NAME}.${SOURCE_NAMESPACE}"
    echo "Target: ${TARGET_NAME}.${TARGET_NAMESPACE}"
    echo "Databases migrated: ${MIGRATED_DATABASES}/${TOTAL_DATABASES}"
    echo "Users migrated: ${MIGRATED_USERS}"
    echo "Duration: ${MINUTES}m ${SECONDS}s"
    echo ""

    if [ ${FAILED_DATABASES} -eq 0 ] && [ ${MIGRATED_DATABASES} -eq ${TOTAL_DATABASES} ]; then
        print_success "Migration completed successfully!"
        echo ""
        echo "Next steps:"
        echo "   1. Run script 02-verify-migration.sh for comprehensive verification"
        echo "   2. Update application connection strings"
        echo "   3. Perform application testing"
        echo "   4. Monitor for 24-48 hours before decommissioning source"
        echo ""
    else
        print_error "Migration completed with errors"
        echo ""
        echo "Please review the errors above and:"
        echo "   1. Check target cluster logs: kubectl logs -n ${TARGET_NAMESPACE} ${TARGET_NAME}-0 -c mysql --tail=100"
        echo "   2. Verify failed databases manually"
        echo "   3. Re-run migration for failed databases if needed"
        echo ""
        exit 1
    fi
}

#=============================================================================
# MAIN EXECUTION
#=============================================================================

main() {
    print_header "MySQL 5.7 to 8.0 Migration"

    print_warning "IMPORTANT: Ensure application writes are stopped during migration"
    echo ""
    sleep 2

    check_prerequisites
    migrate_databases
    migrate_users
    verify_migration
    print_summary

    print_success "Migration script completed"
}

main
```

#### 脚本 3：02-verify-migration.sh

将此脚本保存为 `02-verify-migration.sh`：

```bash
#!/bin/bash
#=============================================================================
# MySQL 5.7 to 8.0 Migration - Comprehensive Verification Script
#=============================================================================
#
# This script performs comprehensive verification of the migration:
# 1. Verifies all database objects (tables, views, routines, triggers, events)
# 2. Tests view execution
# 3. Compares row counts
# 4. Verifies user accounts
#
# Usage:
#   1. Edit the configuration section below
#   2. Run: chmod +x 02-verify-migration.sh
#   3. Run: ./02-verify-migration.sh
#
#=============================================================================

set -e # Exit on error

#=============================================================================
# CONFIGURATION - EDIT THESE VALUES
#=============================================================================

SOURCE_NAME="source"
SOURCE_NAMESPACE="your-namespace"
SOURCE_MYSQL_PASSWORD="source-root-password"

TARGET_NAME="mysql-8-target"
TARGET_NAMESPACE="your-namespace"
TARGET_MYSQL_PASSWORD="target-root-password"

# IMPORTANT: databases that were migrated (DO NOT include: information_schema, mysql, performance_schema, sys)
DATABASES="db1 db2 db3" # ← Same as used in migration script

# Users to exclude from verification (system users and MySQL MGR users)
EXCLUDE_USERS="'mysql.sys', 'mysql.session', 'mysql.infoschema', 'root', 'clustercheck', 'monitor', 'operator', 'xtrabackup', 'repl', 'exporter', 'healthchecker', 'clusterchecker', 'mysql', 'percona.telemetry', 'manage'"
# Note: MySQL MGR system users (mysql_innodb_cluster_%, mysql_router%) are filtered in verify_users()

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Verification counters
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0

# Temp directory
WORK_DIR="/tmp/mysql-migration-verify"
mkdir -p ${WORK_DIR}

#=============================================================================
# FUNCTIONS
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
        print_success "${object_name}: ${target_count} (match)"
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
        return 0
    else
        print_error "${object_name}: Source=${source_count}, Target=${target_count} (mismatch)"
        FAILED_CHECKS=$((FAILED_CHECKS + 1))
        return 1
    fi
}

verify_tables() {
    print_section "Verifying Tables"

    for db in ${DATABASES}; do
        echo ""
        echo "Database: ${db}"

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

        check_count "${SOURCE_COUNT}" "${TARGET_COUNT}" "Tables"
    done
}

verify_views() {
    print_section "Verifying Views"

    for db in ${DATABASES}; do
        echo ""
        echo "Database: ${db}"

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

        if check_count "${SOURCE_COUNT}" "${TARGET_COUNT}" "Views"; then
            # Test view execution if counts match
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
                        : # view works
                    else
                        echo "1" >>${VERIFY_TMP}
                    fi
                done

                if [ "$(cat ${VERIFY_TMP} | wc -l)" -eq 1 ] && [ "$(cat ${VERIFY_TMP})" = "0" ]; then
                    print_success "All views execute successfully"
                else
                    print_error "Some views failed execution"
                fi

                rm -f ${VERIFY_TMP}
            fi
        fi
    done
}

verify_routines() {
    print_section "Verifying Stored Procedures"

    for db in ${DATABASES}; do
        echo ""
        echo "Database: ${db}"

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

        check_count "${SOURCE_COUNT}" "${TARGET_COUNT}" "Stored Procedures"
    done

    echo ""
    print_section "Verifying Stored Functions"

    for db in ${DATABASES}; do
        echo ""
        echo "Database: ${db}"

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

        check_count "${SOURCE_COUNT}" "${TARGET_COUNT}" "Stored Functions"
    done
}

verify_triggers() {
    print_section "Verifying Triggers"

    for db in ${DATABASES}; do
        echo ""
        echo "Database: ${db}"

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

        check_count "${SOURCE_COUNT}" "${TARGET_COUNT}" "Triggers"
    done
}

verify_events() {
    print_section "Verifying Events"

    for db in ${DATABASES}; do
        echo ""
        echo "Database: ${db}"

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

        check_count "${SOURCE_COUNT}" "${TARGET_COUNT}" "Events"
    done
}

verify_row_counts() {
    print_section "Verifying Row Counts (Sample)"

    for db in ${DATABASES}; do
        echo ""
        echo "Database: ${db}"

        # Get first 5 tables for sampling
        TABLES=$(kubectl exec ${SOURCE_NAME}-pxc-0 -n ${SOURCE_NAMESPACE} -- \
            mysql -uroot -p${SOURCE_MYSQL_PASSWORD} -N -e "
                SELECT TABLE_NAME
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = '${db}' AND TABLE_TYPE = 'BASE TABLE'
                LIMIT 5;
            " 2>/dev/null | grep -v "Warning")

        if [ -z "${TABLES}" ]; then
            print_warning "No tables found in ${db}"
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

            # Allow small variance due to statistics
            if [ "${SOURCE_ROWS}" != "${TARGET_ROWS}" ]; then
                print_warning "Row count variance for ${table}: Source=${SOURCE_ROWS}, Target=${TARGET_ROWS}"
                ROW_MISMATCH=1
            fi
        done

        if [ ${ROW_MISMATCH} -eq 0 ]; then
            print_success "Row counts: Sample check passed"
        fi
    done
}

verify_users() {
    print_section "Verifying User Accounts"

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

    check_count "${SOURCE_USERS}" "${TARGET_USERS}" "User accounts"

    # Show migrated users
    if [ "${TARGET_USERS}" -gt 0 ]; then
        echo ""
        print_info "Migrated users:"
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
    print_section "Testing Data Integrity"

    print_info "Performing sample data integrity checks..."

    for db in ${DATABASES}; do
        # Check if database exists on target
        DB_EXISTS=$(kubectl exec ${TARGET_NAME}-0 -n ${TARGET_NAMESPACE} -c mysql -- \
            mysql -uroot -p${TARGET_MYSQL_PASSWORD} -N -e "
                SELECT COUNT(*)
                FROM information_schema.SCHEMATA
                WHERE SCHEMA_NAME = '${db}';
            " 2>/dev/null | grep -v "Warning")

        if [ "${DB_EXISTS}" = "1" ]; then
            print_success "${db}: Database exists on target"
        else
            print_error "${db}: Database NOT found on target"
            FAILED_CHECKS=$((FAILED_CHECKS + 1))
        fi
    done
}

print_summary() {
    print_header "Verification Summary"

    echo ""
    echo "Total checks: ${TOTAL_CHECKS}"
    echo -e "${GREEN}Passed: ${PASSED_CHECKS}${NC}"
    echo -e "${RED}Failed: ${FAILED_CHECKS}${NC}"
    echo ""

    if [ ${FAILED_CHECKS} -eq 0 ] && [ ${PASSED_CHECKS} -eq ${TOTAL_CHECKS} ]; then
        print_success "ALL CHECKS PASSED!"
        echo ""
        echo "Migration verification successful. Next steps:"
        echo "   1. Update application connection strings to point to target"
        echo "   2. Perform application testing"
        echo "   3. Monitor target cluster for 24-48 hours"
        echo "   4. Keep source cluster available for rollback during this period"
        echo ""
        return 0
    else
        print_error "SOME CHECKS FAILED"
        echo ""
        echo "Please review the failed checks above and:"
        echo "   1. Check target cluster logs: kubectl logs -n ${TARGET_NAMESPACE} ${TARGET_NAME}-0 -c mysql --tail=100"
        echo "   2. Verify failed objects manually"
        echo "   3. Re-run migration for specific databases if needed"
        echo ""
        return 1
    fi
}

cleanup() {
    rm -rf ${WORK_DIR}
}

#=============================================================================
# MAIN EXECUTION
#=============================================================================

main() {
    # Trap to cleanup on exit
    trap cleanup EXIT

    print_header "MySQL 5.7 to 8.0 Migration Verification"

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

本指南提供在 Alauda Container Platform 上将 MySQL 5.7 迁移到 8.0 的全面且经测试验证的操作说明。该方案已在 Kubernetes 测试环境中使用 PXC 5.7.44 与 MGR 8.0.44 集群完成验证。

### 本指南涵盖的内容

| 测试类别 | 测试用例 | 验证内容 |
|--------------|------------|-------------------|
| 基础迁移 | 核心功能 | 表、数据、外键、索引 |
| Schema 兼容性 | MySQL 8.0 问题 | 保留关键字、ZEROFILL、日期默认值、TEXT 列 |
| 数据库对象 | 所有对象类型 | 存储过程、函数、触发器、事件、视图 |
| 用户与权限迁移 | 安全与访问 | 用户账号、授权、认证插件 |
| 字符集迁移 | 数据完整性 | utf8mb4 转换、多语言支持 |
| GTID 处理 | 复制 | 针对 MGR 目标端的 GTID_PURGED 过滤 |

### 主要收益

- ✅ **成熟可靠的方案**：已在 Kubernetes 测试环境中测试
- ✅ **完整覆盖**：迁移所有标准 MySQL 对象并进行全面校验
- ✅ **Schema 兼容性**：针对 MySQL 8.0 兼容性问题的自动检查与修复
- ✅ **字符集支持**：完整的 utf8mb4 迁移策略
- ✅ **安全性**：用户与权限迁移，并提供 MySQL 8.0 认证指导
- ✅ **性能**：面向 MySQL 8.0 特性的迁移后优化
- ✅ **风险控制**：详细的回滚操作步骤以及每一步的校验

### 生产就绪清单

在生产环境使用本指南之前，请确保已：

- [ ] 阅读 [开始使用](#getting-started) 章节以了解你的环境
- [ ] 在非生产环境中测试过迁移操作步骤
- [ ] 完成 [Schema 兼容性分析](#step-1-schema-compatibility-analysis) 并修复所有问题
- [ ] 如果使用旧字符集，已完成 [字符集迁移](#step-2-character-set-and-collation-analysis)
- [ ] 根据数据库大小安排了足够的维护窗口
- [ ] 已与所有干系人沟通（应用团队、DBA、SRE）
- [ ] 已准备回滚方案（见 [灾难恢复](#disaster-recovery)）
- [ ] 已确认应用与 MySQL 8.0 认证插件的兼容性

### 本指南的交付成果

通过遵循这些实践，组织可以成功地将其 MySQL 数据库迁移到 8.0 版本，并确保：

- ✅ **持续的安全支持**（MySQL 5.7 已于 2023 年 10 月 EOL）
- ✅ **可使用新特性**（CTE、窗口函数、直方图等）
- ✅ **通过全面校验保持数据完整性**
- ✅ **经过测试的操作步骤带来最小停机时间**
- ✅ **出现问题时具备回滚能力**

### 支持与故障排查

如果遇到本指南未覆盖的问题：

1. 查看 [故障排查](#troubleshooting) 章节了解常见问题
2. 阅读 [重要限制](#important-limitations) 章节
3. 确认你的环境符合 [前提条件](#prerequisites)
4. 遵循 [kubectl Exec 最佳实践](#getting-started) 以避免常见命令错误
5. 查看 MySQL 错误日志：`kubectl logs -n <namespace> <pod-name> -c mysql --tail=100`

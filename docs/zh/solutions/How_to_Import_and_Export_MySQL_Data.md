---
kind:
  - How To
products:
  - Alauda Application Services
ProductsVersion:
  - '4.0,4.1,4.2,4.3'
id: KB260515002
sourceSHA: 5e4fbbb66341d98ab7627d676071d411705a57cd216a36e71c5277fb4456a225
---

# 如何导入和导出 MySQL 数据

## 问题

您需要在两个 MySQL 数据库之间移动业务数据——例如，将数据从自托管的 MySQL 实例迁移到 ACP 平台上的托管 MySQL 集群。该操作步骤必须保持引用完整性（触发器、例程、事件），而不污染目标数据库的源系统表。

## 环境

- 源：任何 MySQL 5.7 或 8.0 数据库
- 目标：MySQL 8.0 数据库，包括在 Alauda Application Services 4.x 下运行的基于 MGR 的 MySQL 集群
- `mysqldump` 工具来自于版本大于或等于目标版本的 MySQL 发布

## 解决方案

### 1. 规划迁移

1. **首先配置目标集群。** 保留足够的存储空间以容纳逻辑转储以及导入的数据集。
2. **决定一致的切换时间。** 如果应用程序无法容忍源和目标之间的不一致，请在进行转储之前停止对源的应用程序写入。否则，依赖 `--single-transaction` 来获得 InnoDB 表的一致性快照。
3. **不要转储系统数据库。** 从另一个 MySQL 实例恢复 `mysql`、`information_schema`、`performance_schema` 或 `sys` 可能会损坏目标的权限和元数据目录。仅转储业务模式。
4. **在目标上重新创建应用程序用户。** 目标开始时有自己的权限目录，因此必须显式创建面向应用程序的帐户。不要重用 `root` 进行应用程序流量；创建具有最低所需权限的专用帐户。

### 2. 选择 `mysqldump` 版本

`mysqldump` 客户端必须至少与目标服务器的版本相同。有两种常见的安排：

- 从目标 pod / 主机内部运行 `mysqldump`，该主机已经提供了兼容的二进制文件；或者
- 在具有网络访问源的跳板主机上安装适当版本的独立 `mysqldump`。

在开始之前确认服务器和客户端版本：

```bash
mysql --version
mysqldump --version
```

### 3. 导出源业务模式

使用单个事务转储来捕获触发器、例程和事件，并写入源 GTID 集，以便目标可以在需要时重放 binlog 位置：

```bash
mysqldump \
  --host=<source-host> \
  --user=root \
  --password='<source-password>' \
  --single-transaction \
  --source-data=1 \
  --set-gtid-purged=AUTO \
  --triggers \
  --routines \
  --events \
  --databases <db1> <db2> ... \
  > <YYYYMMDD>_fullbackup.sql
```

标志说明：

- `--single-transaction` — InnoDB 表的一致性快照，无需表锁。
- `--source-data=1` — 在转储中嵌入 `CHANGE MASTER` / binlog 位置元数据。
- `--set-gtid-purged=AUTO` — 当源使用 GTID 时保留 GTID 信息。
- `--triggers --routines --events` — 包括存储程序和事件调度程序条目。
- `--databases` — 仅转储列出的模式；切勿使用 `--all-databases`。

对于 MySQL 5.7 源，将 `--source-data=1` 替换为 `--master-data=1`。

### 4. 导入到目标

使用相同的凭据和数据库列表运行 `mysql` 针对目标。转储文件是自包含的，因此单次调用会重新创建模式、表和存储程序：

```bash
mysql \
  --host=<destination-host> \
  --user=root \
  --password='<destination-password>' \
  < <YYYYMMDD>_fullbackup.sql
```

对于非常大的转储，建议在接近目标的位置（同一 VPC / 同一节点）运行导入，以减少网络往返开销。

### 5. 导入后验证

1. 计算两侧业务表中的行数：
   ```sql
   SELECT COUNT(*) FROM <db>.<table>;
   ```
2. 在目标上重新创建应用程序用户，授予最低所需权限：
   ```sql
   CREATE USER 'app'@'%' IDENTIFIED BY '<strong-password>';
   GRANT SELECT, INSERT, UPDATE, DELETE ON <db>.* TO 'app'@'%';
   FLUSH PRIVILEGES;
   ```
3. 将应用程序指向目标，并在退役源之前确认读/写流量。

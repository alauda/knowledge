---
kind:
  - How To
products:
  - Alauda Application Services
ProductsVersion:
  - '4.0,4.1,4.2,4.3'
id: KB260515004
sourceSHA: c8db6adb77277fe8a0bdeb6d1a1f5c6493557e1cd912c2a28a5854671146b231
---

# 如何验证 MySQL InnoDB 集群数据的导入和导出

## 问题

您希望进行一个可重复的端到端练习，以验证针对 MySQL InnoDB 集群（组复制）实例的逻辑导入和导出：将示例数据集加载到 PRIMARY，启用 `secure_file_priv` 和 `local_infile` 以便客户端工具可以读取和写入文件，并使用工作台风格的客户端或 `mysqldump` 进行数据的往返传输。本指南将通过使用公共的 `employees` 示例数据库来逐步讲解操作步骤。

## 环境

- Alauda Application Services for MySQL 4.0 及更高版本
- 一个运行中的 MGR 实例（`Mysql` CR），至少有一个 ONLINE PRIMARY 和两个 ONLINE SECONDARY 成员
- 通过 `kubectl` 访问集群
- 一台安装了 `mysql` 客户端、`tar`，并可选安装 MySQL Workbench 的工作站

## 解决方案

### 1. 准备 `employees` 示例数据库

在任何可以访问集群的主机上下载并解压示例数据集：

```bash
wget https://launchpadlibrarian.net/24493586/employees_db-full-1.0.6.tar.bz2
tar -xjvf employees_db-full-1.0.6.tar.bz2
```

编辑 `employees_db/employees.sql`，注释掉在 MySQL 8.0 中不再存在的遗留 `storage_engine` 指令；否则加载器会因未知变量错误而失败：

```sql
-- set storage_engine = InnoDB;
-- set storage_engine = MyISAM;
-- set storage_engine = Falcon;
-- set storage_engine = PBXT;
-- set storage_engine = Maria;
-- select CONCAT('storage engine: ', @@storage_engine) as INFO;
```

### 2. 确定 PRIMARY 成员

`employees.sql` 加载器执行 DDL 和 DML，因此必须在 PRIMARY 上运行：

```bash
kubectl -n <namespace> get pod -owide

kubectl -n <namespace> exec -it <instance>-0 -c mysql -- \
  mysql -uroot -p"$MYSQL_PASSWORD" -e \
  "SELECT MEMBER_HOST, MEMBER_PORT, MEMBER_STATE, MEMBER_ROLE
   FROM performance_schema.replication_group_members;"
```

预期输出：

```
+---------------------+-------------+--------------+-------------+
| MEMBER_HOST         | MEMBER_PORT | MEMBER_STATE | MEMBER_ROLE |
+---------------------+-------------+--------------+-------------+
| <instance>-0.<inst> |        3306 | ONLINE       | PRIMARY     |
| <instance>-1.<inst> |        3306 | ONLINE       | SECONDARY   |
| <instance>-2.<inst> |        3306 | ONLINE       | SECONDARY   |
+---------------------+-------------+--------------+-------------+
```

注意承载 PRIMARY 的 pod（`<primary-pod>`）以便进行下一步。

### 3. 将示例数据集复制到 PRIMARY pod

只有容器内的 `/var/lib/mysql` 目录可由 `mysql` 用户写入。

```bash
kubectl cp -n <namespace> -c mysql ./employees_db <primary-pod>:/var/lib/mysql/
kubectl -n <namespace> exec -it <primary-pod> -c mysql -- ls -lh /var/lib/mysql/employees_db
```

### 4. 在 PRIMARY 上加载示例数据库

```bash
kubectl -n <namespace> exec -it <primary-pod> -c mysql -- bash -c \
  'cd /var/lib/mysql/employees_db && mysql -uroot -p"$MYSQL_PASSWORD" < employees.sql'
```

成功的输出包括 `CREATING DATABASE STRUCTURE`，后面跟着重复的 `LOADING <table>` 行。

加载成功后，删除准备目录，以免 MySQL 将其视为数据库目录：

```bash
kubectl -n <namespace> exec -it <primary-pod> -c mysql -- rm -rf /var/lib/mysql/employees_db
```

### 5. 启用文件导入和导出

默认情况下，服务器限制了 `secure_file_priv` 和 `local_infile`：

```sql
SELECT @@secure_file_priv, @@local_infile;
-- +-----------------------+----------------+
-- | /var/lib/mysql-files/ |              0 |
-- +-----------------------+----------------+
```

编辑 `Mysql` CR，并在 `spec.params.mysql.mysqld` 下设置值：

```yaml
spec:
  params:
    mysql:
      mysqld:
        secure_file_priv: ""   # 空字符串 = 不受限制；或设置为目录以限制 LOAD DATA / SELECT ... INTO OUTFILE
        local_infile: "1"       # 启用 LOAD DATA LOCAL INFILE
```

重新应用 CR。操作员会执行滚动重启。重新检查：

```sql
SELECT @@secure_file_priv, @@local_infile;
-- +--------------------+----------------+
-- |                    |              1 |
-- +--------------------+----------------+
```

> 将 `secure_file_priv` 设置为空字符串会移除所有服务器端对 `LOAD DATA`、`SELECT ... INTO OUTFILE` 和 `LOAD_FILE()` 使用的文件路径的限制。在生产环境中，应将其限制为专用目录，而不是保持不受限制。

### 6. 通过路由器连接工作台客户端

检索实例的路由器服务（NodePort 或 LoadBalancer）：

```bash
kubectl -n <namespace> get svc <instance>-router
```

在 MySQL Workbench（或任何兼容的 GUI 客户端）中，使用 root 凭据创建与路由器主机和读写端口的连接。

### 7. 导出表

首先检查源数据的完整性：

```sql
SELECT COUNT(*) FROM employees.departments;
```

`employees` 架构受到了大量外键约束；在进行往返测试时，删除表时暂停约束，并在之后重新启用它们：

```sql
SET FOREIGN_KEY_CHECKS = 0;
-- ... 删除 / 导入操作 ...
SET FOREIGN_KEY_CHECKS = 1;
```

使用 `mysqldump` 的等效 CLI 导出：

```bash
mysqldump -h <router-host> -P <router-rw-port> -uroot -p"$MYSQL_PASSWORD" \
  --set-gtid-purged=OFF \
  employees departments > employees_departments.sql
```

Workbench 等效操作：**服务器 → 数据导出**，选择 `employees.departments`，并写入 `employees_departments.sql`。生成的转储以标准的 `mysqldump` 头开始，并包含 `CREATE TABLE` 和 `INSERT` 语句。

### 8. 重新导入转储

在集群上删除表，然后重新导入：

```sql
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE employees.departments;
SET FOREIGN_KEY_CHECKS = 1;
```

```bash
mysql -h <router-host> -P <router-rw-port> -uroot -p"$MYSQL_PASSWORD" \
  employees < employees_departments.sql
```

Workbench 等效操作：**服务器 → 数据导入 → 从自包含文件导入**，选择 `employees_departments.sql`，目标架构为 `employees`，然后 **开始导入**。

验证行数与导出前的值匹配：

```sql
SELECT COUNT(*) FROM employees.departments;
```

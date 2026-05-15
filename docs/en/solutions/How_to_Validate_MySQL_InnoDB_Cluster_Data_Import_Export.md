---
kind:
   - How To
products:
  - Alauda Application Services
ProductsVersion:
   - 4.0,4.1,4.2,4.3
id: KB260515004
---

# How to Validate MySQL InnoDB Cluster Data Import and Export

## Issue

You want a repeatable, end-to-end exercise to validate logical import and export against a MySQL InnoDB Cluster (Group Replication) instance: loading a sample dataset onto the PRIMARY, enabling `secure_file_priv` and `local_infile` so client tools can read and write files, and round-tripping data with a workbench-style client or `mysqldump`. This how-to walks through the procedure using the public `employees` sample database.

## Environment

- Alauda Application Services for MySQL 4.0 and later
- A running MGR instance (`Mysql` CR) with at least one ONLINE PRIMARY and two ONLINE SECONDARY members
- Cluster access via `kubectl`
- A workstation with the `mysql` client, `tar`, and optionally MySQL Workbench

## Resolution

### 1. Stage the `employees` sample database

Download and extract the sample dataset on any host that can reach the cluster:

```bash
wget https://launchpadlibrarian.net/24493586/employees_db-full-1.0.6.tar.bz2
tar -xjvf employees_db-full-1.0.6.tar.bz2
```

Edit `employees_db/employees.sql` and comment out the legacy `storage_engine` directives that no longer exist in MySQL 8.0; otherwise the loader fails with an unknown-variable error:

```sql
-- set storage_engine = InnoDB;
-- set storage_engine = MyISAM;
-- set storage_engine = Falcon;
-- set storage_engine = PBXT;
-- set storage_engine = Maria;
-- select CONCAT('storage engine: ', @@storage_engine) as INFO;
```

### 2. Identify the PRIMARY member

The `employees.sql` loader executes DDL and DML, so it must run against the PRIMARY:

```bash
kubectl -n <namespace> get pod -owide

kubectl -n <namespace> exec -it <instance>-0 -c mysql -- \
  mysql -uroot -p"$MYSQL_PASSWORD" -e \
  "SELECT MEMBER_HOST, MEMBER_PORT, MEMBER_STATE, MEMBER_ROLE
   FROM performance_schema.replication_group_members;"
```

Expected output:

```
+---------------------+-------------+--------------+-------------+
| MEMBER_HOST         | MEMBER_PORT | MEMBER_STATE | MEMBER_ROLE |
+---------------------+-------------+--------------+-------------+
| <instance>-0.<inst> |        3306 | ONLINE       | PRIMARY     |
| <instance>-1.<inst> |        3306 | ONLINE       | SECONDARY   |
| <instance>-2.<inst> |        3306 | ONLINE       | SECONDARY   |
+---------------------+-------------+--------------+-------------+
```

Note the pod that hosts the PRIMARY (`<primary-pod>`) for the next step.

### 3. Copy the sample dataset to the PRIMARY pod

Only `/var/lib/mysql` inside the container is writable by the `mysql` user.

```bash
kubectl cp -n <namespace> -c mysql ./employees_db <primary-pod>:/var/lib/mysql/
kubectl -n <namespace> exec -it <primary-pod> -c mysql -- ls -lh /var/lib/mysql/employees_db
```

### 4. Load the sample database on the PRIMARY

```bash
kubectl -n <namespace> exec -it <primary-pod> -c mysql -- bash -c \
  'cd /var/lib/mysql/employees_db && mysql -uroot -p"$MYSQL_PASSWORD" < employees.sql'
```

Successful output includes `CREATING DATABASE STRUCTURE` followed by repeated `LOADING <table>` lines.

After the load succeeds, remove the staging directory so MySQL does not treat it as a database directory:

```bash
kubectl -n <namespace> exec -it <primary-pod> -c mysql -- rm -rf /var/lib/mysql/employees_db
```

### 5. Enable file import and export

By default the server restricts both `secure_file_priv` and `local_infile`:

```sql
SELECT @@secure_file_priv, @@local_infile;
-- +-----------------------+----------------+
-- | /var/lib/mysql-files/ |              0 |
-- +-----------------------+----------------+
```

Edit the `Mysql` CR and set the values under `spec.paras.mysqld`:

```yaml
spec:
  paras:
    mysqld:
      secure_file_priv: ""   # empty string = unrestricted; or set to a directory to scope LOAD DATA / SELECT ... INTO OUTFILE
      local_infile: "1"       # enable LOAD DATA LOCAL INFILE
```

Re-apply the CR. The operator performs a rolling restart. Re-check:

```sql
SELECT @@secure_file_priv, @@local_infile;
-- +--------------------+----------------+
-- |                    |              1 |
-- +--------------------+----------------+
```

> Setting `secure_file_priv` to an empty string removes all server-side restrictions on file paths used by `LOAD DATA`, `SELECT ... INTO OUTFILE`, and `LOAD_FILE()`. In production, restrict it to a dedicated directory rather than leaving it unrestricted.

### 6. Connect a workbench client through the Router

Retrieve the Router service (NodePort or LoadBalancer) of the instance:

```bash
kubectl -n <namespace> get svc <instance>-router
```

In MySQL Workbench (or any compatible GUI client), create a connection to the Router host and the read-write port using the root credentials.

### 7. Export a table

Sanity-check the source data first:

```sql
SELECT COUNT(*) FROM employees.departments;
```

The `employees` schema is heavily foreign-key constrained; suspend constraints when dropping tables for round-trip tests and re-enable them afterwards:

```sql
SET FOREIGN_KEY_CHECKS = 0;
-- ... drop / import operations ...
SET FOREIGN_KEY_CHECKS = 1;
```

Equivalent CLI export with `mysqldump`:

```bash
mysqldump -h <router-host> -P <router-rw-port> -uroot -p"$MYSQL_PASSWORD" \
  --set-gtid-purged=OFF \
  employees departments > employees_departments.sql
```

Workbench equivalent: **Server → Data Export**, select `employees.departments`, and write to `employees_departments.sql`. The resulting dump begins with the standard `mysqldump` header and contains `CREATE TABLE` plus `INSERT` statements.

### 8. Import the dump back

Drop the table on the cluster, then re-import:

```sql
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE employees.departments;
SET FOREIGN_KEY_CHECKS = 1;
```

```bash
mysql -h <router-host> -P <router-rw-port> -uroot -p"$MYSQL_PASSWORD" \
  employees < employees_departments.sql
```

Workbench equivalent: **Server → Data Import → Import from Self-Contained File**, choose `employees_departments.sql`, target schema `employees`, then **Start Import**.

Verify the row count matches the pre-export value:

```sql
SELECT COUNT(*) FROM employees.departments;
```

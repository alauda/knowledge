---
kind:
   - How To
products:
  - Alauda Application Services
ProductsVersion:
   - 4.0,4.1,4.2,4.3
id: KB260515002
---

# How to Import and Export MySQL Data

## Issue

You need to move business data between two MySQL databases — for example, migrating data from a self-hosted MySQL instance into a managed MySQL cluster on the ACP platform. The procedure must preserve referential integrity (triggers, routines, events) without polluting the destination with the source's system tables.

## Environment

- Source: any MySQL 5.7 or 8.0 database
- Destination: a MySQL 8.0 database, including an MGR-based MySQL cluster running under Alauda Application Services 4.x
- `mysqldump` utility from a MySQL release greater than or equal to the destination version

## Resolution

### 1. Plan the migration

1. **Provision the destination cluster first.** Reserve enough storage to hold the logical dump in addition to the imported data set.
2. **Decide on a consistent cutover.** If the application cannot tolerate inconsistencies between the source and destination, stop application writes to the source before taking the dump. Otherwise rely on `--single-transaction` for a transactionally consistent snapshot of InnoDB tables.
3. **Do not dump system databases.** Restoring `mysql`, `information_schema`, `performance_schema`, or `sys` from another MySQL instance can corrupt the destination's privilege and metadata catalogues. Only dump the business schemas.
4. **Recreate application users on the destination.** The destination starts with its own privilege catalogue, so application-facing accounts must be created explicitly. Do not reuse `root` for application traffic; create dedicated accounts with the minimum required grants.

### 2. Choose a `mysqldump` version

The `mysqldump` client must be at least the version of the destination server. Two common arrangements:

- Run `mysqldump` from inside a destination pod / host, which already ships a compatible binary; or
- Install a standalone `mysqldump` of an appropriate version on a jump host with network access to the source.

Confirm both server and client versions before starting:

```bash
mysql --version
mysqldump --version
```

### 3. Export the source business schemas

Use a single transactional dump that captures triggers, routines, and events, and writes the source GTID set so the destination can replay binlog positions if needed:

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

Flag notes:

- `--single-transaction` — consistent snapshot of InnoDB tables without table locks.
- `--source-data=1` — embed `CHANGE MASTER` / binlog position metadata in the dump.
- `--set-gtid-purged=AUTO` — preserve GTID information when the source uses GTIDs.
- `--triggers --routines --events` — include stored programs and event scheduler entries.
- `--databases` — dump only the listed schemas; never use `--all-databases`.

For MySQL 5.7 sources, replace `--source-data=1` with `--master-data=1`.

### 4. Import into the destination

Run `mysql` against the destination using the same credentials and database list. The dump file is self-contained, so a single invocation re-creates schemas, tables, and stored programs:

```bash
mysql \
  --host=<destination-host> \
  --user=root \
  --password='<destination-password>' \
  < <YYYYMMDD>_fullbackup.sql
```

For very large dumps, prefer running the import close to the destination (same VPC / same node) to reduce network round-trip overhead.

### 5. Post-import verification

1. Count rows in a sample of business tables on both sides:
   ```sql
   SELECT COUNT(*) FROM <db>.<table>;
   ```
2. Re-create application users on the destination with the minimum required grants:
   ```sql
   CREATE USER 'app'@'%' IDENTIFIED BY '<strong-password>';
   GRANT SELECT, INSERT, UPDATE, DELETE ON <db>.* TO 'app'@'%';
   FLUSH PRIVILEGES;
   ```
3. Point the application at the destination and confirm read/write traffic before decommissioning the source.

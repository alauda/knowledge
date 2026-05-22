---
kind:
   - How To
products:
  - Alauda Application Services
ProductsVersion:
   - 4.0,4.1,4.2,4.3
id: KB260515006
---

# Configure MySQL Audit Log Filter Plugin

## Issue

You need to capture an audit trail of connection events, DDL, and DML on a MySQL 8.0 instance. MySQL Community Server does not ship the proprietary `audit_log.so` plugin from MySQL Enterprise, but Percona Server provides a drop-in replacement, `audit_log_filter.so`, that emits per-event JSON records and supports event-class filtering. This how-to enables the plugin on a `Mysql` CR-managed instance, defines a sensible default filter set, and verifies the output.

## Environment

- Alauda Application Services for MySQL 4.0 and later
- MySQL Server 8.0.36 or later (the plugin requires this minimum patch level)
- Cluster access via `kubectl`

> The plugin is shipped as a preview feature in MySQL 8.0 and is generally available in MySQL 8.4. Treat it as feature-stable for the audit pipeline but expect minor variable renames between point releases.

## Resolution

### 1. Load the plugin via the `Mysql` CR

Set the plugin and its configuration variables under `spec.params.mysql.mysqld`. Use `loose_` prefixed variables so the server does not refuse to start if the plugin is not yet loaded:

```yaml
spec:
  params:
    mysql:
      mysqld:
        plugin_load_add: "audit_log_filter.so"
        loose_audit_log_filter_format: "JSON"
        loose_audit_log_filter_rotate_on_size: "104857600"
```

Variable meaning:

- `plugin_load_add` — additionally load the named plugin at startup.
- `loose_audit_log_filter_format` — output format. `JSON` is recommended for downstream parsing.
- `loose_audit_log_filter_rotate_on_size` — file-rotation size in bytes (here, 100 MiB). The plugin keeps up to 1 GiB of rotated history by default.

Full variable reference: [Percona audit log filter variables](https://docs.percona.com/percona-server/8.0/audit-log-filter-variables.html).

Apply the change. The operator performs a rolling restart of the MySQL pods.

### 2. Verify the plugin is loaded

After the rolling restart completes, connect to the read-write service and check the plugin status plus its variables:

```sql
SELECT PLUGIN_NAME, PLUGIN_STATUS
FROM information_schema.PLUGINS
WHERE PLUGIN_NAME LIKE '%audit%'\G

SHOW GLOBAL VARIABLES LIKE 'audit_log_filter%';
```

Confirm that `AUDIT_LOG_FILTER` is `ACTIVE` and that the variable values match the YAML you applied.

### 3. Initialize the plugin

The plugin ships an initialization script that creates its filter tables in the `mysql` system schema. Run it once against the read-write endpoint:

```bash
mysql -h <cluster>-read-write -uroot -p \
  < /usr/share/percona-server/audit_log_filter_linux_install.sql
```

Enter the root password when prompted.

### 4. Define and attach filters

Connect to the read-write endpoint and create two filters:

- `quiet` for the operator's health-check and management users, to avoid flooding the log with no-op queries.
- `default` for every other user, recording connect/disconnect events, general statements, and write-side table access.

Run the following against the read-write endpoint:

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

Adjust the filter JSON to match the auditing scope you actually need. The full schema is documented at [audit log filter definitions](https://dev.mysql.com/doc/refman/8.4/en/audit-log-filter-definitions.html).

### 5. Detach or remove filters

Detach a filter from a user (`%` matches all otherwise-unconfigured users; substitute an actual `user@host` to detach for a single account):

```sql
SELECT audit_log_filter_remove_user('%');
```

Delete a filter definition:

```sql
SELECT audit_log_filter_remove_filter('default');
```

### 6. Inspect the audit log files

The audit log files live alongside the MySQL data directory inside every MySQL pod. List them on a given pod:

```bash
kubectl -n <namespace> exec -it <pod> -c mysql -- \
  ls -lh /var/lib/mysql/audit_filter*
```

Each rotated file is JSON-line formatted and ready to ship to a log aggregator.

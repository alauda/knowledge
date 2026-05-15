---
kind:
   - How To
products:
  - Alauda Application Services
ProductsVersion:
   - 4.0,4.1,4.2,4.3
id: KB260515003
---

# Configure MySQL Connection Control Plugin for Failed Login Lockout

## Issue

By default, MySQL accepts an unlimited number of password retries against any account. To mitigate brute-force attacks, operators often need to introduce a progressive delay after a configurable number of consecutive failed login attempts. This how-to enables the upstream `CONNECTION_CONTROL` plugin on a MySQL 8.0 instance managed by Alauda Application Services for MySQL (Group Replication topology) and verifies the throttling behavior.

> The plugin works for MGR because the Router performs transparent L4 routing and preserves the original MySQL handshake. The same plugin is not effective behind a ProxySQL fronted Percona XtraDB Cluster (PXC) deployment because ProxySQL terminates and rewraps the authentication exchange.

## Environment

- Alauda Application Services for MySQL 4.0 and later
- A MySQL Group Replication (MGR) instance backed by the `Mysql` CR
- Cluster access via `kubectl`

## Resolution

### 1. Plugin variables

The plugin exposes three variables that govern the delay applied after consecutive failed connection attempts:

| Variable | Default | Description |
| --- | --- | --- |
| `connection_control_failed_connections_threshold` | `3` | Number of consecutive failed attempts before the delay kicks in. `0` disables the feature. Range: `0`–`2147483647`. |
| `connection_control_min_connection_delay` | `1000` ms | Minimum delay added before the server responds to a failed attempt once the threshold is reached. Range: `1000`–`2147483647`. |
| `connection_control_max_connection_delay` | `2147483647` ms | Upper bound of the delay. Range: `1000`–`2147483647`. |

### 2. Enable the plugin via the `Mysql` CR

Edit the MGR instance YAML and add the plugin entries under `spec.paras.mysqld`. The following example locks out an account after 5 failed attempts and holds each subsequent failure open for at least 5 minutes (300 000 ms):

```yaml
spec:
  paras:
    mysqld:
      plugin-load: connection_control.so
      connection-control-failed-connections-threshold: "5"
      connection-control-min-connection-delay: "300000"
```

Apply the change. The operator performs a rolling restart of the MGR pods to load the plugin.

### 3. Verify the plugin is active

After the rolling restart completes, exec into the Router pod and connect to the read-only service:

```bash
kubectl -n <namespace> get svc | grep <instance>-read
# Note the cluster-ip of <instance>-read-only and use it as the connection host.

kubectl -n <namespace> exec -it <instance>-router-<hash> -c router -- bash
mysql -uroot -h <read-only-svc-ip> -P 3306 -p"$MYSQL_PASSWORD"
```

Check the plugin status and the current variables:

```sql
SELECT PLUGIN_NAME, PLUGIN_STATUS
FROM information_schema.plugins
WHERE PLUGIN_NAME LIKE 'CONNECTION%';

SHOW VARIABLES LIKE 'connection_control%';
```

Expected output:

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

### 4. Validate the lockout behavior

Trigger several failed logins with a deliberately wrong password and time each attempt. The connection time should grow once the threshold is exceeded:

```bash
for i in $(seq 1 8); do
  time mysql -uroot -h <read-only-svc-ip> -P 3306 -p"wrongpass" -e "SELECT 1" || true
done
```

Inspect the per-account failed-attempt counter from any session:

```sql
SELECT *
FROM performance_schema.connection_control_failed_login_attempts;
```

Each row shows the user/host pair and the number of consecutive failures currently held against it. A successful login resets the counter for that pair.

### 5. Roll back

To disable the lockout, remove the `plugin-load` and `connection-control-*` entries from `spec.paras.mysqld` and re-apply the CR. The operator restarts the pods and the plugin is no longer loaded.

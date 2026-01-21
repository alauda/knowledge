---
products:
  - Alauda Application Services
kind:
  - Solution
---

# How to Set and Update the OpenSearch Admin Password

:::note
Applicable Version: OpenSearch Operator ~= 2.8.*
:::

To use a non-default `admin:admin` administrator account when creating a cluster, or to update the admin password after cluster creation, follow these steps.

## 1. Creating an OpenSearchCluster Instance with a Custom Password

### 1.1 Create the Admin Credentials Secret

First, create a Secret containing the administrator user credentials (e.g., `admin-credentials-secret`). This Secret will be used by the Operator to connect to the cluster for health checks and other operations.

```bash
kubectl -n <namespace> create secret generic admin-credentials-secret --from-literal=username=admin --from-literal=password=admin123
```

> **Note**:
>
> - Replace `admin123` with your new password.
> - If you have already created `admin-credentials-secret`, skip this step.

### 1.2 Generate the Password Hash

Before creating the Security Configuration, you need to generate a hash for the new password. If you have Python 3.x installed, use the following command (replace `admin123` with your new password):

```bash
python3 -c 'import bcrypt; print(bcrypt.hashpw("admin123".encode("utf-8"), bcrypt.gensalt(12, prefix=b"2a")).decode("utf-8"))'
```

### 1.3 Create the Security Config Secret

Create a Secret containing `internal_users.yml` (e.g., `securityconfig-secret`). Ensure the `hash` field in `internal_users.yml` matches the password in `admin-credentials-secret`. It is **strongly recommended to retain the `kibanaserver` user**, as it is required for OpenSearch Dashboards to function properly.

Example `internal_users.yml` content:

```yaml
_meta:
  type: "internalusers"
  config_version: 2
admin:
  hash: "$2y$12$lJsHWchewGVcGlYgE3js/O4bkTZynETyXChAITarCHLz8cuaueIyq" # Replace with the hash generated in the previous step
  reserved: true
  backend_roles:
  - "admin"
  description: "Demo admin user"
kibanaserver:
  hash: "$2y$12$7N9cKpE4qvVvFQkHh8q6yeTqF5qYzGZQeO9Tn3lYp7dS5h3bC2u3a" # It is recommended to set a separate complex password for kibanaserver; this is just an example
  reserved: true
  description: "Demo kibanaserver user"
```

Create the Secret using `kubectl`:

```bash
kubectl -n <namespace> create secret generic securityconfig-secret --from-file=internal_users.yml
```

### 1.4 Configure the OpenSearch Dashboards User

By default, OpenSearch Dashboards may be configured to use the `admin` user (not recommended for production). For security, configure Dashboards to use the dedicated `kibanaserver` user.

Create a Secret containing the Dashboards credentials (e.g., `dashboards-credentials-secret`):

```bash
kubectl -n <namespace> create secret generic dashboards-credentials-secret --from-literal=username=kibanaserver --from-literal=password=admin123
```

> **Note**:
>
> - Replace `admin123` with your new password.
> - If you have already created `dashboards-credentials-secret`, skip this step.

### 1.5 Configure the OpenSearch Cluster Spec

Finally, reference the above Secrets in your `OpenSearchCluster` CR:

```yaml
spec:
  security:
    config:
      adminCredentialsSecret:
        name: admin-credentials-secret # Admin credentials Secret used by the Operator
      securityConfigSecret:
        name: securityconfig-secret # Secret containing the custom Security Config
    tls:
      transport:
        generate: true
      http:
        generate: true
  dashboards:
    enable: true
    opensearchCredentialsSecret:
      name: dashboards-credentials-secret # Credentials used by Dashboards to connect to OpenSearch
```

## 2. Updating the Instance Password (When Custom Password Is Already Configured)

:::warning Applicable Scenario
The following steps apply only when a custom password was configured during OpenSearch cluster creation.
:::

When changing the admin password after cluster creation, you must **update both Secrets simultaneously**.

:::warning Important
**You must update both `securityconfig-secret` and `admin-credentials-secret`!** If you only update one of them, the OpenSearch Operator will be unable to connect to the cluster, causing health checks to fail and management functions to become unavailable.

> If you only modified `securityconfig-secret`, all pods in the instance will enter `0/1` status. In this case, revert the changes and wait for the instance to return to `green` status before trying again.
:::

1. **Update `securityconfig-secret`**
   - Generate the new password hash.
   - Modify `internal_users.yml` in the Secret to update the `hash` field.
   - If you also changed the `kibanaserver` password, update it at this time as well.

   ```bash
   kubectl -n <namespace> create secret generic securityconfig-secret --from-file=internal_users.yml --dry-run=client -o yaml | kubectl apply -f -
   ```

2. **Update `admin-credentials-secret`**
   - Update the `password` field in the Secret to the new password (Base64 encoded).

   ```bash
   kubectl -n <namespace> create secret generic admin-credentials-secret --from-literal=username=admin --from-literal=password=<newpassword> --dry-run=client -o yaml | kubectl apply -f -
   ```

3. **Update `dashboards-credentials-secret` (If kibanaserver password was changed)**
   - If you modified the `kibanaserver` password in step 1, make sure to update this Secret as well, otherwise Dashboards will be unable to connect.

   ```bash
   kubectl -n <namespace> create secret generic dashboards-credentials-secret --from-literal=username=kibanaserver --from-literal=password=<newpassword> --dry-run=client -o yaml | kubectl apply -f -
   ```

:::note
After updating the related secrets, the Operator will start a Job to apply the new Security Config. OpenSearch pods will not restart.
:::

## 3. Updating the Instance Password (When Custom Password Is Not Configured)

:::warning Applicable Scenario
The following steps apply only when no custom password was configured during OpenSearch cluster creation (i.e., `admin` account password is `admin`).
:::

### 3.1 Create the Admin Credentials Secret

Create a Secret containing the administrator user credentials (e.g., `admin-credentials-secret`). This Secret will be used by the Operator to connect to the cluster for health checks and other operations.

```bash
kubectl -n <namespace> create secret generic admin-credentials-secret --from-literal=username=admin --from-literal=password=admin123
```

### 3.2 Generate the Password Hash

Before creating the Security Configuration, you need to generate a hash for the new password. If you have Python 3.x installed, use the following command (replace `admin123` with your new password):

```bash
python3 -c 'import bcrypt; print(bcrypt.hashpw("admin123".encode("utf-8"), bcrypt.gensalt(12, prefix=b"2a")).decode("utf-8"))'
```

### 3.3 Create the Security Config Secret

Export the `internal_users.yml` file from a running OpenSearch instance Pod.

```bash
kubectl -n <namespace> exec <instance-name>-masters-0 -- cat config/opensearch-security/internal_users.yml > internal_users.yml
```

Modify the `hash` field in the `internal_users.yml` file to update the `admin` user's password. Then create the Secret:

```bash
kubectl -n <namespace> create secret generic securityconfig-secret --from-file=internal_users.yml
```

### 3.4 Configure the OpenSearch Cluster Spec

Finally, reference the above Secrets in your `OpenSearchCluster` CR:

```yaml
spec:
  security:
    config:
      adminCredentialsSecret:
        name: admin-credentials-secret # Admin credentials Secret used by the Operator
      securityConfigSecret:
        name: securityconfig-secret # Secret containing the custom Security Config
    tls:
      transport:
        generate: true
      http:
        generate: true
```

:::note
After updating the OpenSearchCluster CR, the Operator will start a Job to apply the new Security Config, and OpenSearch instance pods will perform a rolling restart.
:::

## Appendix: OpenSearch Built-in Users Reference

The OpenSearch Security plugin includes several built-in internal users. In the default configuration (Demo Configuration), **the default password for these users is typically the same as their username**.

| Username | Purpose | Default Roles |
| :--- | :--- | :--- |
| **`admin`** | **Super Administrator**. Has full cluster permissions for operations and management. | `admin` |
| **`kibanaserver`** | **OpenSearch Dashboards service account**. Used by Dashboards to connect to OpenSearch and manage system indices (e.g., `.kibana`). **Cannot be used to log in to the UI**. | `kibana_server` |
| **`kibanaro`** | **Dashboards read-only user**. A demo user with view-only permissions, unable to modify data or configuration. | `kibanauser`, `readall` |
| **`logstash`** | **Data ingestion user**. Typically used with Logstash, has write permissions. | `logstash` |
| **`readall`** | **Global read-only user**. Has permission to view all index data but cannot modify. | `readall` |
| **`snapshotrestore`** | **Backup and restore user**. Dedicated to performing Snapshot and Restore operations. | `snapshotrestore` |
| **`anomalyadmin`** | **Anomaly Detection admin**. Administrator user for managing OpenSearch Anomaly Detection plugin features. | `anomaly_full_access` |

:::warning Security Warning
**Do not use default passwords in production environments!**

- You **must change** the passwords for `admin` and `kibanaserver`.
- For other unused built-in users (such as `logstash`, `kibanaro`, etc.), it is recommended to **delete** or **disable** them in `internal_users.yml`, or at least change them to strong passwords to prevent potential security risks.
:::

## References

1. [Custom Admin User](https://github.com/opensearch-project/opensearch-k8s-operator/blob/v2.8.0/docs/userguide/main.md#custom-admin-user)
2. [User and Role Management](https://github.com/opensearch-project/opensearch-k8s-operator/blob/v2.8.0/docs/userguide/main.md#user-and-role-management)

---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
---

# Connect to a Redis Sentinel Cluster with Navicat

## Introduction

This guide describes how to use the Navicat client to connect to an Alauda Cache Service for Redis OSS instance running in Sentinel mode. The procedure covers connection settings, sentinel authentication options, and timeout configuration.

:::info Sentinel Password Support
- On platform versions **<= 3.16**, Sentinel password authentication is **not** supported. The Sentinel side must be configured as `None`.
- On platform versions **>= 3.18**, Sentinel password authentication **is** supported. Use `Password` if a Sentinel password has been configured for the instance; otherwise use `None`.
:::

## Prerequisites

- The Redis Sentinel instance must have **NodePort** external access enabled.
- The host running Navicat must be able to reach the NodePort IP and port of every Sentinel node in the instance.
- A copy of Navicat (Premium or Navicat for Redis) installed on your workstation.
- The Redis password and, if applicable on platform >= 3.18, the Sentinel password.

## Procedure

### 1. Open Navicat and Create a New Redis Connection

In Navicat, choose **Connection** > **Redis** to open the new connection dialog.

### 2. Configure the General Tab

On the **General** tab, configure the Sentinel and group sections.

#### Sentinel Section

- **Type**: `Sentinel`
- **Sentinel Host**: A NodePort-reachable address of one of the Sentinel nodes.
- **Sentinel Port**: The matching NodePort for that Sentinel node.
- **Sentinel Authentication**:
  - On platform **<= 3.16**, select `None` (Sentinel password is not supported).
  - On platform **>= 3.18**:
    - Select `None` if no Sentinel password has been configured for the instance.
    - Select `Password` and enter the Sentinel password if one has been configured.

#### Group Section

- **Group Name**: `mymaster` (the default master name on Alauda Redis Sentinel).
- **Group Authentication**: `Password`
- **Group Password**: The Redis password for the instance.

### 3. Configure the Sentinel Tab

On the **Sentinel** tab, enable **Use additional sentinels** and add the remaining Sentinel node addresses (host + NodePort) so that Navicat can fail over if the primary Sentinel becomes unavailable.

### 4. Configure the Advanced Tab

On the **Advanced** tab, set a non-zero **Connection Timeout**. Otherwise Navicat reports the following error:

```
With sentinel, connection timeout and socket timeout cannot be 0
```

A connection timeout of a few seconds (for example, 10 seconds) is sufficient for most environments.

### 5. Test the Connection

Click **Test Connection**. A success dialog confirms that Navicat can reach the Sentinels, resolve the current primary, and authenticate against it. Save the connection.

## Important Considerations

- **NodePort reachability** — Navicat must reach **every** Sentinel node, not just one. If the workstation can only see a subset of nodes, failover behavior in Navicat will be unreliable.
- **Sentinel password version gate** — Configuring a Sentinel password on a platform version **<= 3.16** is not supported and will result in connection failures from any client, not only Navicat.
- **Group name** — Always `mymaster` on the standard Alauda Redis Sentinel deployment unless the instance has been customized.
- **Timeout requirement** — Sentinel-mode Navicat connections require a non-zero connection timeout; the default value of `0` is rejected with the error shown above.

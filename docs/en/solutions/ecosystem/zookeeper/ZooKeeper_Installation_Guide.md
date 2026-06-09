---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - '4.1,4.2,4.3'
id: KB260600001
---

# ZooKeeper Installation Guide

## Overview

ZooKeeper is a distributed coordination service used for maintaining configuration information, naming, providing distributed synchronization, and group services. This guide explains how to deploy a ZooKeeper 3.8.6 cluster on Alauda Container Platform (ACP) using the Helm Chart from the Alauda application catalog.

## Prerequisites

- A StorageClass that supports dynamic provisioning (each Pod requires a dedicated PVC)
- The `violet` CLI downloaded from **App Store > App Onboarding**, matching your cluster version

## Installation

### 1. Upload the Material Package

```bash
violet push \
  --platform-address <platform-address> \
  --clusters <business-cluster-name> \
  --platform-username <platform-admin-username> \
  --platform-password <platform-admin-password> \
  zookeeper-v3.8.x-yyyy.tgz
```

Sign in to the platform, switch to the target project and namespace, and confirm that the ZooKeeper package is visible in the App Store.

### 2. Deploy the Chart

Locate the ZooKeeper Chart in the App Store and click **Deploy**. Key parameters:

| Parameter | Default | Description |
| --------- | ------- | ----------- |
| `zookeeper.replicaCount` | `3` | Number of replicas. Must be an odd number (1, 3, 5, 7). Use at least 3 for production. |
| `persistence.size` | `5Gi` | PVC capacity per Pod. |
| `persistence.storageClass` | — | StorageClass name. Leave empty to use the cluster default. |
| `env.ZOO_MAX_CLIENT_CNXNS` | `60` | Maximum client connections per IP. |
| `env.ZOO_AUTOPURGE_PURGEINTERVAL` | `0` | Snapshot auto-purge interval (hours). Set to `24` for production. |

### 3. Verify the Deployment

**Check Pod status**

```bash
kubectl get pods -n <namespace> -l "app=zookeeper,component=server"
```

Expected: 3 Pods in `Running` state, READY column showing `2/2`.

**Health check**

```bash
kubectl exec -n <namespace> <release>-zookeeper-0 -- \
  sh -c "echo ruok | nc 127.0.0.1 2181"
# Expected output: imok
```

**Verify cluster election**

```bash
for i in 0 1 2; do
  echo "Pod-${i}: $(kubectl exec -n <namespace> <release>-zookeeper-${i} -- \
    sh -c "echo mntr | nc 127.0.0.1 2181 | grep zk_server_state")"
done
```

Expected: exactly 1 `leader` and 2 `follower`.

**Data read/write verification**

```bash
# Write
kubectl exec -n <namespace> <release>-zookeeper-0 -- \
  zkCli.sh -server localhost:2181 create /test "hello"

# Read
kubectl exec -n <namespace> <release>-zookeeper-0 -- \
  zkCli.sh -server localhost:2181 get /test

# Clean up
kubectl exec -n <namespace> <release>-zookeeper-0 -- \
  zkCli.sh -server localhost:2181 delete /test
```

## Client Connection

Once the cluster is deployed, applications connect via the ClusterIP Service:

```
<release>-zookeeper.<namespace>.svc.cluster.local:2181
```

## FAQ

### Q1. Snapshot directory (/data) disk usage keeps growing

Auto-purge is disabled by default (`ZOO_AUTOPURGE_PURGEINTERVAL=0`). Update via Helm upgrade:

```yaml
env:
  ZOO_AUTOPURGE_PURGEINTERVAL: 24
  ZOO_AUTOPURGE_SNAPRETAINCOUNT: 5
```

### Q2. ZooKeeper becomes unavailable during node maintenance (drain)

In a 3-node cluster, losing more than 1 Pod simultaneously breaks quorum. The Chart ships with a PodDisruptionBudget (`maxUnavailable=1`), so `kubectl drain` automatically waits for each Pod to recover before evicting the next one. No additional action is required.

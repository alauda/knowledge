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

Push the ZooKeeper artifact to the target business cluster:

```bash
violet push \
  --platform-address <platform-address> \
  --clusters <business-cluster-name> \
  --platform-username <platform-admin-username> \
  --platform-password <platform-admin-password> \
  zookeeper-v3.8.x-<build>.tgz
```

Sign in to the platform as an administrator, go to **Marketplace > Chart Repositories > public-charts**, and confirm the ZooKeeper package (`zookeeper.public-charts` / `3.8.6-<build>`) is visible and that the chart network protocol is **Dual-Stack**. The chart can be selected in IPv4, IPv6, and dual-stack clusters.

### 2. Deploy the Chart

Go to **Marketplace > Chart Repositories > public-charts**, find **zookeeper** in `public-charts`, and click **View Details**. Then click **Create** in the top-right corner.

Fill in the basic information:

- **Name**: instance name, e.g. `zookeeper`
- **Project / Namespace**: target project and namespace
- **Chart Version**: select the latest version

Switch to the **YAML** tab in the **Values** section and enter custom parameters in the **Custom** editor on the left.

Key parameters:

| Parameter | Default | Description |
| --------- | ------- | ----------- |
| `global.registry.address` | — | Image registry endpoint used by workloads. In multi-cluster ACP environments, explicitly set it to the target business cluster registry. |
| `zookeeper.replicaCount` | `3` | Number of replicas. Must be odd. Use at least 3 for production. |
| `persistence.size` | `5Gi` | PVC capacity per Pod. Adjust based on data volume. |
| `persistence.storageClass` | — | StorageClass name. Leave empty for cluster default. |
| `env.ZOO_MAX_CLIENT_CNXNS` | `60` | Maximum client connections per IP. |
| `env.ZOO_AUTOPURGE_PURGEINTERVAL` | `0` | Snapshot auto-purge interval (hours). **Set to `24` for production.** |
| `env.ZOO_AUTOPURGE_SNAPRETAINCOUNT` | `3` | Snapshots to retain. Use `5` with auto-purge. |
| `zookeeperExporter.enabled` | `true` | Enable Prometheus Exporter sidecar (port 9141). |
| `prometheus.serviceMonitor.enabled` | `true` | Create ServiceMonitor for Prometheus auto-discovery. |

Example custom values for a multi-cluster environment:

```yaml
global:
  registry:
    address: <target-business-cluster-registry>
zookeeper:
  replicaCount: 3
persistence:
  enabled: true
  storageClass: <storage-class>
  size: 5Gi
```

Click **Create** to complete the deployment. The ZooKeeper StatefulSet will bring up 3 Pods sequentially, taking approximately 2–3 minutes.

### 3. Verify the Deployment

```bash
kubectl get pod -n <target-namespace> -l app=zookeeper,release=<instance-name>
# Expected:
# NAME           READY   STATUS    RESTARTS   AGE
# <instance-name>-zookeeper-0    2/2     Running   0          3m
# <instance-name>-zookeeper-1    2/2     Running   0          2m
# <instance-name>-zookeeper-2    2/2     Running   0          1m
```

**Health check**

```bash
kubectl exec -n <target-namespace> <instance-name>-zookeeper-0 -- sh -c "echo ruok | nc 127.0.0.1 2181"
# Expected: imok
```

**Verify cluster election**

```bash
for i in 0 1 2; do
  echo "Pod-${i}: $(kubectl exec -n <target-namespace> <instance-name>-zookeeper-${i} -- \
    sh -c "echo mntr | nc 127.0.0.1 2181 | grep zk_server_state")"
done
# Expected: exactly 1 leader and 2 follower
```

**Data read/write**

```bash
TEST_PATH=/zk-smoke-$(date +%s)
kubectl exec -n <target-namespace> <instance-name>-zookeeper-0 -- zkCli.sh -server localhost:2181 create ${TEST_PATH} "hello"
kubectl exec -n <target-namespace> <instance-name>-zookeeper-0 -- zkCli.sh -server localhost:2181 get ${TEST_PATH}
kubectl exec -n <target-namespace> <instance-name>-zookeeper-0 -- zkCli.sh -server localhost:2181 delete ${TEST_PATH}
```

## Client Connection

```
<instance-name>-zookeeper.<target-namespace>.svc.cluster.local:2181
```

## Monitoring

**Verify sidecar containers**

```bash
kubectl get pod -n <target-namespace> -l app=zookeeper,release=<instance-name> \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.containers[*]}{.name}{","}{end}{"\n"}{end}'
# Expected: each Pod shows zookeeper,zookeeper-exporter,
```

**Query metrics**

```bash
kubectl port-forward -n <target-namespace> pod/<instance-name>-zookeeper-0 9141:9141 &
curl -s http://localhost:9141/metrics | grep -E "^zk_(up|num_alive_connections|outstanding_requests|znode_count)"
# Expected:
# zk_up 1
# zk_num_alive_connections 3
# zk_outstanding_requests 0
# zk_znode_count 5
```

**Verify ServiceMonitor**

```bash
kubectl get servicemonitor -n <target-namespace> -l app=zookeeper,release=<instance-name>
```

## Cleanup

If this is a test deployment, delete the application from the platform and then remove the remaining PVCs explicitly:

```bash
kubectl delete pvc -n <target-namespace> -l app=zookeeper,release=<instance-name>
```

## FAQ

### Q1. Snapshot directory (/data) disk usage keeps growing

Auto-purge is disabled by default (`ZOO_AUTOPURGE_PURGEINTERVAL=0`). Edit Values through the UI:

```yaml
env:
  ZOO_AUTOPURGE_PURGEINTERVAL: "24"
  ZOO_AUTOPURGE_SNAPRETAINCOUNT: "5"
```

### Q2. ZooKeeper becomes unavailable during node maintenance (drain)

In a 3-node cluster, losing more than 1 Pod simultaneously breaks quorum. The Chart ships with a PodDisruptionBudget (`maxUnavailable=1`), so `kubectl drain` automatically waits for each Pod to recover before evicting the next. If issues occur, uncordon the node first and wait for Pods to recover before retrying.

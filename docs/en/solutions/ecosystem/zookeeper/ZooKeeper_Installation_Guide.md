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
  zookeeper-v3.8.x-yyyy.tgz
```

Sign in to the platform as an administrator, go to **Marketplace > Chart Repositories > public-charts**, and confirm the ZooKeeper package (chart-zookeeper 3.8.6-xxxxxx) is visible. Note the exact **Chart Version** string — you will need it for the kubectl method below.

### 2. Deploy ZooKeeper

Two creation methods are supported and produce identical results.

#### Method 1: UI

Go to **Marketplace > Chart Repositories > public-charts**, find **chart-zookeeper**, and click **View Details**. Then click **Create** in the top-right corner.

Fill in the basic information:

- **Name**: instance name, e.g. `zookeeper`
- **Project / Namespace**: target project and namespace
- **Chart Version**: select the latest version

Switch to the **YAML** tab in the **Values** section and enter custom parameters in the **Custom** editor on the left.

Key parameters:

| Parameter | Default | Description |
| --------- | ------- | ----------- |
| `zookeeper.replicaCount` | `3` | Number of replicas. Must be odd. Use at least 3 for production. |
| `persistence.size` | `5Gi` | PVC capacity per Pod. |
| `persistence.storageClass` | — | StorageClass name. Leave empty for cluster default. |
| `env.ZOO_MAX_CLIENT_CNXNS` | `60` | Maximum client connections per IP. |
| `env.ZOO_AUTOPURGE_PURGEINTERVAL` | `0` | Snapshot auto-purge interval (hours). **Set to `24` for production.** |
| `env.ZOO_AUTOPURGE_SNAPRETAINCOUNT` | `3` | Snapshots to retain. Use `5` with auto-purge. |
| `zookeeperExporter.enabled` | `true` | Enable Prometheus Exporter sidecar (port 9141). |
| `prometheus.serviceMonitor.enabled` | `true` | Create ServiceMonitor for Prometheus auto-discovery. |

Click **Create** to complete the deployment.

#### Method 2: kubectl

The following manifest matches exactly what the UI submits. Replace all `<placeholder>` values before applying. `<chart-version>` is the version string from the chart detail page (e.g. `3.8.6-260609`).

```yaml
apiVersion: app.k8s.io/v1beta1
kind: Application
metadata:
  name: <instance-name>
  namespace: <target-namespace>
  annotations:
    app.cpaas.io/chart.source: "public-charts/zookeeper"
    app.cpaas.io/chart.version: "<chart-version>"
    app.cpaas.io/chart.values: '{"zookeeper":{"replicaCount":3,"resources":{"requests":{"cpu":"250m","memory":"256Mi"},"limits":{"cpu":"1","memory":"1Gi"}}},"persistence":{"enabled":true,"size":"5Gi","storageClass":"<storageClass>"},"env":{"ZOO_MAX_CLIENT_CNXNS":"60","ZOO_AUTOPURGE_PURGEINTERVAL":"24","ZOO_AUTOPURGE_SNAPRETAINCOUNT":"5"},"zookeeperExporter":{"enabled":true},"prometheus":{"serviceMonitor":{"enabled":true,"interval":"30s","scrapeTimeout":"30s"}}}'
    cpaas.io/display-name: ""
  labels:
    sync-from-helmrequest: "true"
```

```bash
kubectl apply -f zookeeper.yaml
```

### 3. Verify the Deployment

```bash
kubectl get pod -n <target-namespace> -l app.kubernetes.io/name=zookeeper
# Expected:
# NAME           READY   STATUS    RESTARTS   AGE
# zookeeper-0    2/2     Running   0          3m
# zookeeper-1    2/2     Running   0          2m
# zookeeper-2    2/2     Running   0          1m
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
kubectl exec -n <target-namespace> <instance-name>-zookeeper-0 -- zkCli.sh -server localhost:2181 create /test "hello"
kubectl exec -n <target-namespace> <instance-name>-zookeeper-0 -- zkCli.sh -server localhost:2181 get /test
kubectl exec -n <target-namespace> <instance-name>-zookeeper-0 -- zkCli.sh -server localhost:2181 delete /test
```

## Client Connection

```
<instance-name>-zookeeper.<target-namespace>.svc.cluster.local:2181
```

## Monitoring

**Verify sidecar containers**

```bash
kubectl get pod -n <target-namespace> -l app.kubernetes.io/name=zookeeper \
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
kubectl get servicemonitor -n <target-namespace> -l app.kubernetes.io/name=zookeeper
```

## FAQ

### Q1. Snapshot directory (/data) disk usage keeps growing

Auto-purge is disabled by default (`ZOO_AUTOPURGE_PURGEINTERVAL=0`). Edit Values through the UI or update `chart.values` in the Application annotation:

```json
"env": {
  "ZOO_AUTOPURGE_PURGEINTERVAL": "24",
  "ZOO_AUTOPURGE_SNAPRETAINCOUNT": "5"
}
```

### Q2. ZooKeeper becomes unavailable during node maintenance (drain)

In a 3-node cluster, losing more than 1 Pod simultaneously breaks quorum. The Chart ships with a PodDisruptionBudget (`maxUnavailable=1`), so `kubectl drain` automatically waits for each Pod to recover before evicting the next. If issues occur, uncordon the node first and wait for Pods to recover before retrying.

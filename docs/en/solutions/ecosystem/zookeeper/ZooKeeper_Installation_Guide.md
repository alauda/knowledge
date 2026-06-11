---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - '4.1,4.2,4.3'
id: KB260600001
---

# ZooKeeper 3.8.6 Installation Guide

## Overview

ZooKeeper is a distributed coordination service used for configuration management, naming, distributed synchronization, and group services. This guide describes how to upload the ZooKeeper 3.8.6 plugin package, create a ZooKeeper instance from the ACP Marketplace, validate the deployment, check monitoring, and clean up test resources.

## Prerequisites

- A target project and namespace have been created, and the namespace belongs to the target business cluster.
- A StorageClass that supports dynamic provisioning is available. Each ZooKeeper Pod creates dedicated PVCs.
- Business cluster nodes can access the platform image registry.
- The `violet` CLI is downloaded from **App Store > App Onboarding** and matches the target platform version.

## Installation

### 1. Obtain the Plugin Package

Download the ZooKeeper 3.8.6 plugin package from Alauda Cloud. The package file name is determined by the Alauda Cloud page and this guide does not depend on a fixed build number.

### 2. Upload the Plugin Package

If ZooKeeper 3.8.6 has not been uploaded to the target platform, use `violet` to push the plugin package to the target platform and business cluster:

```bash
violet push   --platform-address <platform-address>   --clusters <business-cluster-name>   --platform-username <platform-admin-username>   --platform-password <platform-admin-password>   <zookeeper-plugin-package>.tgz
```

If the plugin package has already been uploaded, skip this step and continue with the upload confirmation.

### 3. Confirm the Upload

Sign in to the platform as an administrator. Go to **Marketplace > Chart Repositories > public-charts**, search for ZooKeeper, and confirm that `middleware/zookeeper/chart-zookeeper` is visible. Select the uploaded ZooKeeper 3.8.6 version.

### 4. Prepare Deployment Parameters

| Parameter | Example | Description |
| --------- | ------- | ----------- |
| `<project>` | `middleware-project` | Target project. |
| `<namespace>` | `middleware` | Target namespace in the business cluster. |
| `<instance>` | `zookeeper` | ZooKeeper instance name. |
| `<storage-class>` | `topolvm` | Available StorageClass in the target business cluster. |
| `<registry-address>` | `<platform-registry>` | Registry address used by business Pods to pull images. |

### 5. Confirm Key Values

- `persistence` must be a top-level field. Do not configure it as `zookeeper.persistence`.
- In multi-cluster environments, explicitly set `global.registry.address` to a registry address reachable from the target business cluster.
- Keep `zookeeper.replicaCount` odd. Use at least 3 replicas for production.
- Adjust PVC capacity and resource requests or limits based on business capacity requirements.
- Confirm the snapshot auto-purge policy before production use to avoid long-term disk growth.

### 6. Create the ZooKeeper Instance

Go to **Marketplace > Chart Repositories > public-charts**, find `middleware/zookeeper/chart-zookeeper`, select the uploaded ZooKeeper 3.8.6 version, and click **Create**.

Fill in the basic information:

- **Name**: instance name, for example `zookeeper`
- **Display Name**: usually the same as the instance name
- **Project**: target project
- **Namespace**: target namespace in the business cluster
- **Version**: uploaded ZooKeeper 3.8.6 version

Switch to the **YAML** tab in the **Values** section and replace the Custom values with environment-specific settings:

```yaml
global:
  registry:
    address: <registry-address>
zookeeper:
  replicaCount: 3
persistence:
  enabled: true
  storageClass: <storage-class>
  size: 5Gi
  accessMode: ReadWriteOnce
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
```

Click **Create**. The platform creates an Application and HelmRequest named `<instance>`. The StatefulSet, Pods, Services, and related resources also use `<instance>` as the resource name prefix, for example `<instance>-0`, `<instance>`, and `<instance>-headless`.

The ZooKeeper StatefulSet starts Pods sequentially. A 3-node cluster usually takes about 2 to 5 minutes to become ready. The actual time depends on image pulling, PVC binding, and scheduling.

## Deployment Validation

Set variables for the validation commands:

```bash
export NAMESPACE=<namespace>
export INSTANCE=<instance>
```

### 1. Check HelmRequest and Application

```bash
kubectl -n ${NAMESPACE} get helmrequests.app.alauda.io ${INSTANCE}
kubectl -n ${NAMESPACE} get applications.app.k8s.io ${INSTANCE} -o jsonpath='{.status.state}{"
"}'
```

Expected result:

- The HelmRequest exists and has synced successfully.
- The Application `status.state` is `Running`.

### 2. Check Pods, Services, and PVCs

```bash
kubectl -n ${NAMESPACE} get pod,sts,svc,pvc -o wide | grep ${INSTANCE}
```

Expected result:

- StatefulSet `READY` is `3/3`.
- `${INSTANCE}-0`, `${INSTANCE}-1`, and `${INSTANCE}-2` are `2/2 Running`.
- PVCs are `Bound`.
- Services include `${INSTANCE}` and `${INSTANCE}-headless`.

## Functional Validation

### 1. Health Check

```bash
kubectl -n ${NAMESPACE} exec ${INSTANCE}-0 -c zookeeper --   sh -c 'echo ruok | nc 127.0.0.1 2181'
```

Expected output:

```text
imok
```

### 2. Verify Cluster Election

```bash
for i in 0 1 2; do
  echo "${INSTANCE}-${i}"
  kubectl -n ${NAMESPACE} exec ${INSTANCE}-${i} -c zookeeper --     sh -c 'echo mntr | nc 127.0.0.1 2181 | grep zk_server_state'
done
```

Expected result: exactly one leader and two followers.

### 3. Verify Data Read and Write

```bash
TEST_PATH=/zk-smoke-$(date +%s)
kubectl -n ${NAMESPACE} exec ${INSTANCE}-0 -c zookeeper --   zkCli.sh -server ${INSTANCE}:2181 create ${TEST_PATH} hello
kubectl -n ${NAMESPACE} exec ${INSTANCE}-0 -c zookeeper --   zkCli.sh -server ${INSTANCE}:2181 get ${TEST_PATH}
kubectl -n ${NAMESPACE} exec ${INSTANCE}-0 -c zookeeper --   zkCli.sh -server ${INSTANCE}:2181 delete ${TEST_PATH}
```

Expected result: create succeeds, get returns `hello`, and delete completes without error.

## Client Connection

For clients in the same namespace, use the client Service:

```text
${INSTANCE}:2181
${INSTANCE}.${NAMESPACE}.svc.cluster.local:2181
```

To connect to specific ensemble members, use the headless Service:

```text
${INSTANCE}-0.${INSTANCE}-headless.${NAMESPACE}.svc.cluster.local:2181
${INSTANCE}-1.${INSTANCE}-headless.${NAMESPACE}.svc.cluster.local:2181
${INSTANCE}-2.${INSTANCE}-headless.${NAMESPACE}.svc.cluster.local:2181
```

## Monitoring Validation

### 1. Confirm Exporter Sidecar Containers

```bash
kubectl -n ${NAMESPACE} get pod -l app=zookeeper,release=${INSTANCE}   -o jsonpath='{range .items[*]}{.metadata.name}{"	"}{range .spec.containers[*]}{.name}{","}{end}{"
"}{end}'
```

Expected result: each Pod includes `zookeeper` and `zookeeper-exporter` containers.

### 2. Query Exporter Metrics

```bash
kubectl -n ${NAMESPACE} port-forward pod/${INSTANCE}-0 9141:9141 &
curl -s http://127.0.0.1:9141/metrics | grep '^zk_up '
```

Expected result:

```text
zk_up 1
```

### 3. Confirm ServiceMonitor

```bash
kubectl -n ${NAMESPACE} get servicemonitors.monitoring.coreos.com -l app=zookeeper,release=${INSTANCE}
```

Expected result: a ServiceMonitor exists for the current instance.

## Change Validation

If you need to change the replica count, keep the replica count odd. Validate scaling in a test environment before production use.

After editing Values in the platform UI and saving the application, check the rollout and then repeat the election and data read/write validation:

```bash
kubectl -n ${NAMESPACE} rollout status statefulset/${INSTANCE} --timeout=15m
kubectl -n ${NAMESPACE} get pod -l app=zookeeper,release=${INSTANCE}
```

## Cleanup

If this is a test deployment, delete the application from the platform UI. After deletion, confirm that Application, HelmRequest, StatefulSet, Pods, Services, PVCs, and ServiceMonitor have been cleaned up.

```bash
kubectl -n ${NAMESPACE} get   applications.app.k8s.io,helmrequests.app.alauda.io,sts,pod,svc,pvc,servicemonitors.monitoring.coreos.com   | grep ${INSTANCE}

kubectl -n ${NAMESPACE} delete pvc -l app=zookeeper,release=${INSTANCE}
```

## FAQ

### Snapshot directory keeps growing

ZooKeeper continuously writes transaction logs and snapshots. For production environments, enable auto-purge according to business requirements to avoid filling the data disk.

```yaml
env:
  ZOO_AUTOPURGE_PURGEINTERVAL: "24"
  ZOO_AUTOPURGE_SNAPRETAINCOUNT: "5"
```

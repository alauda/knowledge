---
products:
  - Alauda Container Platform
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB260800029
---

# Redis Enterprise 8.0 Integration with ACP

## Overview

[Redis Enterprise](https://redis.io/enterprise/) is the commercial in-memory database from Redis. On Kubernetes it is delivered as the `redis-enterprise-k8s` Operator, which manages a cluster of Redis Enterprise nodes and the databases hosted on them.

This guide describes how to deploy Redis Enterprise on Alauda Container Platform (ACP), including air-gapped image preparation, Operator installation, cluster and database creation, verification, and the upgrade path. The integration was validated on ACP 4.1 with Redis Enterprise 8.0.

Redis Enterprise is managed through four custom resources:

| Resource | Short name | Description |
|---|---|---|
| `RedisEnterpriseCluster` | REC | The node pool. One REC per namespace; every REDB and REAADB depends on it. |
| `RedisEnterpriseDatabase` | REDB | A logical database. Supports dense, sparse, and OSS-cluster-compatible sparse sharding. |
| `RedisEnterpriseRemoteCluster` | RERC | A reference to a remote REC, used to configure Active-Active replication. |
| `RedisEnterpriseActiveActiveDatabase` | REAADB | An Active-Active (geo-replicated) database. |

## Environment

| Component | Version / Value |
|---|---|
| Container platform | ACP 4.x (validated on 4.1) |
| Product | Redis Enterprise 8.0 |
| Operator | `redis-enterprise-k8s` bundle `v8.0.2-6` |
| Operator image | `redislabs/operator:8.0.2-6` |
| Redis image | `redislabs/redis:8.0.2-41` |
| Services rigger image | `redislabs/k8s-controller:8.0.2-6` |
| Call-home client image | `redislabs/re-call-home-client:8.0.2-6` |
| Kubernetes versions declared by Redis | 1.31, 1.32, 1.33 |
| Installation method | Bundle YAML (recommended) or Helm chart |

The supported Kubernetes versions are those declared by Redis for this Operator release. Check the Redis release notes for the exact list that applies to the version you install.

> **Note**: Redis Enterprise image versions are coupled to the Operator version. Before installing, confirm on the Redis documentation site that the image tags you mirror match the Operator bundle you apply.

## Prerequisites

- An ACP 4.x cluster with `kubectl` access.
- A **networked persistent StorageClass that supports volume expansion**. Local disks are not supported. If Auto Tiering is used, SSD-backed storage is recommended, because warm values are placed on flash while keys and hot values stay in RAM.
- A private registry that the cluster can pull from, when the cluster has no direct internet access.
- A Redis Enterprise trial or commercial license. A trial license is limited to 4 shards (replicas included), with at most 25 GB per shard.
- `skopeo` and `helm` on the workstation used for preparation.

The following placeholders are used throughout this guide. Replace them with the values for your environment:

| Placeholder | Description |
|---|---|
| `<private-registry>` | Registry reachable from the cluster |
| `<storage-class>` | Networked StorageClass that supports expansion |
| `<namespace>` | Namespace that hosts the Redis Enterprise cluster |
| `<pull-secret>` | `kubernetes.io/dockerconfigjson` Secret holding the credentials for `<private-registry>` |
| `<admin-username>` | Login name of the Redis Enterprise cluster administrator, in email format |

## Resolution

### 1. Mirror the images

Four images are required. Pass registry credentials through environment variables — never write them into a file that is committed:

```shell
export REG_USER=<registry-user>
export REG_PASS=<registry-password>

for image in \
  "redislabs/operator:8.0.2-6" \
  "redislabs/redis:8.0.2-41" \
  "redislabs/k8s-controller:8.0.2-6" \
  "redislabs/re-call-home-client:8.0.2-6" ; do
  skopeo copy \
    docker://docker.io/${image} \
    docker://<private-registry>/${image} \
    --dest-tls-verify=false \
    --dest-username "$REG_USER" --dest-password "$REG_PASS" \
    --multi-arch all
done
```

If you plan to run a load test after installation, mirror a `memtier_benchmark` image as well.

### 2. Install the Operator

Create the namespace, and — when the private registry requires authentication — an image pull Secret in it, using the same credentials exported in step 1. The Operator Deployment runs with `imagePullPolicy: Always`, so without this Secret the Operator pod stays in `ImagePullBackOff`:

```shell
kubectl create namespace <namespace>
kubectl create secret docker-registry <pull-secret> \
  --namespace <namespace> \
  --docker-server=<private-registry> \
  --docker-username="$REG_USER" \
  --docker-password="$REG_PASS"
```

Download the bundle for the target version, repoint its image at the private registry, attach the pull Secret, and apply it:

```shell
VERSION='v8.0.2-6'
curl -sSLO https://raw.githubusercontent.com/RedisLabs/redis-enterprise-k8s-docs/${VERSION}/bundle.yaml
# Edit bundle.yaml, in the redis-enterprise-operator Deployment:
#   - prefix both redislabs/operator image references with <private-registry>/
#   - add `imagePullSecrets: [{name: <pull-secret>}]` to the pod spec
kubectl apply -n <namespace> -f bundle.yaml
kubectl get pod -n <namespace>
```

> **Note**: The bundle references only the Operator image — in `v8.0.2-6` it appears twice, once for the `redis-enterprise-operator` container and once for the `admission` container. The other three images mirrored in step 1 (`redis`, `k8s-controller`, `re-call-home-client`) do not appear in the bundle; they are selected by the REC in step 3.

From `8.0.2-6` onward the admission controller ships as a second container in the Operator Deployment, and the Operator creates the `ValidatingWebhookConfiguration` and the `admission-tls` Secret in its own namespace — no separate webhook manifest has to be applied. If the webhook must only validate specific namespaces, patch the `ValidatingWebhookConfiguration` with a `namespaceSelector`.

Helm is also supported, with limitations — the chart only performs a fresh install. It does not cover upgrades or migration, custom configuration values, multi-namespace watching, rack awareness, or Vault integration:

```shell
helm repo add redis https://helm.redis.io/
helm repo update
helm install <release-name> redis/redis-enterprise-operator \
  --version <chart-version> \
  --namespace <namespace> \
  --create-namespace
```

Use the bundle YAML when the deployment must be upgraded later.

### 3. Create the RedisEnterpriseCluster (REC)

A namespace can hold only one REC.

If you hold a commercial license, store it in a Secret first. When neither `spec.license` nor `spec.licenseSecretName` is set, the cluster starts on the built-in trial license, with the shard limits listed under Known Limitations below:

```shell
kubectl create secret generic my-rec-license \
  --namespace <namespace> \
  --from-file=license=./license.txt
```

> **Note**: `spec.license` and `spec.licenseSecretName` are mutually exclusive — set only one of them. The Secret must store the license string under the key `license`.

Point every image spec at the private registry, and reference both the pull Secret and the license Secret:

```yaml
apiVersion: app.redislabs.com/v1
kind: RedisEnterpriseCluster
metadata:
  name: my-rec
spec:
  nodes: 3
  clusterCredentialSecretName: my-rec
  clusterCredentialSecretType: kubernetes
  createServiceAccount: true
  serviceAccountName: my-rec
  username: <admin-username>
  licenseSecretName: my-rec-license  # omit to use the built-in trial license
  persistentSpec:
    enabled: true
    storageClassName: <storage-class>
    volumeSize: 20Gi
  redisEnterpriseNodeResources:
    requests:
      cpu: "8"
      memory: 20Gi
    limits:
      cpu: "8"
      memory: 20Gi
  pullSecrets:  # omit when the registry needs no authentication
    - name: <pull-secret>
  bootstrapperImageSpec:
    repository: <private-registry>/redislabs/operator
    versionTag: 8.0.2-6
  redisEnterpriseImageSpec:
    repository: <private-registry>/redislabs/redis
    versionTag: 8.0.2-41
  redisEnterpriseServicesRiggerImageSpec:
    repository: <private-registry>/redislabs/k8s-controller
    versionTag: 8.0.2-6
  usageMeter:
    callHomeClient:
      imageSpec:
        repository: <private-registry>/redislabs/re-call-home-client
        versionTag: 8.0.2-6
  services:
    apiService:
      type: NodePort
  uiServiceType: NodePort
```

```shell
kubectl apply -n <namespace> -f rec.yaml
kubectl get rec -n <namespace>
```

The Operator creates a Secret named after the CR holding the administrator credentials — the username is the one set in `spec.username`, the password is generated randomly — and distributes self-signed TLS certificates across the nodes. Read the password from that Secret:

```shell
kubectl get secret my-rec -n <namespace> -o jsonpath='{.data.password}' | base64 -d
```

> **Note**: `NodePort` for the API and UI services is convenient for validation. For production, expose them through the cluster's standard ingress path instead.

### 4. Create the database (REDB)

#### 4.1 Dense placement

Dense placement keeps shards on as few nodes as possible and is the counterpart to an open-source sentinel deployment:

```yaml
apiVersion: app.redislabs.com/v1alpha1
kind: RedisEnterpriseDatabase
metadata:
  name: mydb
spec:
  memorySize: 20GB
  persistence: aofEverySecond
  replication: true
  redisEnterpriseCluster:
    name: my-rec
```

#### 4.2 Sparse placement

Sparse placement spreads shards across nodes and is the counterpart to an open-source cluster deployment:

```yaml
spec:
  memorySize: 20GB
  shardCount: 3
  persistence: aofEverySecond
  shardsPlacement: "sparse"
  ossCluster: false
  redisEnterpriseCluster:
    name: my-rec
```

Set `ossCluster: true` to expose the database through the OSS Cluster API, so that clients can use open-source cluster commands such as `CLUSTER NODES`. All three modes — dense, sparse, and sparse with `ossCluster: true` — were validated on ACP.

Each database gets a `ClusterIP` Service with the same name as the REDB, plus a `-headless` Service.

### 5. Verify the deployment

```shell
kubectl get rec,redb -n <namespace>
kubectl get pod -n <namespace>
kubectl get svc -n <namespace>
```

Connect with any Redis client using the database Service and the password from the database Secret. When running `memtier_benchmark` against the database, the client mode must match the database configuration:

```shell
# Standard proxy-based database: do NOT pass --cluster-mode
memtier_benchmark -s <db-service> -p <db-port> --authenticate=$AUTH_PASS \
  --data-size=4096 --threads=10 --clients=50 --key-pattern=P:P --test-time=180

# Database with the OSS Cluster API enabled: add --cluster-mode
memtier_benchmark -s <db-service> -p <db-port> --authenticate=$AUTH_PASS --cluster-mode \
  --data-size=4096 --threads=10 --clients=50 --key-pattern=P:P --test-time=180
```

> **Note**: Redis Enterprise routes all client traffic through a proxy, while an open-source Redis cluster has clients connect to each shard directly. Results from the two architectures are not directly comparable — read each in the context of its own topology.

Metrics are exposed on port `8070` and can be collected with a `ServiceMonitor`.

### 6. Upgrade path

Upgrade the three layers in order, and confirm the supported upgrade path and module compatibility in the Redis documentation before starting:

1. **Operator** — apply the bundle of the target version. The admission controller is a container in the Operator Deployment, so it is upgraded together with the Operator.
2. **REC** — set `spec.autoUpgradeRedisEnterprise: true`, or update `redisEnterpriseImageSpec.versionTag` manually.
3. **REDB** — update `spec.redisVersion` to the target minor version, for example `"8.0"`. The field also accepts the `major` and `latest` channels, which always upgrade to the most recent major or the latest available version. The REC upgrade policy and the REDB version must be consistent.

## Known Limitations

| Area | Limitation | Recommendation |
|---|---|---|
| Operator scope | The Operator watches a single namespace by default; multiple namespaces are supported through additional configuration | Confirm the watch scope required by your deployment before installing |
| Helm chart | Fresh install only — no upgrade or migration, configuration values, multi-namespace, rack awareness, or Vault integration | Install with the bundle YAML when the deployment will be upgraded |
| Storage | Requires networked persistent storage with expansion support; Auto Tiering recommends SSD | Do not use local disks |
| External access | Databases are `ClusterIP` by default; Ingress (HAProxy or Nginx), Istio Gateway, and OpenShift Route are configured through the REC `ingressOrRouteSpec` | Choose and configure an access path explicitly before exposing databases |
| Active-Active, physically isolated deployment, dual-stack | Not covered by this validation | Validate separately before relying on them |
| Trial license | Maximum 4 shards including replicas, 25 GB per shard | Use a commercial license for capacity testing |

## Security Notes

- Registry addresses, registry credentials, license details, and database passwords must be supplied through Secrets or environment variables, never committed to a repository.
- The Operator creates the cluster administrator credentials automatically. Read them from the Secret rather than setting a fixed password.
- Restrict the admission webhook to the namespaces it needs to validate when the cluster hosts unrelated workloads.

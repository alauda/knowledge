---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB260400014
---

# How to Deploy MongoDB Using the Community Percona Operator

## Overview

This guide walks you through deploying MongoDB on Alauda Container Platform using the upstream **community** [Percona Server for MongoDB Operator](https://github.com/percona/percona-server-mongodb-operator). The previously-bundled Alauda MongoDB plugin is no longer distributed via the ACP marketplace, so this guide provides a self-service path using the community release.

**Verified versions** (verified on ACP 4.2 / Kubernetes 1.33; check the upstream documentation for newer releases):

| Component | Version |
| :--- | :--- |
| Percona Server for MongoDB Operator | `1.22.0` |
| MongoDB | `6.0` / `7.0` / `8.0` |

> **Note**
> Operator `1.22.0` does **not** support MongoDB `4.x` or `5.x`. If you need an older MongoDB major version, consult the [Percona system requirements page](https://docs.percona.com/percona-operator-for-mongodb/System-Requirements.html) for the operator version that supports it.

For background on the operator's features, see:

- [Percona Operator for MongoDB documentation](https://docs.percona.com/percona-operator-for-mongodb/index.html)
- [OperatorHub.io listing](https://operatorhub.io/operator/percona-server-mongodb-operator)

## Prerequisites

- An ACP 4.x cluster with `cluster-admin` access.
- `kubectl` configured against the target cluster.
- A target namespace, a cluster name, and a `StorageClass`. Export them once and reuse them throughout the guide:

  ```bash
  export NS=<your-namespace>          # e.g. mongodb
  export CLUSTER=<your-cluster-name>  # e.g. my-mongo — used as the CR name; derives ${CLUSTER}-secrets, ${CLUSTER}-mongos, ${CLUSTER}-mongos-0
  export STORAGE_CLASS=<your-sc>      # e.g. topolvm-ext4 — leave empty to use the cluster default
  ```

  All `kubectl` examples below use `"$NS"`, `"$CLUSTER"`, and `"$STORAGE_CLASS"`. If you open a fresh shell, re-export them before resuming. The cluster-wide install in Step 4 introduces an additional `OPERATOR_NS` variable for users who want the operator and the cluster CR to live in different namespaces; by default it inherits `$NS`.
- A `StorageClass` with dynamic PVC provisioning. Mark it as the default storage class if you want to omit `storageClassName` from the cluster CR.
- A private container registry that your cluster nodes can pull from, with credentials to push to it.
- A workstation with internet access where you can pull from `docker.io` and push to your private registry. Either [`skopeo`](https://github.com/containers/skopeo) or `docker` will work.

## Step 1: Mirror the Required Images to Your Private Registry

ACP cluster nodes typically cannot pull directly from `docker.io`. You must mirror the operator and operand images into your private registry first.

The four image streams used by this guide:

| Purpose | Source on `docker.io` | Tag |
| :--- | :--- | :--- |
| Operator | `percona/percona-server-mongodb-operator` | `1.22.0` |
| MongoDB 6.0 | `percona/percona-server-mongodb` | `6.0.27-21` |
| MongoDB 7.0 | `percona/percona-server-mongodb` | `7.0.30-16` |
| MongoDB 8.0 | `percona/percona-server-mongodb` | `8.0.19-7` |
| Backup (PBM) | `percona/percona-backup-mongodb` | `2.12.0` |

You only need the MongoDB image(s) for the version(s) you intend to deploy. The PBM image is optional unless you enable backups.

### Option A: skopeo (recommended)

`skopeo` copies images directly between registries without needing a local Docker daemon and preserves multi-arch manifests.

```bash
PRIVATE_REGISTRY="<your-private-registry>"          # e.g. registry.example.com
skopeo login "$PRIVATE_REGISTRY"                    # if your registry needs auth

for img in \
  percona/percona-server-mongodb-operator:1.22.0 \
  percona/percona-server-mongodb:6.0.27-21 \
  percona/percona-server-mongodb:7.0.30-16 \
  percona/percona-server-mongodb:8.0.19-7 \
  percona/percona-backup-mongodb:2.12.0 ; do
    skopeo copy --all \
      "docker://docker.io/$img" \
      "docker://$PRIVATE_REGISTRY/$img"
done
```

The `--all` flag copies every platform variant of multi-arch tags.

### Option B: docker pull / tag / push

```bash
REGISTRY_SERVER="<your-registry-host>"               # e.g. registry.example.com:443
PRIVATE_REGISTRY="$REGISTRY_SERVER/<your-project>"   # e.g. registry.example.com:443/middleware
docker login "$REGISTRY_SERVER"

for img in \
  percona/percona-server-mongodb-operator:1.22.0 \
  percona/percona-server-mongodb:8.0.19-7 ; do
    docker pull  "docker.io/$img"
    docker tag   "docker.io/$img" "$PRIVATE_REGISTRY/$img"
    docker push  "$PRIVATE_REGISTRY/$img"
done
```

> **Note**
> Option B mirrors only the local host's architecture. If your clusters may be ARM64, x86_64, or mixed-architecture, use Option A with `skopeo copy --all` to preserve every platform variant of multi-arch tags.

### Using the ACP-integrated Harbor registry

If you are pushing to the Harbor registry that ships with ACP (typical endpoint `https://<acp-portal-host>:45443`), the push credentials live in a Secret on the management cluster — they are not the same as your ACP portal login:

```bash
# Read the Harbor admin credentials
REG_USER=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.username}' | base64 -d)
REG_PASS=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.password}' | base64 -d)

REGISTRY_SERVER="<acp-portal-host>:45443"            # e.g. acp.example.com:45443
PRIVATE_REGISTRY="$REGISTRY_SERVER/<your-harbor-project>"   # e.g. acp.example.com:45443/middleware
skopeo login -u "$REG_USER" -p "$REG_PASS" --tls-verify=false "$REGISTRY_SERVER"

# skopeo copy invocation — note --dest-tls-verify=false for the self-signed cert
for img in \
  percona/percona-server-mongodb-operator:1.22.0 \
  percona/percona-server-mongodb:8.0.19-7 \
  percona/percona-backup-mongodb:2.12.0 ; do
    skopeo copy --all --dest-tls-verify=false \
      "docker://docker.io/$img" \
      "docker://$PRIVATE_REGISTRY/$img"
done
```

## Step 2: Create an Image Pull Secret

If your private registry requires authentication (the ACP-integrated Harbor does), cluster nodes cannot pull the images without credentials. Create a `kubernetes.io/dockerconfigjson` Secret in the target namespace and you will attach it to both the operator Deployment and the cluster CR in later steps.

`--docker-server` must be just the registry **host** (no project path). For ACP Harbor that is the value you assigned to `REGISTRY_SERVER` in Step 1 — for example `acp.example.com:45443`, NOT `acp.example.com:45443/middleware`.

Set the three variables for your registry, then create the Secret. If you came from the ACP-Harbor section in Step 1 you already have these set; otherwise define them now:

```bash
REGISTRY_SERVER="<your-registry-host>"     # e.g. registry.example.com:443 (host only — no project path)
REG_USER="<registry-username>"
REG_PASS="<registry-password>"

# For ACP-integrated Harbor specifically, populate REG_USER / REG_PASS from the
# registry-admin Secret on the management cluster (see Step 1's Harbor section):
#   REG_USER=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.username}' | base64 -d)
#   REG_PASS=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.password}' | base64 -d)

kubectl -n "$NS" create secret docker-registry acp-registry-pull \
  --docker-server="$REGISTRY_SERVER" \
  --docker-username="$REG_USER" \
  --docker-password="$REG_PASS"
```

If your registry allows anonymous pulls, skip this step and omit the `imagePullSecrets` fields shown in Steps 4 and 5.

## Step 3: Configure Namespace Pod Security

The default `mongod`, `cfg`, and `mongos` pods created by the operator do not satisfy the Kubernetes Pod Security Admission `restricted` profile. Relabel the namespace where the **cluster CR** will live (the namespace where the database pods run) to `baseline` (or looser) before creating the CR:

```bash
# Defaults to $NS from Prerequisites. Override only if your cluster CR will live
# in a different namespace from the operator (cluster-wide install — see Step 4).
CLUSTER_NS="${CLUSTER_NS:-$NS}"
kubectl label ns "$CLUSTER_NS" \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/audit=baseline \
  pod-security.kubernetes.io/warn=baseline --overwrite
```

> **Important**
> If you installed the operator cluster-wide via `cw-bundle.yaml` (Step 4), the operator's own namespace and the cluster CR's namespace are different. **This step must be applied to the CR's namespace**, not the operator's. The operator pod itself is PSA-compliant and does not need a relabel. The mongod/cfg/mongos pods are what need `baseline`.
>
> If you run clusters in multiple namespaces (cluster-wide operator), repeat this labeling for each CR namespace.

This is the single most common installation failure point. Skipping it produces one of two symptoms:
- StatefulSet exists with `spec.replicas: 3` but `status.readyReplicas: 0` and no mongod pods ever appear. `kubectl describe sts ...` shows events about admission denials.
- Pods show events mentioning `seccompProfile`, `allowPrivilegeEscalation`, or `capabilities`.

## Step 4: Install the Operator

### Choose the operator scope

Upstream ships two operator bundles. Pick the one that matches how you plan to use MongoDB on this cluster:

| Bundle | Scope | Use when |
| :--- | :--- | :--- |
| `bundle.yaml` | **Namespace-scoped** (Role/RoleBinding, `WATCH_NAMESPACE=<its own ns>`). The operator only reconciles `PerconaServerMongoDB` CRs in the namespace it is installed into. | You only need MongoDB in a single namespace, or you want strict per-namespace isolation of operator permissions. |
| `cw-bundle.yaml` | **Cluster-wide** (ClusterRole/ClusterRoleBinding, `WATCH_NAMESPACE=""`). A single operator instance reconciles CRs in every namespace. | You plan to run MongoDB clusters in multiple namespaces, or you want to separate the operator's namespace from the database's namespace. |

> **Important**
> With `bundle.yaml`, the operator's namespace and the cluster CR's namespace must match. If you install the operator in, say, `mongodb-operator` and then create a `PerconaServerMongoDB` CR in `ciam-dev-db`, the CR will sit at empty status forever with no pods and no events — the operator is not watching that namespace. Install `cw-bundle.yaml` instead, or install `bundle.yaml` directly into the namespace where you will create the cluster.

### Apply the bundle

Download the bundle you chose, rewrite the operator image to your private registry, and apply.

```bash
PRIVATE_REGISTRY="<your-private-registry>"
# Defaults to $NS from Prerequisites. Override if you want the operator in a
# different namespace from the cluster CR (only meaningful with cw-bundle.yaml).
OPERATOR_NS="${OPERATOR_NS:-$NS}"
BUNDLE="bundle.yaml"              # or cw-bundle.yaml if you chose cluster-wide above

curl -sL -o "$BUNDLE" \
  "https://raw.githubusercontent.com/percona/percona-server-mongodb-operator/v1.22.0/deploy/$BUNDLE"

# Portable image rewrite (works on both GNU sed and BSD sed / macOS)
sed "s|image: percona/|image: $PRIVATE_REGISTRY/percona/|g" "$BUNDLE" > "$BUNDLE.patched" \
  && mv "$BUNDLE.patched" "$BUNDLE"

# If you chose cw-bundle.yaml, rewrite the hardcoded subject namespace in the
# ClusterRoleBinding to your operator namespace. Upstream hardcodes
# namespace: "psmdb-operator", which means the operator's ServiceAccount has
# no cluster-wide RBAC when you install into any other namespace and the
# operator crash-loops with "forbidden ... at the cluster scope" errors.
# This sed is a no-op on bundle.yaml (which has no such hardcoded subject).
sed "s|namespace: \"psmdb-operator\"|namespace: \"$OPERATOR_NS\"|g" "$BUNDLE" > "$BUNDLE.patched" \
  && mv "$BUNDLE.patched" "$BUNDLE"

kubectl -n "$OPERATOR_NS" apply -f "$BUNDLE" --server-side
```

For `bundle.yaml`, `OPERATOR_NS` must be the same namespace where you will create the cluster CR in Step 5. For `cw-bundle.yaml`, `OPERATOR_NS` is the operator's own namespace; the cluster CR can live anywhere.

If you created an image pull Secret in Step 2, attach it to the operator Deployment before waiting for rollout:

```bash
kubectl -n "$OPERATOR_NS" patch deployment percona-server-mongodb-operator --type=strategic -p \
  '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"acp-registry-pull"}]}}}}'
```

Wait for the operator to come up:

```bash
kubectl -n "$OPERATOR_NS" rollout status deploy/percona-server-mongodb-operator --timeout=120s
```

Verify:

```bash
kubectl -n "$OPERATOR_NS" get pods      # the operator pod should be Running
kubectl get crd | grep psmdb            # three CRDs should be present
```

Expected CRDs:

- `perconaservermongodbs.psmdb.percona.com`
- `perconaservermongodbbackups.psmdb.percona.com`
- `perconaservermongodbrestores.psmdb.percona.com`

## Step 5: Create a MongoDB Cluster

### 5a. Create the user secret

The operator manages five built-in users. Create a Secret containing their credentials; the cluster CR references it by name.

```bash
kubectl -n "$NS" apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ${CLUSTER}-secrets
type: Opaque
stringData:
  MONGODB_BACKUP_USER: backup
  MONGODB_BACKUP_PASSWORD: <change-me>
  MONGODB_DATABASE_ADMIN_USER: databaseAdmin
  MONGODB_DATABASE_ADMIN_PASSWORD: <change-me>
  MONGODB_CLUSTER_ADMIN_USER: clusterAdmin
  MONGODB_CLUSTER_ADMIN_PASSWORD: <change-me>
  MONGODB_CLUSTER_MONITOR_USER: clusterMonitor
  MONGODB_CLUSTER_MONITOR_PASSWORD: <change-me>
  MONGODB_USER_ADMIN_USER: userAdmin
  MONGODB_USER_ADMIN_PASSWORD: <change-me>
EOF
```

> **Important**
> Replace every `<change-me>` with a strong password before applying in any non-test environment.

### 5b. Create the cluster CR

Pick the MongoDB image tag for the version you want. The heredoc below uses `$CLUSTER`, `$PRIVATE_REGISTRY`, and `$STORAGE_CLASS` from your shell — `$PRIVATE_REGISTRY` was set in Step 1; `$CLUSTER` and `$STORAGE_CLASS` were set in Prerequisites. If you did not create an image pull Secret in Step 2, remove the `imagePullSecrets` block.

```bash
MONGO_IMAGE_TAG="8.0.19-7"           # or 7.0.30-16 / 6.0.27-21

kubectl -n "$NS" apply -f - <<EOF
apiVersion: psmdb.percona.com/v1
kind: PerconaServerMongoDB
metadata:
  name: ${CLUSTER}
spec:
  crVersion: 1.22.0
  image: ${PRIVATE_REGISTRY}/percona/percona-server-mongodb:${MONGO_IMAGE_TAG}
  imagePullPolicy: IfNotPresent
  imagePullSecrets:
  - name: acp-registry-pull
  unsafeFlags:
    replsetSize: true     # required for size: 1 (test only — remove for HA)
    mongosSize: true
  upgradeOptions:
    apply: disabled
  secrets:
    users: ${CLUSTER}-secrets
  replsets:
  - name: rs0
    size: 1               # production: 3 or more
    volumeSpec:
      persistentVolumeClaim:
        storageClassName: ${STORAGE_CLASS}
        resources:
          requests:
            storage: 10Gi
  sharding:
    enabled: true
    configsvrReplSet:
      size: 1             # production: 3 or more
      volumeSpec:
        persistentVolumeClaim:
          storageClassName: ${STORAGE_CLASS}
          resources:
            requests:
              storage: 10Gi
    mongos:
      size: 1             # production: 2 or more
  backup:
    enabled: false
    image: ${PRIVATE_REGISTRY}/percona/percona-backup-mongodb:2.12.0
EOF
```

If you left `STORAGE_CLASS` empty to fall back to the cluster default, omit both `storageClassName: ${STORAGE_CLASS}` lines from the heredoc.

For the full Custom Resource field reference and all available options (TLS, monitoring, backup, etc.), see the [Percona Operator Custom Resource reference](https://docs.percona.com/percona-operator-for-mongodb/operator.html).

### 5c. Wait for the cluster to be ready

```bash
kubectl -n "$NS" get psmdb -w
```

Wait for `STATUS=ready`. On healthy storage, the cluster reaches ready within ~60 seconds.

```text
NAME       ENDPOINT                                            STATUS   AGE
my-mongo   my-mongo-mongos.<NS>.svc.cluster.local:27017        ready    55s
```

## Step 6: Access the Cluster

Retrieve the `userAdmin` password and run a non-interactive smoke test against the mongos router:

```bash
PASS=$(kubectl -n "$NS" get secret "${CLUSTER}-secrets" \
  -o jsonpath='{.data.MONGODB_USER_ADMIN_PASSWORD}' | base64 -d)

kubectl -n "$NS" exec "${CLUSTER}-mongos-0" -c mongos -- mongosh --quiet \
  -u userAdmin -p "$PASS" --authenticationDatabase admin \
  --eval 'print(JSON.stringify({version: db.version(), hello: db.hello().msg}))'
```

Expected output: `{"version":"8.0.19-7","hello":"isdbgrid"}` (the `msg` is `isdbgrid` when you connect through a sharded mongos router, or the primary replset name when connecting directly to a replset member).

For an interactive shell:

```bash
kubectl -n "$NS" exec -it "${CLUSTER}-mongos-0" -c mongos -- \
  mongosh -u userAdmin -p "$PASS" --authenticationDatabase admin
```

For external client access, port-forward the mongos service:

```bash
kubectl -n "$NS" port-forward "svc/${CLUSTER}-mongos" 27017:27017
```

Then connect with any MongoDB client at `mongodb://userAdmin:<password>@localhost:27017/?authSource=admin`.

## Limitations

This guide is scoped to a baseline deployment: install the operator, wire it to your private registry, create a sharded MongoDB cluster, and run an access smoke test. Backup, TLS, monitoring, and other advanced features are documented as separate follow-up paths in the tables below.

To set expectations clearly:

- **Verified by Alauda** features have been tested end-to-end on a representative ACP cluster (ACP 4.2 / Kubernetes 1.33, operator v1.22.0). They work as documented here.
- **Not verified by Alauda** features may work, but Alauda has not tested them on ACP. If your use case depends on them, treat the upstream Percona documentation as authoritative and validate in your own environment before relying on them in production.

### Verified by Alauda

| Area | What was tested |
| :--- | :--- |
| Operator install | Bundle apply via `kubectl`, image rewrite to private registry, namespaced operator (single-namespace watch) |
| MongoDB versions | 6.0 (`6.0.27-21`), 7.0 (`7.0.30-16`), 8.0 (`8.0.19-7`) — sharded cluster reaches `ready` for each |
| Cluster topologies | Replica set (sizes 1, 3, 5) and sharded cluster (`rs0` + `cfg` + `mongos`) |
| Built-in user provisioning | All five operator-managed users (`userAdmin`, `databaseAdmin`, `clusterAdmin`, `clusterMonitor`, `backup`) created from `secrets.users` Secret |
| Failover / reelection | Killing the primary triggers reelection; data and replset membership preserved |
| Logical backup + restore | `PerconaServerMongoDBBackup` to S3-compatible MinIO; `PerconaServerMongoDBRestore` correctly rolls the database back to the backup point |
| TLS via cert-manager | `tls.issuerConf` referencing an ACP `ClusterIssuer` (e.g. `cpaas-ca`); operator creates `Certificate` CRs, certs issued, `requireTLS` enforced, mongosh connects over TLS |
| Smart upgrade | Patching `spec.image` from MongoDB 7.0 to 8.0 triggers a rolling restart (secondaries first, primary last); data and replset health preserved |
| PVC resize | With `spec.enableVolumeExpansion: true` and a `StorageClass` that has `allowVolumeExpansion: true`, increasing `volumeSpec.persistentVolumeClaim.resources.requests.storage` propagates to the underlying PVCs without pod restart |
| Replica scaling | `replsets.rs0.size` 3 → 5 (clean join + initial sync) and 5 → 3 (clean decommission) |
| ACP private registry | Mirroring images via `skopeo copy --all` into the ACP-integrated Harbor and pulling them with an attached `imagePullSecret` |

### Not verified by Alauda

Independent validation by the customer is recommended before production use of any of the following:

| Feature | Where to start |
| :--- | :--- |
| Physical and incremental backups | [Backup and restore — physical backups](https://docs.percona.com/percona-operator-for-mongodb/backups.html) |
| Point-in-Time Recovery (PITR) | [Point-in-time recovery](https://docs.percona.com/percona-operator-for-mongodb/backups-pitr.html) |
| LDAP authentication | [LDAP integration](https://docs.percona.com/percona-operator-for-mongodb/ldap.html) |
| HashiCorp Vault for at-rest encryption keys | [Data at rest encryption with Vault](https://docs.percona.com/percona-operator-for-mongodb/encryption.html) |
| PMM (Percona Monitoring and Management) | [Monitor with PMM](https://docs.percona.com/percona-operator-for-mongodb/monitoring.html) |
| Multi-cluster / cross-site sharded clusters | [Multi-cluster deployments](https://docs.percona.com/percona-operator-for-mongodb/replication.html) — requires multiple federated Kubernetes clusters |
| Smart upgrade of a sharded cluster (config server + mongos rollout) | [Upgrade MongoDB version](https://docs.percona.com/percona-operator-for-mongodb/update.html) — only the plain replica-set upgrade has been verified |
| Chained major-version upgrades (e.g. 6.0 → 7.0 → 8.0) | Same upstream guide — only the 7.0 → 8.0 single-hop upgrade has been verified; perform one major hop at a time and re-validate after each |
| Chaos / network-partition self-healing | Beyond simple primary-pod failover; not exercised |

### Supported MongoDB versions

Operator `1.22.0` supports MongoDB **6.0, 7.0, and 8.0** only. **MongoDB 4.x and 5.x are NOT supported.** Running an older operator version that supported MongoDB 4.x/5.x is possible but those operator releases are no longer published on OperatorHub.io and receive no upstream fixes.

### Operator upgrades

Upgrading the operator itself (e.g. `1.22.0` → a future `1.23.x`) is **not covered by this guide**. The image-rewrite + bundle-apply pattern in Step 4 will reinstall a new operator version, but real upgrade flows must follow the upstream procedure to avoid breaking in-flight CRs. See [Update Percona Operator for MongoDB](https://docs.percona.com/percona-operator-for-mongodb/update.html#update-percona-operator-for-mongodb).

### Image registry

Cluster nodes typically cannot reach `docker.io` directly. The procedure assumes you have already mirrored the required Percona images into a private registry that your nodes can pull from (Step 1). If your registry policies later evict the mirrored tags, the operator and clusters will break the next time a pod is recreated.

The image tags pinned in this guide were verified on the publication date. New patch releases appear regularly upstream — periodically re-mirror the latest supported patches by checking the [Percona system requirements page](https://docs.percona.com/percona-operator-for-mongodb/System-Requirements.html).

### Support model

This guide deploys the **upstream community release** of the Percona Server for MongoDB Operator. It is not bundled or supported under the ACP marketplace. Bug reports and feature requests for the operator itself should go to the [upstream Percona issue tracker](https://github.com/percona/percona-server-mongodb-operator/issues). Alauda support can help with platform-level issues (storage, networking, registry, PSA) but does not own the operator's reconciliation behavior.

## Important Considerations

- **Production sizing.** The sample CR is dev/test scale (one pod per role). For production, remove `unsafeFlags`, set `replsets.rs0.size: 3`, `sharding.configsvrReplSet.size: 3`, and `sharding.mongos.size: 2` or more. Review CPU/memory requests, anti-affinity rules, and `PodDisruptionBudget`s.
- **Enabling PVC resize.** Growing `volumeSpec.persistentVolumeClaim.resources.requests.storage` is a **no-op by default**. To let the operator propagate a storage increase to the underlying PVCs, set `spec.enableVolumeExpansion: true` on the `PerconaServerMongoDB` CR. Your StorageClass must also have `allowVolumeExpansion: true`.
- **PVC retention.** Deleting the `PerconaServerMongoDB` resource does **not** remove its PVCs. To release the storage:
  ```bash
  kubectl -n "$NS" delete pvc -l "app.kubernetes.io/instance=${CLUSTER}"
  ```
- **Backup, TLS, and monitoring.** Not covered here; see the [upstream Percona Operator documentation](https://docs.percona.com/percona-operator-for-mongodb/index.html).
- **Operator upgrades.** Follow the [upstream upgrade guide](https://docs.percona.com/percona-operator-for-mongodb/update.html). Image tags must also be updated in your CR.

## Troubleshooting

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| PVC stuck `Pending` | No `StorageClass` with a working provisioner | `kubectl get sc` and create or default a working class |
| `ImagePullBackOff`, `connection reset by peer` to `registry-1.docker.io` | The operator or CR image still references `docker.io` | Re-run the `sed` rewrite in Step 4 or fix the `image:` field in your CR |
| `ImagePullBackOff` with `unauthorized` or `insufficient_scope: authorization failed` | Missing image pull Secret or it is not attached | Complete Step 2 and confirm `spec.template.spec.imagePullSecrets` is set on the operator Deployment and `spec.imagePullSecrets` is set on the CR |
| Pod admission error mentioning `securityContext`, `seccompProfile`, or `capabilities` | Namespace PSA still set to `restricted` | Re-apply the labels from Step 3 |
| Operator log repeats `Waiting for the pods` with `"size":3,"pods":0`; StatefulSet exists but `readyReplicas: 0` and no mongod pods | Step 3 PSA relabel applied to the operator namespace, not the CR namespace — admission rejects the mongod pods silently (StatefulSet events carry the denial) | Relabel the CR namespace per Step 3. Confirm with `kubectl -n <CR_NS> describe sts <cluster>-rs0` — look for admission denial events. |
| Operator emits `replset size below safe minimum` | `unsafeFlags.replsetSize: true` missing for `size: 1` | Add `unsafeFlags` as in the sample, or scale to 3 |
| Cluster CR sits at empty `STATUS`/`ENDPOINT`, no pods, no events | Operator installed with `bundle.yaml` (namespace-scoped) into a different namespace than the CR | Either reinstall the operator into the CR's namespace, or switch to `cw-bundle.yaml` (cluster-wide). See Step 4. |
| `cw-bundle.yaml` deployed but operator crash-loops with `perconaservermongodbrestores.psmdb.percona.com is forbidden ... at the cluster scope` | Upstream's `cw-bundle.yaml` hardcodes `namespace: "psmdb-operator"` in the ClusterRoleBinding subject; installing into any other namespace leaves the operator's ServiceAccount without cluster RBAC | Re-run the `sed` rewrite in Step 4 that substitutes `"psmdb-operator"` with your `$OPERATOR_NS`, then re-apply the bundle. |

## References

- [Percona Operator for MongoDB documentation](https://docs.percona.com/percona-operator-for-mongodb/index.html)
- [Custom Resource reference](https://docs.percona.com/percona-operator-for-mongodb/operator.html)
- [System requirements & supported versions](https://docs.percona.com/percona-operator-for-mongodb/System-Requirements.html)
- [Operator upgrade guide](https://docs.percona.com/percona-operator-for-mongodb/update.html)
- [Source repository on GitHub](https://github.com/percona/percona-server-mongodb-operator)
- [OperatorHub.io listing](https://operatorhub.io/operator/percona-server-mongodb-operator)

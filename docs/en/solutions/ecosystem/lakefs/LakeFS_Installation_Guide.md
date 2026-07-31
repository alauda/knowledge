---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3'
---

<!--
  Authoring model (oss-operator-factory): this guide is authored ONCE by hand. On later
  lakeFS releases, only the slots fenced with `factory:auto:*` markers below are updated by
  the factory pipeline (version, supported versions, known limitations).
  Do NOT hand-edit inside a factory:auto block — those are regenerated from component.yaml /
  release evidence. Prose outside the markers is human-owned and preserved across releases.
-->

# Alauda support for lakeFS — Installation Guide

## Overview

**Alauda support for lakeFS** is the Alauda Application Services (S2, certified) packaging of the
upstream [lakeFS](https://lakefs.io/) data versioning system, listed on the Alauda Cloud marketplace
and installable from the ACP OperatorHub.

lakeFS gives your object storage the workflow of Git. It sits in front of the storage you already
use and lets you:

- **Branch** your data — create an isolated copy of a whole dataset instantly, with no data copied.
- **Commit** changes and keep a full, auditable history of who changed what and when.
- **Merge** a branch back into `main` once your job or pipeline has validated its output.
- **Roll back** to any earlier commit when a bad job corrupts a dataset.
- Work through the **web console**, the `lakectl` command line, or the **S3-compatible gateway**, so
  existing tools (Spark, Trino, pandas, the AWS CLI) can read and write lakeFS repositories without
  code changes.

On Alauda Container Platform (ACP) lakeFS is delivered as an Operator that you install from the
Marketplace. Creating a single `LakeFS` resource then brings up the service and keeps it reconciled
thereafter.

### Supported Versions

<!-- factory:auto:supported-versions BEGIN -->
| Item | Version |
|------|---------|
| ACP | 4.1, 4.2, 4.3 |
| Architectures | amd64 (x86_64), arm64 |
| Network | IPv4, IPv6 |
| Alauda support for lakeFS (bundle) | v1.84.1 |
| lakeFS | 1.84.1 |
| Upstream Helm chart | 1.12.18 |
| License | Apache-2.0 |
<!-- factory:auto:supported-versions END -->

## Prerequisites

- An ACP cluster at one of the supported versions above, and `cluster-admin` access to the target
  workload cluster.
- The **Alauda support for lakeFS** plugin available in your cluster's OperatorHub. If it has not
  been uploaded yet, an administrator can push it with the `violet` CLI:
  ```bash
  violet push lakefs-operator.<version>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- `kubectl` configured against the target cluster.
- **A decision about where lakeFS keeps its data** — see the next section. Make it before you
  install; changing it later means moving data.

## Decide on storage before you install

lakeFS keeps two different things, and they are configured separately:

| | What it is | Where it goes |
|---|---|---|
| **Metadata store** | the commit graph — branches, commits, and the objects each one points at | an embedded key-value store on disk, **or** PostgreSQL |
| **Block store** | the object data itself | a directory on disk, **or** S3-compatible object storage |

The package ships with both set to **local** (embedded store, local directory). That gets you a
working lakeFS in one click, and it is the right choice for an evaluation — but note two
consequences:

1. **It is single-replica only.** The embedded metadata store cannot be shared, so `replicaCount`
   must stay `1`.
2. **Local means the container filesystem unless you attach a volume.** Without one, your
   repositories and their history are gone when the pod restarts.

So there are three sensible shapes:

| Shape | Metadata | Blocks | Replicas | Use it for |
|---|---|---|---|---|
| Out of the box | embedded, container filesystem | container filesystem | 1 | a first look; data is not durable |
| Evaluation, durable | embedded, on a PVC | on the same PVC | 1 | demos and small trials that must survive restarts |
| **Production** | **PostgreSQL** | **S3-compatible storage** | 2+ | real workloads |

Both of the latter two are given in full below.

All three local paths this package configures live under one directory, so a **single volume mounted
at `/home/lakefs`** persists everything:

```
/home/lakefs/metadata   embedded metadata key-value store
/home/lakefs/data       object data
/home/lakefs/cache      committed-data cache
```

## Install the Operator

1. In the ACP Console, go to **Administrator > Marketplace > OperatorHub**, select the target
   cluster, find **Alauda support for lakeFS**, and click **Install**.
2. Keep the default channel (`alpha`). For **Installation Location**, the suggested namespace is
   **`lakefs`**.
3. Confirm the installation.

### Verify the Operator

```bash
kubectl -n lakefs get csv | grep lakefs
kubectl -n lakefs get deploy
```

Expected: the entry `lakefs-operator.v<version>` reaches phase `Succeeded`, and the Operator's own
Deployment shows `1/1` ready.

## Quick start: bring up lakeFS

### 1. Choose an encryption key

`secrets.authEncryptSecretKey` is **required**. lakeFS uses it to encrypt the credentials it stores,
so:

- use a **long random string** — for example `openssl rand -hex 32`;
- **never change it afterwards.** Rotating the key makes every credential already stored
  undecryptable, which locks you out of your own installation.

Keep a copy of it wherever you keep your other secrets.

### 2. Create the LakeFS resource

From the console, open the installed Operator and create a **LakeFS** instance — the form asks for
the encryption key and prefills the rest. To do it from the command line instead, this is the
**evaluation, durable** shape:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: lakefs-data
  namespace: lakefs
spec:
  accessModes: ["ReadWriteOnce"]
  # storageClassName: <your-storage-class>   # omit only if the cluster marks one as default
  resources:
    requests:
      storage: 20Gi
---
apiVersion: lakefs-operator.alauda.io/v1
kind: LakeFS
metadata:
  name: lakefs
  namespace: lakefs
spec:
  replicaCount: 1
  secrets:
    authEncryptSecretKey: "REPLACE-WITH-A-LONG-RANDOM-STRING"
  extraVolumes:
    - name: lakefs-data
      persistentVolumeClaim:
        claimName: lakefs-data
  extraVolumeMounts:
    - name: lakefs-data
      mountPath: /home/lakefs
```

```bash
kubectl apply -f lakefs.yaml
```

> If your cluster does not mark a StorageClass as default, set `storageClassName` explicitly.
> Check with `kubectl get storageclass`.

### 3. Wait for it to come up

```bash
kubectl -n lakefs get deploy lakefs
kubectl -n lakefs get pvc lakefs-data
```

Expected: the Deployment reaches `1/1` and the claim is `Bound`.

### 4. Complete the first-time setup

Open the console and create the first administrator. Without an Ingress, forward the Service:

```bash
kubectl -n lakefs port-forward svc/lakefs 8000:80
# then open http://localhost:8000
```

The setup page asks for an administrator user name and hands back an **access key ID and secret
access key**. Copy them now — the secret is shown only once. They are what `lakectl`, the S3 gateway
and the API all authenticate with.

For an **evaluation** deployment — one using the shipped embedded metadata store — you can do this
step unattended instead, by putting an `installation` block in `lakefsConfig` before you first apply
the resource:

```yaml
  lakefsConfig: |
    installation:
      user_name: admin
      access_key_id: AKIAIOSFODNN7EXAMPLE
      secret_access_key: <a-long-random-secret>
```

> **This does not work when the metadata store is PostgreSQL.** With `database.type: postgres` the
> server starts normally but stays uninitialized, and every API call is rejected with
> `credentials not found`. Set a PostgreSQL-backed deployment up through the setup page above, or
> run the setup command once inside the pod:
>
> ```bash
> kubectl -n lakefs exec deploy/lakefs -- /app/lakefs setup --user-name admin
> ```
>
> That command prints the access key ID and secret access key it created — copy them, as they are
> not shown again. It generates its own key pair and ignores any `installation` values you set.

### 5. Try the Git-like workflow

`lakectl` ships inside the image, so you can run the whole round trip without installing anything:

```bash
POD=$(kubectl -n lakefs get pod -l app.kubernetes.io/instance=lakefs -o name | head -1)

kubectl -n lakefs exec $POD -- sh -c '
  export LAKECTL_SERVER_ENDPOINT_URL=http://lakefs.lakefs.svc.cluster.local:80
  export LAKECTL_CREDENTIALS_ACCESS_KEY_ID=<access-key-id>
  export LAKECTL_CREDENTIALS_SECRET_ACCESS_KEY=<secret-access-key>

  # a repository backed by the local block store (default branch: main)
  /app/lakectl repo create lakefs://demo local://demo

  # commit a file on main
  echo hello > /tmp/f1.txt
  /app/lakectl fs upload -s /tmp/f1.txt lakefs://demo/main/f1.txt
  /app/lakectl commit lakefs://demo/main -m "first commit"

  # branch, change, merge back
  /app/lakectl branch create lakefs://demo/feature -s lakefs://demo/main
  echo world > /tmp/f2.txt
  /app/lakectl fs upload -s /tmp/f2.txt lakefs://demo/feature/f2.txt
  /app/lakectl commit lakefs://demo/feature -m "add f2"
  /app/lakectl merge lakefs://demo/feature lakefs://demo/main

  # both files are now on main
  /app/lakectl fs ls lakefs://demo/main/
  /app/lakectl log lakefs://demo/main
'
```

Expected: `f1.txt` and `f2.txt` both listed on `main`, and the log showing the merge.

The same repository is reachable through the S3 gateway on the same endpoint, so an S3 client can
address `s3://demo/main/f1.txt` using the same access key pair.

## Production configuration

For real workloads, move the metadata store to PostgreSQL and the block store to S3-compatible
storage. Only then can you run more than one replica.

```yaml
apiVersion: lakefs-operator.alauda.io/v1
kind: LakeFS
metadata:
  name: lakefs
  namespace: lakefs
spec:
  replicaCount: 2

  secrets:
    authEncryptSecretKey: "REPLACE-WITH-A-LONG-RANDOM-STRING"
    databaseConnectionString: "postgres://lakefs:REPLACE-PASSWORD@postgres.example.svc:5432/lakefs?sslmode=disable"

  resources:
    requests:
      cpu: 500m
      memory: 1Gi

  ingress:
    enabled: true
    ingressClassName: ""          # empty = the cluster's default ingress class
    hosts:
      - host: lakefs.example.com
        paths: ["/"]

  lakefsConfig: |
    database:
      type: postgres
      # the connection string comes from the Secret above — do not repeat it here
    blockstore:
      type: s3
      s3:
        endpoint: https://s3.example.com
        force_path_style: true    # required by most S3-compatible stores (MinIO, Ceph RGW)
        region: us-east-1
        credentials:
          access_key_id: "REPLACE-ACCESS-KEY"
          secret_access_key: "REPLACE-SECRET-KEY"
    stats:
      enabled: false
    security:
      check_latest_version: false
```

Create the database and the bucket first. Both `secrets.*` values are stored in a Kubernetes Secret,
not in the ConfigMap.

Repositories you create against this deployment must use an `s3://` storage namespace, for example
`lakectl repo create lakefs://demo s3://my-bucket/demo`.

**Set it up before first use.** A PostgreSQL-backed deployment starts uninitialized and will reject
every request until you complete setup — through the setup page, or with
`kubectl -n lakefs exec deploy/lakefs -- /app/lakefs setup --user-name admin`. See the note in
[Complete the first-time setup](#4-complete-the-first-time-setup).

## Configuration reference

Everything under `spec` is passed to the underlying Helm chart, so any chart value is settable. The
ones that matter most:

| Field | Meaning |
|---|---|
| `secrets.authEncryptSecretKey` | **Required.** Encrypts stored credentials. Never change it. |
| `secrets.databaseConnectionString` | PostgreSQL connection string, when `database.type` is `postgres`. |
| `lakefsConfig` | lakeFS's own configuration file, as YAML. This is where the metadata store, block store and first-boot setup are chosen. |
| `replicaCount` | Keep at `1` unless the metadata store is PostgreSQL. |
| `extraVolumes` / `extraVolumeMounts` | Attach a PVC — mount it at `/home/lakefs` to persist the local metadata store, data and cache together. |
| `service.type`, `service.port` | How the service is exposed in-cluster (`ClusterIP` by default). |
| `ingress.enabled`, `ingress.hosts` | External access to the console, API and S3 gateway. |
| `resources` | CPU and memory requests and limits. |

Two behaviours of this package differ from the upstream chart defaults, deliberately:

- **The pod runs unprivileged** — as a non-root user, with all Linux capabilities dropped and the
  default seccomp profile applied. If you attach a volume, its `fsGroup` is set for you so lakeFS can
  write to it.
- **Outbound telemetry and version checks are off**, so the deployment makes no calls to the internet
  and works unchanged on an air-gapped cluster.

## Known Limitations

<!-- factory:auto:known-limitations BEGIN -->
- **The shipped defaults are single-replica.** The embedded metadata store cannot be shared between
  pods, so `replicaCount` must stay `1` until you move the metadata store to PostgreSQL. Scaling up
  before that will produce inconsistent results.
- **Data is not durable out of the box.** With no volume attached, the local metadata store and block
  store live on the container filesystem and are lost on restart. Attach a PVC at `/home/lakefs`
  (evaluation) or use PostgreSQL + S3 (production).
- **The encryption key cannot be rotated.** `secrets.authEncryptSecretKey` encrypts stored
  credentials; changing it on an existing installation makes them undecryptable. Choose it once and
  keep a copy.
- **No upgrade path from the older `lakeFS` chart plugin.** This is a separate, newly published
  Operator package. Install it fresh; the existing chart-based entry does not upgrade into it. To
  carry data across, point the new deployment at the same PostgreSQL database and S3 bucket.
- **The lakeFS Enterprise features are not included.** This package is the Apache-2.0 open-source
  lakeFS. Enterprise-only capabilities (RBAC beyond the built-in model, SSO, audit logs) are not
  available.
- **Unattended setup does not work with a PostgreSQL metadata store.** The `installation` block in
  `lakefsConfig` initializes an evaluation deployment only. With `database.type: postgres` the
  deployment starts but stays uninitialized until you complete setup through the setup page or with
  `/app/lakefs setup`. See [Complete the first-time setup](#4-complete-the-first-time-setup).
<!-- factory:auto:known-limitations END -->

## Uninstall

```bash
kubectl -n lakefs delete lakefs lakefs
```

The workload is removed. A PVC you created yourself is **not** deleted — remove it separately once
you are sure you no longer need the data:

```bash
kubectl -n lakefs delete pvc lakefs-data
```

Then uninstall the Operator from **Administrator > Marketplace > OperatorHub**, or:

```bash
kubectl -n lakefs delete subscription lakefs-operator
kubectl -n lakefs delete csv -l operators.coreos.com/lakefs-operator.lakefs
```

> Delete the `LakeFS` resource **before** you uninstall the Operator. The Operator is what removes
> the underlying release; if it is gone first, the resource cannot finish deleting and its namespace
> will hang in `Terminating`.

## FAQ

**Q: The pod will not start and the volume claim stays `Pending`.**
The cluster has no default StorageClass, or the requested size cannot be satisfied. Run
`kubectl -n lakefs describe pvc lakefs-data` to see which, and set `storageClassName` explicitly.

**Q: I restarted the pod and my repositories are gone.**
No volume was attached, so the local metadata store was on the container filesystem. Reinstall with
a PVC mounted at `/home/lakefs`, as in the quick start.

**Q: Can I run more than one replica?**
Only with PostgreSQL as the metadata store. See [Production configuration](#production-configuration).

**Q: I lost the secret access key from the setup page.**
Sign in to the console with an administrator account and create a new access key pair. The original
secret is shown once and is not recoverable.

**Q: Can existing S3 tools read a lakeFS repository?**
Yes. lakeFS exposes an S3-compatible gateway on the same endpoint. Point the tool at the lakeFS
service address, use the lakeFS access key pair, and address objects as
`s3://<repository>/<branch>/<path>`.

**Q: How do I upgrade?**
Upgrade the Operator from the Marketplace. It rolls the lakeFS Deployment to the matching version and
keeps your metadata store and block store as they are.

---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.0'
---

<!--
  Authoring model (oss-operator-factory): this guide is authored ONCE by hand. On later
  DocumentDB releases, only the slots fenced with `factory:auto:*` markers below are updated by
  the factory pipeline (version, supported versions, known limitations).
  Do NOT hand-edit inside a factory:auto block — those are regenerated from component.yaml /
  release evidence. Prose outside the markers is human-owned and preserved across releases.
-->

# DocumentDB — Installation Guide

## Overview

**DocumentDB** is an open-source, MongoDB-compatible document database built on PostgreSQL
([DocumentDB](https://github.com/documentdb/documentdb)), deployed and managed with the
[DocumentDB Kubernetes Operator](https://github.com/documentdb/documentdb-kubernetes-operator).
Applications connect with standard MongoDB drivers and tools (`mongosh`, `mongodump`,
`mongorestore`) over the MongoDB wire protocol, while data is stored in PostgreSQL with the
DocumentDB extension and managed by a bundled CloudNativePG operator.

This package is provided at the **community support (S0)** level: it packages the upstream
community release as-is, without a CVE remediation SLA or custom feature development. Fixes
follow upstream community releases.

```text
DocumentDB Operator (namespace: documentdb-operator)
CloudNativePG Operator + CNPG-I Sidecar Injector (namespace: cnpg-system)
        │
        ▼
DocumentDB cluster (application namespace)
  └─ PostgreSQL Pod (PostgreSQL 18 + DocumentDB extension, combined image)
       └─ gateway sidecar  ◄──  MongoDB clients (port 10260, TLS)
```

### Supported Versions

<!-- factory:auto:supported-versions BEGIN -->
| Item | Version |
|------|---------|
| ACP | 4.0 (verified on ACP 4.0.12, Kubernetes 1.30) |
| Architectures | amd64 (x86_64), arm64 |
| Network | IPv4 |
| DocumentDB Operator (bundle) | v1.2.1 |
| DocumentDB Kubernetes Operator | 1.2.1 |
| DocumentDB Engine | 1.0.1 (PostgreSQL 18 combined image) |
| Bundled CloudNativePG Operator | 1.29.1 (chart 0.28.3) |
| Upgrade from | None (initial release) |
| License | MIT |
<!-- factory:auto:supported-versions END -->

## Prerequisites

| Requirement | Details |
|---|---|
| Platform | ACP `4.0.12` (Kubernetes `1.30` / `1.31`) with `cluster-admin` access |
| Container runtime | `containerd` (verified on `1.7.23`); `docker` is compatible by design because `combined` image mode does not require Kubernetes `ImageVolume`, though not separately tested |
| `cert-manager` | **Required.** The cluster must provide the `cert-manager.io/v1` API (`Issuer` and `Certificate`). On ACP `4.0.12`, `cert-manager` is pre-installed. If it is absent, the Kubernetes API server rejects installation with `no matches for kind "Issuer" in version "cert-manager.io/v1"`. |
| Storage | A dynamically provisioned `StorageClass` (for example, TopoLVM) |
| CloudNativePG mutual exclusion | **Only one CloudNativePG operator may exist per cluster.** See below. |
| OperatorHub plugin | The **DocumentDB** (`documentdb-operator`) package uploaded to the target cluster's OperatorHub |

### CloudNativePG Mutual Exclusion

DocumentDB `1.2.1` bundles CloudNativePG (`1.29.1`, chart `0.28.3`) and its cluster-scoped CRDs
(`postgresql.cnpg.io`). It **cannot coexist** with another CloudNativePG operator (including the
Alauda CloudNativePG package) in the same cluster.

- The installation chart includes a built-in coexistence guard: if unmanaged `postgresql.cnpg.io`
  CRDs already exist in the cluster, installation is refused with an explicit error.
- If you later need to install another CloudNativePG service on the same cluster, **uninstall
  DocumentDB first**.

### Verify Prerequisites

```bash
kubectl version                                    # Server Version: v1.30.x / v1.31.x
kubectl api-resources --api-group=cert-manager.io  # Must list certificates and issuers
kubectl get crd clusters.postgresql.cnpg.io        # Fresh cluster must return NotFound
kubectl get storageclass                           # Confirm target StorageClass exists
```

## Offline Image List

When you upload the plugin package with `violet push`, all required images are synchronized to
the cluster's registry automatically. For reference or pre-staging audits, the package contains
five multi-arch (`amd64` / `arm64`) runtime images (~600 MiB compressed total for `amd64`):

| Purpose | Upstream Image | Approx. Size (`amd64`) |
|---|---|---|
| DocumentDB Operator | `ghcr.io/documentdb/documentdb-kubernetes-operator/operator:1.2.1` | 305 MiB |
| CNPG-I Sidecar Injector | `ghcr.io/documentdb/documentdb-kubernetes-operator/sidecar:1.2.1` | 25 MiB |
| Database (PostgreSQL 18 + DocumentDB) | `ghcr.io/documentdb/documentdb-kubernetes-operator/documentdb-combined:18-1.0.1` | 172 MiB |
| MongoDB Wire-Protocol Gateway | `ghcr.io/documentdb/documentdb-kubernetes-operator/gateway:1.0.1` | 64 MiB |
| CloudNativePG Operator | `ghcr.io/cloudnative-pg/cloudnative-pg:1.29.1` | 35 MiB |

- `documentdb-combined` and `gateway` are selected at runtime by the DocumentDB operator and do
  not appear in static Deployment manifests, but both are included in the bundle's `relatedImages`
  and must be present in the cluster registry.
- When installed from the marketplace plugin package, runtime image repositories are resolved
  automatically to the cluster's local registry — **no manual image overrides are needed**.
- If your internal registry requires authentication, configure `imagePullSecrets` in
  `documentdb-operator`, `cnpg-system`, and each application namespace (`spec.imagePullSecrets`
  on the `DocumentDB` resource).

## Install the Operator

1. **Upload the plugin package** (if not yet present in OperatorHub):
   ```bash
   violet push documentdb-operator.alpha.ALL.v1.2.1.tgz \
     --platform-address="https://<acp-console>" \
     --platform-username="<user>" --platform-password="<password>" \
     --clusters="<target-cluster>"
   ```
2. **Install from OperatorHub**:
   In the ACP Console, go to **Administrator > Marketplace > OperatorHub**, select the target
   cluster, find **DocumentDB**, and click **Install**.
   - Keep the default channel (`alpha`) and the **All Namespaces** installation mode.
   - Use the suggested namespace **`documentdb-operator`**.
   - Wait until the CSV `documentdb-operator.v1.2.1` reaches phase `Succeeded`.
3. **Create the `DocumentDBOperator` resource**:
   Installing the Operator from OperatorHub does not deploy the DocumentDB and CloudNativePG
   controllers yet. Create a single `DocumentDBOperator` resource in `documentdb-operator` with
   the default empty `spec: {}`:
   ```yaml
   apiVersion: charts.documentdb-operator/v1alpha1
   kind: DocumentDBOperator
   metadata:
     name: documentdb-operator
     namespace: documentdb-operator
   spec: {}
   ```

> **Tip:** Right after uploading or re-uploading a plugin package, a newly created Subscription
> may briefly report `no operators found in package` while the catalog refreshes. Confirm the
> version is visible in OperatorHub, then recreate the Subscription or retry after the catalog
> updates.

### Verify the Installation

```bash
kubectl -n documentdb-operator get csv | grep documentdb-operator
kubectl -n documentdb-operator get deploy documentdb-operator
kubectl -n cnpg-system get deploy
kubectl get certificate -A | grep -E 'documentdb-operator|cnpg-system'
```

Expected:

- `documentdb-operator.v1.2.1` is in phase `Succeeded`.
- `documentdb-operator` (in `documentdb-operator`) and `cloudnative-pg` + `sidecar-injector`
  (in `cnpg-system`) are `Available` with `0` restarts.
- All three `cert-manager` Certificates report `READY=True`.

## Quick Start: Create and Connect to a DocumentDB Instance

### 1. Create the Credentials Secret

The Secret keys must be named `username` and `password`:

```bash
kubectl create namespace <app-namespace>
kubectl -n <app-namespace> create secret generic documentdb-credentials \
  --from-literal=username=<admin-user> \
  --from-literal=password='<strong-password>'
```

### 2. Create a `DocumentDB` Resource

The example below deploys a 3-instance high-availability cluster (1 primary, 2 standbys):

```yaml
apiVersion: documentdb.io/v1
kind: DocumentDB
metadata:
  name: <instance-name>
  namespace: <app-namespace>
spec:
  nodeCount: 1
  instancesPerNode: 3
  exposeViaService:
    serviceType: ClusterIP                    # Required: must be set explicitly
  resource:
    storage:
      pvcSize: 200Gi
      storageClass: <storageclass-name>
      persistentVolumeReclaimPolicy: Retain   # Default; set Delete for disposable test instances
  # imagePullSecrets:                         # Uncomment if your registry requires authentication
  #   - name: <pull-secret-name>
```

> **Important:** Always set `spec.exposeViaService.serviceType` explicitly (`ClusterIP` or
> `LoadBalancer`). In upstream DocumentDB Operator `1.2.1`, omitting this field causes the
> operator to write an empty value that fails validation, leaving the resource stuck in a
> `Failed to add finalizer` loop.

Check cluster readiness:

```bash
kubectl -n <app-namespace> get documentdb <instance-name>
```

Wait until `STATUS` reports `Cluster in healthy state` (about 6 minutes for a 3-instance
cluster). The operator runs in `combined` image mode (`Using combined image mode` in operator
logs), which is required on Kubernetes `1.30` / `1.31`.

### 3. Connect

The operator exposes the current primary through Service
`documentdb-service-<instance-name>.<app-namespace>.svc` on port **`10260`** with **TLS
enabled**:

```text
mongodb://<admin-user>:<strong-password>@documentdb-service-<instance-name>.<app-namespace>.svc:10260/?tls=true&directConnection=true
```

- By default, the gateway uses a self-signed TLS certificate issued by `cert-manager`. For quick
  testing you can pass `tlsAllowInvalidCertificates=true`; for production, configure the CA on
  clients or supply your own certificate via `spec.tls.gateway`.

## High Availability and Failover

In verification on ACP `4.0.12` (`nodeCount: 1`, `instancesPerNode: 3`, pods spread across 3
worker nodes), deleting the primary Pod during continuous 1-write/sec traffic produced:

- **~8 seconds of write interruption**, after which CloudNativePG promoted a standby and traffic
  through `documentdb-service-<instance-name>` resumed automatically.
- **Zero loss of acknowledged writes** during the controlled Pod deletion test.

Operational notes:

- Configure client reconnection and retryable writes in application drivers.
- CloudNativePG uses **asynchronous replication by default**. During an abrupt node failure, a
  small number of recently acknowledged writes may be lost. If your workload requires strict
  RPO = 0, evaluate synchronous replication settings in the upstream documentation and validate
  them under load before production rollout.

## Known Limitations

<!-- factory:auto:known-limitations BEGIN -->
- **One CloudNativePG operator per cluster.** This package bundles CloudNativePG `1.29.1` and
  cannot coexist with another CloudNativePG operator (such as Alauda CloudNativePG). Installation
  is blocked if unmanaged `postgresql.cnpg.io` CRDs exist.
- **One DocumentDB operator per cluster.** Create only one `DocumentDBOperator` resource per
  cluster.
- **`spec.exposeViaService.serviceType` is mandatory.** Leaving it unset prevents reconciliation
  due to an upstream `1.2.1` validation bug.
- **`collation` is not supported.** Queries, indexes, or collections that rely on MongoDB
  `collation` fail (`collation is not supported in the find command yet`).
- **Combined image mode only on ACP 4.0.** Kubernetes `1.30` / `1.31` lacks `ImageVolume`, so
  this package uses `combined` mode. Target-side Change Streams (`wal_level=logical` with
  separate changestream images) are unverified in this mode.
- **Default PV reclaim policy is `Retain`.** Deleting a `DocumentDB` resource leaves its
  PersistentVolumes in `Released` state until manually reclaimed. Set
  `persistentVolumeReclaimPolicy: Delete` only for disposable test instances.
- **Community support (S0) only.** No CVE SLA or custom fixes; upgrades follow upstream
  community releases.
<!-- factory:auto:known-limitations END -->

## Uninstall

1. Delete all `DocumentDB` instances in application namespaces:
   ```bash
   kubectl -n <app-namespace> delete documentdb <instance-name>
   ```
   Verify whether `Released` PersistentVolumes should be backed up or manually deleted (under
   the default `Retain` policy).
2. Delete the `DocumentDBOperator` resource to remove the DocumentDB and CloudNativePG
   controllers:
   ```bash
   kubectl -n documentdb-operator delete documentdboperator documentdb-operator
   ```
3. Uninstall **DocumentDB** from OperatorHub.

To prevent accidental data loss, uninstalling the Operator preserves the `postgresql.cnpg.io`
(10 CRDs) and `documentdb.io` (3 CRDs) CustomResourceDefinitions. Remove them **only** after
confirming no `clusters.postgresql.cnpg.io` or `dbs.documentdb.io` resources remain:

```bash
kubectl get crd -o name | grep -E '(postgresql\.cnpg\.io|documentdb\.io)$'
```

## FAQ

**Does DocumentDB send external telemetry in air-gapped environments?**
In verification on ACP `4.0.12`, OpenTelemetry export is disabled by default
(`request_metrics_enabled: false`, loopback `localhost:4317` only), with no outbound usage
telemetry observed in environment variables or logs. For strict egress control, apply a
`NetworkPolicy` denying public egress from database namespaces.

**How do I migrate an existing MongoDB workload to DocumentDB?**
See the companion guide *How to Migrate from MongoDB to DocumentDB* in this documentation
section for the pre-migration compatibility checklist, verified `mongodump`/`mongorestore`
benchmarks, capacity sizing, consistency checks, and rollback procedure.

**Where is the upstream documentation?**
- [DocumentDB Kubernetes Operator Documentation](https://documentdb.io/documentdb-kubernetes-operator/)
- [DocumentDB Kubernetes Operator on GitHub](https://github.com/documentdb/documentdb-kubernetes-operator)
- [DocumentDB Engine on GitHub](https://github.com/documentdb/documentdb)
- [CloudNativePG Documentation](https://cloudnative-pg.io/documentation/)

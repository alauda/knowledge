---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3,4.4'
id: KB261000005
---

<!--
  Authoring model (oss-operator-factory): this guide is authored ONCE by hand. On later
  External Secrets Operator releases, only the slots fenced with `factory:auto:*` markers below are
  updated by the factory pipeline (version, supported versions, known limitations).
  Do NOT hand-edit inside a factory:auto block — those are regenerated from component.yaml /
  release evidence. Prose outside the markers is human-owned and preserved across releases.
-->

# External Secrets Operator — Installation Guide

## Overview

**External Secrets Operator** (ESO) is the open-source
[External Secrets Operator](https://external-secrets.io/), a CNCF project, listed on the Alauda Cloud
marketplace and installable from the ACP OperatorHub. The package is the community release; its
code and images are not modified.

ESO reads secrets from an external secret store and writes them into ordinary Kubernetes Secrets,
then keeps them in sync. Applications keep consuming a Kubernetes Secret; the value itself lives in
the store your security team already runs:

- **HashiCorp Vault**, AWS Secrets Manager / Parameter Store, Google Secret Manager, Azure Key Vault,
  and many more providers.
- **Another Kubernetes namespace or cluster**, through the `kubernetes` provider.

You describe the sync with two resources:

| Resource | What it says |
|---|---|
| `SecretStore` (one namespace) / `ClusterSecretStore` (whole cluster) | **where** to read from, and how to authenticate |
| `ExternalSecret` | **what** to read, and which Kubernetes Secret to write it into |

### Supported Versions

<!-- factory:auto:supported-versions BEGIN -->
| Item | Version |
|------|---------|
| ACP | 4.1, 4.2, 4.3, 4.4 |
| Architectures | amd64 (x86_64), arm64 |
| Network | IPv4 |
| External Secrets Operator (bundle) | v0.14.4 |
| External Secrets Operator | 0.14.4 |
| Upgrade from | 0.10.7 (amd64) |
| License | Apache-2.0 |
<!-- factory:auto:supported-versions END -->

## Prerequisites

- An ACP cluster at one of the supported versions above, and `cluster-admin` access to it.
- The **External Secrets Operator** plugin available in your cluster's OperatorHub. If it has not
  been uploaded yet, an administrator can push it with the `violet` CLI:
  ```bash
  violet push external-secrets-operator.<version>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- `kubectl` configured against the target cluster.
- **Only one ESO per cluster.** If the cluster already runs ESO 0.10.7 from the marketplace, do not
  install a second copy — [upgrade it](#upgrade-from-0107) instead.

## Install the Operator

1. In the ACP Console, go to **Administrator > Marketplace > OperatorHub**, select the target
   cluster, find **External Secrets Operator**, and click **Install**.
2. Keep the default channel (`alpha`; `stable` carries the same version) and the **Cluster**
   installation mode (all namespaces). For **Installation Location**, the suggested namespace is
   **`external-secrets`**.
3. Confirm the installation.

Installing the Operator does not start ESO yet. ESO itself is deployed by an `OperatorConfig`
resource — one per cluster, in the Operator's namespace:

```yaml
apiVersion: operator.external-secrets.io/v1alpha1
kind: OperatorConfig
metadata:
  name: cluster
  namespace: external-secrets
spec: {}
```

```bash
kubectl apply -f operatorconfig.yaml
```

`spec: {}` keeps the shipped defaults, which are the recommended starting point: they pass the
Pod Security `restricted` profile and pin the images the plugin carries, so they also work in an
air-gapped cluster.

### Verify the installation

```bash
kubectl -n external-secrets get csv | grep external-secrets-operator
kubectl -n external-secrets get operatorconfigs.operator.external-secrets.io cluster \
  -o jsonpath='{.status.conditions[?(@.type=="Deployed")].status}{"\n"}'
kubectl -n external-secrets get deploy
```

Always use the full name `operatorconfigs.operator.external-secrets.io`: other components on ACP
(for example the Ceph CSI driver) also define a kind called `OperatorConfig`, and a bare
`kubectl get operatorconfig` may show one of those instead.

Expected:

- the entry `external-secrets-operator.v0.14.4` reaches phase `Succeeded`;
- the `OperatorConfig` reports `True`;
- four Deployments are ready: the Operator (`external-secrets-operator-controller-manager`) and ESO
  itself (`cluster-external-secrets`, `cluster-external-secrets-webhook`,
  `cluster-external-secrets-cert-controller`).

ESO serves the whole cluster: you create `SecretStore` and `ExternalSecret` resources in your
applications' namespaces, not in `external-secrets`.

## Quick Start: copy a Secret from another namespace

This example needs no external system: it uses ESO's `kubernetes` provider to read a Secret in one
namespace (`eso-source`) and write it into another (`eso-demo`). It is the quickest way to see ESO
work end to end.

### 1. A source Secret, and an identity that may read it

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: eso-source
---
apiVersion: v1
kind: Namespace
metadata:
  name: eso-demo
---
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: eso-source
type: Opaque
stringData:
  password: change-me
---
# The identity ESO uses to read eso-source: a ServiceAccount in eso-demo ...
apiVersion: v1
kind: ServiceAccount
metadata:
  name: eso-reader
  namespace: eso-demo
---
# ... allowed to read Secrets in eso-source, and nothing else.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: eso-reader
  namespace: eso-source
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: eso-reader
  namespace: eso-source
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: eso-reader
subjects:
  - kind: ServiceAccount
    name: eso-reader
    namespace: eso-demo
```

### 2. The store and the ExternalSecret

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: source-namespace
  namespace: eso-demo
spec:
  provider:
    kubernetes:
      remoteNamespace: eso-source
      server:
        url: https://kubernetes.default.svc
        caProvider:
          type: ConfigMap
          name: kube-root-ca.crt
          key: ca.crt
      auth:
        serviceAccount:
          name: eso-reader
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: eso-demo
spec:
  refreshInterval: 1m
  secretStoreRef:
    kind: SecretStore
    name: source-namespace
  target:
    name: db-credentials
    creationPolicy: Owner
  data:
    - secretKey: password
      remoteRef:
        key: db-credentials
        property: password
```

### 3. Check the result

```bash
kubectl -n eso-demo get secretstore source-namespace
kubectl -n eso-demo get externalsecret db-credentials
kubectl -n eso-demo get secret db-credentials -o jsonpath='{.data.password}' | base64 -d; echo
```

Expected: the store shows `Valid` and `Ready=True`, the ExternalSecret shows `SecretSynced` and
`Ready=True`, and the last command prints `change-me`.

Change the source and the copy follows within the `refreshInterval`:

```bash
kubectl -n eso-source create secret generic db-credentials \
  --from-literal=password=rotated --dry-run=client -o yaml | kubectl apply -f -
```

## Read secrets from HashiCorp Vault

The pattern is the same for every external store: a `SecretStore` with that provider's
authentication, and `ExternalSecret`s that name the keys. This example reads a KV version 2 secret
from Vault, authenticating with the Kubernetes auth method, so no Vault token is stored in the
cluster.

### On the Vault side

Run these once with a Vault administrator token (`VAULT_ADDR` points at your Vault):

```bash
# Let Vault validate Kubernetes ServiceAccount tokens from this cluster.
vault auth enable kubernetes
vault write auth/kubernetes/config kubernetes_host=https://<cluster-api-server>:6443

# Read-only access to one path.
vault policy write eso-read - <<'EOF'
path "secret/data/app/*" { capabilities = ["read"] }
EOF

# Bind that policy to one ServiceAccount in one namespace.
vault write auth/kubernetes/role/eso-demo \
  bound_service_account_names=eso-vault \
  bound_service_account_namespaces=eso-demo \
  policies=eso-read ttl=10m

# A secret to read.
vault kv put -mount=secret app/db password=change-me
```

Vault calls the cluster's TokenReview API to validate the ServiceAccount token ESO presents. If Vault
runs outside the cluster, see the Vault documentation on
[Kubernetes auth](https://developer.hashicorp.com/vault/docs/auth/kubernetes) for the reviewer
token and CA options your setup needs.

### On the cluster side

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: eso-vault
  namespace: eso-demo
---
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault
  namespace: eso-demo
spec:
  provider:
    vault:
      server: https://vault.example.com:8200
      path: secret
      version: v2
      auth:
        kubernetes:
          mountPath: kubernetes
          role: eso-demo
          serviceAccountRef:
            name: eso-vault
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-db
  namespace: eso-demo
spec:
  refreshInterval: 1m
  secretStoreRef:
    kind: SecretStore
    name: vault
  target:
    name: app-db
    creationPolicy: Owner
  data:
    - secretKey: password
      remoteRef:
        key: app/db
        property: password
```

Replace `server` with your Vault address. If Vault's certificate is not signed by a public CA, add
its CA under `spec.provider.vault.caProvider` (a ConfigMap or Secret holding the CA certificate).

Check it the same way as the Quick Start: the store reaches `Ready=True`, the ExternalSecret reaches
`SecretSynced`, and the Secret `app-db` holds the value from Vault.

If Vault later refuses ESO (for example the role is removed), the ExternalSecret turns
`Ready=False` with reason `SecretSyncedError`, and the Kubernetes Secret **keeps its last value** —
it is not emptied or deleted. It catches up once access is restored.

## Upgrade from 0.10.7

Clusters that installed **External Secrets Operator 0.10.7** from the marketplace upgrade in place:
0.14.4 is published as the next version of the same marketplace entry, on both the `alpha` and
`stable` channels.

- The existing `OperatorConfig` and every value set in it are kept; the new Operator takes over the
  same ESO installation and upgrades it.
- Existing `SecretStore`, `ClusterSecretStore` and `ExternalSecret` resources keep working, and the
  Kubernetes Secrets they manage are **not deleted or emptied** during the upgrade.
- The ESO Pods restart once.

To upgrade:

1. In the ACP Console, open **Administrator > Marketplace > OperatorHub**, select the cluster, open
   **External Secrets Operator** and approve the pending upgrade to 0.14.4. Or, with `kubectl`, in the
   namespace where 0.10.7 is installed:
   ```bash
   kubectl -n <operator-namespace> get installplan
   kubectl -n <operator-namespace> patch installplan <name> --type merge -p '{"spec":{"approved":true}}'
   ```
2. Verify:
   ```bash
   kubectl -n <operator-namespace> get csv | grep external-secrets-operator
   kubectl get externalsecrets -A
   ```
   Expected: `external-secrets-operator.v0.14.4` reaches `Succeeded`, the 0.10.7 entry is gone, and
   the ExternalSecrets are still `SecretSynced`.

### What changes for an upgraded cluster

- **Four new resource types** are added: `ClusterGenerator`, `GeneratorState`, `Grafana` and
  `QuayAccessToken` generators. The existing API versions do not change.
- **The Operator's metrics endpoint moves** from plain HTTP on port `8080` to HTTPS on port `8443`,
  with Kubernetes RBAC authorization. Update any scrape configuration that read the Operator's
  metrics on `8080`. ESO's own metrics are unchanged.
- **Malformed references behave as in 0.10.7**: a `SecretStore` or `ExternalSecret` with an invalid
  reference is accepted, and reports the error in its status (`Ready=False`) when ESO processes it,
  rather than being rejected when you create it.

## Known Limitations

<!-- factory:auto:known-limitations BEGIN -->
- **One ESO per cluster.** Create exactly one `OperatorConfig`, and do not install ESO from another
  source alongside this Operator.
- **Upgrade from 0.10.7 is supported on amd64 only**, because 0.10.7 was published for amd64 only.
  New installations work on both amd64 and arm64.
- **0.14.4 is outside the upstream support window**: the ESO project maintains only its latest minor
  release.
- The **Bitwarden Secrets Manager** provider is not available: its SDK server component is disabled
  because its image is not part of the plugin.
- Right after an install or upgrade, reading an `ExternalSecret` through the older `v1alpha1` API
  can fail for a short time, until ESO's conversion webhook has its certificate. `v1beta1` is not
  affected.
<!-- factory:auto:known-limitations END -->

## Uninstall

1. Delete the `ExternalSecret`, `SecretStore` and `ClusterSecretStore` resources you no longer need.
   A Kubernetes Secret created with `creationPolicy: Owner` is deleted together with its
   ExternalSecret — keep the ExternalSecret if the application still needs the Secret.
2. Delete the `OperatorConfig`, which removes ESO itself:
   ```bash
   kubectl -n external-secrets delete operatorconfigs.operator.external-secrets.io cluster
   ```
3. Uninstall **External Secrets Operator** from OperatorHub.

The resource definitions (CRDs) stay in the cluster after an uninstall, so that removing the
Operator never deletes your ExternalSecrets or the Secrets they own by accident. Delete them only if
you are sure no resources of these kinds remain:

```bash
kubectl get crd -o name | grep -E 'external-secrets\.io$'
```

## FAQ

**Is the Kubernetes Secret deleted if the external store is unreachable?**
No. The ExternalSecret reports `Ready=False` with reason `SecretSyncedError`, and the Secret keeps its
last synced value until the store is reachable again.

**How fast does a change in the store reach the Secret?**
Within the ExternalSecret's `refreshInterval` (`1m` in the examples). Set `refreshInterval: 0` to
sync once and never refresh.

**Can several namespaces share one store?**
Yes: use a `ClusterSecretStore` instead of a `SecretStore`. It has the same `spec.provider`, and
`ExternalSecret`s in any namespace reference it with `secretStoreRef.kind: ClusterSecretStore`.

**Where is the full list of providers and options?**
In the upstream documentation for this version: <https://external-secrets.io/v0.14.4/>.

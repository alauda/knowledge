---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3'
id: KB260700098
---

<!--
  Authoring model (oss-operator-factory): this guide is authored ONCE by hand. On later
  Konveyor releases, only the slots fenced with `factory:auto:*` markers below are updated by
  the factory pipeline (version, supported versions, default sizes, known limitations).
  Do NOT hand-edit inside a factory:auto block — those are regenerated from component.yaml /
  release evidence. Prose outside the markers is human-owned and preserved across releases.
-->

# Alauda support for Konveyor — Installation Guide

## Overview

**Alauda support for Konveyor** is the Alauda Application Services (S2, certified) packaging of the
upstream [Konveyor](https://www.konveyor.io/) application modernization platform, listed on the
Alauda Cloud marketplace and installable from the ACP OperatorHub.

Konveyor is a CNCF project that helps teams move existing applications to Kubernetes. It lets you:

- **Inventory and assess** applications — record their business services, owners and dependencies,
  then answer assessment questionnaires to surface risk.
- **Analyze source code** for Java, Python, Node.js and C# to find migration blockers, with an effort
  estimate per finding.
- **Discover technologies** an application actually uses.
- **Plan migration waves** and export reports.

On Alauda Container Platform (ACP) the platform is delivered as an Operator that you install from the
Marketplace. Creating a single `Tackle` resource then brings up the whole platform — a REST API
(hub), a web console (ui), and the analysis add-ons — and keeps it reconciled thereafter.

### Supported Versions

<!-- factory:auto:supported-versions BEGIN -->
| Item | Version |
|------|---------|
| ACP | 4.1, 4.2, 4.3 |
| Architectures | amd64 (x86_64), arm64 |
| Network | IPv4, IPv6 |
| Alauda support for Konveyor (bundle) | v0.9.2 |
| Konveyor platform | v0.9.2 |
| License | Apache-2.0 |
<!-- factory:auto:supported-versions END -->

## Prerequisites

- An ACP cluster at one of the supported versions above, and `cluster-admin` access to the target
  workload cluster.
- The **Alauda support for Konveyor** plugin available in your cluster's OperatorHub. If it has not
  been uploaded yet, an administrator can push it with the `violet` CLI:
  ```bash
  violet push alauda-support-for-konveyor.<version>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- `kubectl` configured against the target cluster.
- **A StorageClass that supports ReadWriteOnce volumes.** The platform requests two volumes and will
  not start without one. If your cluster does not mark a StorageClass as default, you must name it
  explicitly in the `Tackle` resource — see [Plan storage first](#plan-storage-first).

## Plan storage first

This is the single most common reason an installation appears to hang, so decide it before you
install.

The `Tackle` resource requests two ReadWriteOnce volumes:

| Volume | Claim name | What it holds | Upstream default | Prefilled in the console form |
|---|---|---|---|---|
| Application database | `tackle-hub-database-volume-claim` | applications, assessments, questionnaires | 10Gi | <!-- factory:auto:default-db-size BEGIN -->5Gi<!-- factory:auto:default-db-size END --> |
| File store | `tackle-hub-bucket-volume-claim` | analysis reports, uploaded archives | **100Gi** | <!-- factory:auto:default-bucket-size BEGIN -->10Gi<!-- factory:auto:default-bucket-size END --> |

Two rules follow:

1. **If you create the `Tackle` resource from the console form**, it is prefilled with the smaller
   sizes above, which most clusters can satisfy.
2. **If you write the YAML by hand and omit the size fields**, you get the upstream defaults —
   including a **100Gi** file store that many clusters cannot bind. Always set
   `hub_database_volume_size` and `hub_bucket_volume_size` explicitly.

Set `rwo_storage_class` and `hub_bucket_storage_class` to a real StorageClass name unless your
cluster has a default one. Check with:

```bash
kubectl get storageclass
```

## Install the Operator

1. In the ACP Console, go to **Administrator > Marketplace > OperatorHub**, select the target
   cluster, find **Alauda support for Konveyor**, and click **Install**.
2. Keep the default channel (`alpha`). For **Installation Location**, keep the suggested namespace
   **`konveyor-tackle`** — the platform is designed to run in the same namespace as the Operator.
3. Confirm the installation.

### Verify the Operator

```bash
kubectl -n konveyor-tackle get csv | grep konveyor
kubectl -n konveyor-tackle get deploy
```

Expected: the entry `alauda-support-for-konveyor.v<version>` reaches phase `Succeeded`, and the
Operator's own Deployment shows `1/1` ready.

## Quick start: bring up the platform

### 1. Create the Tackle resource

From the console, open the installed Operator and create a **Tackle** instance — the form is
prefilled with working values. To do it from the command line instead:

```yaml
apiVersion: tackle.konveyor.io/v1alpha1
kind: Tackle
metadata:
  name: tackle
  namespace: konveyor-tackle
spec:
  # ── Storage ───────────────────────────────────────────────────────────
  rwo_storage_class: ""             # database volume; leave empty only if the cluster has a default
  hub_bucket_storage_class: ""      # file store; leave empty only if the cluster has a default
  hub_database_volume_size: "5Gi"
  hub_bucket_volume_size: "10Gi"    # upstream default is 100Gi — set this explicitly
  rwx_supported: false              # set true only if you have a ReadWriteMany StorageClass

  # ── Access ────────────────────────────────────────────────────────────
  ui_ingress_class_name: "none"     # "none" = no Ingress, reach the console through its Service;
                                    # otherwise use the cluster's real class, e.g. "alb"

  # ── Authentication ────────────────────────────────────────────────────
  feature_auth_required: "false"    # must stay false in this release — see Known Limitations
```

```bash
kubectl apply -f tackle.yaml
```

> `Tackle` accepts any of the platform's configuration keys directly under `spec`. If you use
> `kubectl apply` with keys the CRD does not enumerate, add `--validate=false`.

### 2. Wait for the platform to come up

```bash
kubectl -n konveyor-tackle get deploy tackle-hub tackle-ui
kubectl -n konveyor-tackle get pvc
```

Expected: both Deployments reach `1/1`, and both volume claims are `Bound`.

> **First start takes a few minutes.** The hub has no readiness probe, so it reports Available before
> it has finished preparing its database. Wait until the API answers (next step) rather than trusting
> the Deployment status alone.

### 3. Verify the API and the add-ons

```bash
kubectl -n konveyor-tackle exec deploy/tackle-hub -- \
  curl -s -o /dev/null -w '%{http_code}\n' http://tackle-hub.konveyor-tackle.svc.cluster.local:8080/applications
# -> 200

kubectl -n konveyor-tackle get addons.tackle.konveyor.io
kubectl -n konveyor-tackle get extensions.tackle.konveyor.io
```

Expected: the API returns `200`, and the analyzer / discovery / platform add-ons and the language
provider extensions are registered.

### 4. Open the web console

If you set `ui_ingress_class_name` to a real class, the console is reachable through the Ingress the
platform created:

```bash
kubectl -n konveyor-tackle get ingress
```

Otherwise, forward the console's Service:

```bash
kubectl -n konveyor-tackle port-forward svc/tackle-ui 8080:8080
# then open http://localhost:8080
```

From there you can register your first application, run an analysis, and organize migration waves.
See the [upstream Konveyor documentation](https://konveyor.io/docs/) for how to use each feature.

## Known Limitations

<!-- factory:auto:known-limitations BEGIN -->
- **Authentication cannot be enabled in this release.** Leave `feature_auth_required: "false"`.
  Turning it on starts a Keycloak server and its database, whose container images are published for
  amd64 only and are not included in this package — they would fail to start on arm64 clusters and
  would not be available at all on clusters without internet access. The console is reachable without
  a login; restrict access at the network layer (Ingress rules, NetworkPolicy) if you need to.
- **The experimental AI-assisted migration feature is not available.** Leave
  `experimental_deploy_kai` unset for the same reason.
- **`ui_ingress_class_name` defaults to `nginx`.** If your cluster does not run an ingress controller
  with that class, the platform still installs but the Ingress it creates never routes. Set the
  cluster's real class, or `none` to skip creating one and reach the console through its Service.
- **Running an end-to-end source analysis is not part of the validated install path.** This release
  validates that the platform installs, serves its API and console, registers its add-ons, and
  survives a restart with its data intact. Analyzing a real application additionally needs a
  reachable source repository and enough spare capacity for the analysis pods.
- **There is no upgrade path from the older community `konveyor-operator` catalog entry
  (0.6.0-beta.1).** This is a separate, newly published package. Install it fresh; do not expect the
  older entry to upgrade into it.
<!-- factory:auto:known-limitations END -->

## Uninstall

```bash
kubectl -n konveyor-tackle delete tackle tackle
kubectl -n konveyor-tackle get pvc          # both claims are removed with the resource
```

Deleting the `Tackle` resource removes the hub, the console and **both volumes**, so back up anything
you need first. Then uninstall the Operator from **Administrator > Marketplace > OperatorHub**, or:

```bash
kubectl -n konveyor-tackle delete subscription alauda-support-for-konveyor
kubectl -n konveyor-tackle delete csv -l operators.coreos.com/alauda-support-for-konveyor.konveyor-tackle
```

## FAQ

**Q: The volume claims stay `Pending` and nothing starts.**
Either the cluster has no default StorageClass, or the requested size cannot be satisfied. Run
`kubectl -n konveyor-tackle describe pvc` to see which. Set `rwo_storage_class` and
`hub_bucket_storage_class` to a real class name, and check `hub_bucket_volume_size` — hand-written
YAML that omits it asks for 100Gi.

**Q: `tackle-hub` shows as available but the console reports errors.**
The hub has no readiness probe, so it is marked available before it has finished preparing its
database on first start. Wait until `GET /applications` returns `200` (step 3 above).

**Q: The console cannot be reached, but the pods are all running.**
Check `kubectl -n konveyor-tackle get ingress`. If it is empty, `ui_ingress_class_name` is `none` —
use `port-forward`. If an Ingress exists but does not route, its class does not match any ingress
controller in the cluster; set the cluster's real class.

**Q: Can I move the platform to a different namespace?**
No. The Operator is installed with own-namespace scope and the platform is designed to run alongside
it, in `konveyor-tackle`.

**Q: How do I upgrade?**
Upgrade the Operator from the Marketplace. It rolls the platform components to the matching version
and keeps the existing volumes.

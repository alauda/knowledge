---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3'
id: TBD
---

<!--
  Authoring model (oss-operator-factory): this guide is authored ONCE by hand. On later
  Nacos releases, only the slots fenced with `factory:auto:*` markers below are updated by
  the factory pipeline (version, supported versions, operand image tags, known limitations).
  Do NOT hand-edit inside a factory:auto block — those are regenerated from component.yaml /
  release evidence. Prose outside the markers is human-owned and preserved across releases.
-->

# Alauda support for Nacos — Installation Guide

## Overview

**Alauda support for Nacos** is the Alauda Application Services (S2, certified) packaging of
[Nacos](https://nacos.io/) — Alibaba's platform for dynamic service discovery, configuration
management, and service management — listed on the Alauda Cloud marketplace and installable from the
ACP OperatorHub.

Because the upstream community OLM bundle for Nacos is abandoned, this plugin is delivered in
**chart-wrap** mode: the official `nacos-group/nacos-k8s` Helm chart is wrapped by an
operator-sdk helm-operator and shipped as an OLM Operator. You install the Operator from the
Marketplace, then create a single `Nacos` custom resource; the Operator runs `helm install` under
the hood and manages the resulting Nacos `StatefulSet` and `Service`. An empty `spec` gives you a
ready-to-use **standalone** Nacos with **embedded** storage.

This guide describes how to install **Alauda support for Nacos** from the ACP Marketplace, bring up a
standalone Nacos instance, reach its console, and validate configuration management and service
discovery end to end.

### Supported Versions

<!-- factory:auto:supported-versions BEGIN -->
| Item | Version |
|------|---------|
| ACP | 4.1, 4.2, 4.3 |
| Architectures | amd64 (x86_64), arm64 |
| Alauda support for Nacos (bundle) | v3.0.1 |
| Nacos server (operand) | v3.0.1 (`docker.io/nacos/nacos-server:v3.0.1`, multi-arch) |
| Upstream chart | `nacos-group/nacos-k8s` `/helm` @ `1b98fe67a4b2` (appVersion 3.0.1) |
<!-- factory:auto:supported-versions END -->

> **Networking:** this release is validated on both IPv4 and IPv6 clusters. The release e2e matrix
> covered ACP 4.3 on amd64/IPv6 and ACP 4.2 + 4.1 on arm64/IPv4; other architecture × IP-stack
> combinations (including dual-stack) are expected to work but were not exercised in this release.

## Prerequisites

- An ACP cluster at one of the supported versions above, and `cluster-admin` access to the target
  workload cluster.
- The **Alauda support for Nacos** plugin available in your cluster's OperatorHub. If it is not yet
  uploaded, an administrator can push it with the `violet` CLI (downloaded from **App Store >
  App Onboarding**, matching the target platform version):
  ```bash
  violet push <nacos-operator-plugin-package>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- `kubectl` configured against the target cluster.

## Install Alauda support for Nacos

1. In the ACP Console, go to **Administrator > Marketplace > OperatorHub**, select the target cluster,
   find **Alauda support for Nacos**, and click **Install**.
2. Keep the default channel (`alpha`), choose the target namespace, and confirm the installation. The
   platform creates a `Subscription` and approves the `InstallPlan`.

### Verify the Operator

```bash
# The CSV should reach the Succeeded phase
kubectl -n <operator-namespace> get csv | grep nacos-operator

# The operator controller Deployment should be Available
kubectl -n <operator-namespace> get deploy | grep nacos-operator
```

Expected: the CSV `nacos-operator.v3.0.1` reaches phase `Succeeded`, and the operator's
controller-manager Deployment shows `1/1` ready.

## Quick Start: Deploy a Standalone Nacos

Set variables used in the commands below:

```bash
export NAMESPACE=nacos-demo
kubectl create namespace ${NAMESPACE}
```

### 1. Create the Nacos instance

An empty `spec` deploys standalone Nacos with embedded storage. The chart's standalone Service
`nacos-cs` is type `NodePort`, so no extra object is needed to reach it.

```yaml
apiVersion: nacos-operator.alauda.io/v1
kind: Nacos
metadata:
  name: nacos
  namespace: nacos-demo
spec: {}   # -> global.mode=standalone, nacos.storage.type=embedded, service.type=NodePort
```

```bash
kubectl apply -f nacos.yaml
```

### 2. Wait for Nacos to become Ready

The Operator reconciles the CR into a Nacos `StatefulSet` (release name `nacos`) plus the `nacos-cs`
Service. Wait for the pod to become Ready:

```bash
kubectl -n ${NAMESPACE} rollout status statefulset/nacos --timeout=600s
kubectl -n ${NAMESPACE} get pods,svc
```

> The first rollout can take several minutes — Nacos server 3.x has a slow cold start, and when
> persistence is enabled the PVC must bind first. Allow up to ~10 minutes before treating a
> not-yet-Ready pod as a failure.

Expected: the `nacos-0` pod is `1/1` Running and a `nacos-cs` Service exists exposing these ports:

| Port | Name | Purpose |
|------|------|---------|
| 8848 | http | Nacos server — SDK, config & naming client open-API |
| 8080 | console | Web console + `/v3/console/health/readiness` |
| 9848 / 9849 | — | gRPC client-rpc / raft-rpc |
| 9080 | mcp | MCP endpoint |

### 3. Reach the console (NodePort)

```bash
# console node port (8080 is auto-assigned; the server 8848 port is pinned to 30000)
CONSOLE_PORT=$(kubectl -n ${NAMESPACE} get svc nacos-cs \
  -o jsonpath='{.spec.ports[?(@.name=="console")].nodePort}')
NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')

# Bracket the host if it is an IPv6 address (IPv6-only / air-gapped clusters)
case "$NODE_IP" in *:*) HOST="[$NODE_IP]" ;; *) HOST="$NODE_IP" ;; esac
echo "Console: http://${HOST}:${CONSOLE_PORT}/"

# readiness endpoint — prints the HTTP status (expect 200)
curl -s -o /dev/null -w '%{http_code}\n' "http://${HOST}:${CONSOLE_PORT}/v3/console/health/readiness"
```

### 4. Validate configuration management and service discovery

Exercise the v1 client open-APIs (which stay open in the default topology) against the `nacos-cs`
Service on the server port `8848`. The Nacos pod already ships `curl`, so run the probes with
`kubectl exec` **inside** the pod — this needs no external probe image, which matters on air-gapped /
IPv6-only clusters where an image like `curlimages/curl` cannot be pulled. Curling the Service DNS
from inside the pod also exercises the `nacos-cs` Service routing, not just `localhost`:

```bash
POD=nacos-0
SVC="nacos-cs.${NAMESPACE}.svc.cluster.local:8848"

# (A) publish a config -> "true", then read it back -> key=value
kubectl -n ${NAMESPACE} exec ${POD} -- curl -s -X POST \
  "http://${SVC}/nacos/v1/cs/configs" \
  -d 'dataId=demo.properties&group=DEFAULT_GROUP&content=key=value'
kubectl -n ${NAMESPACE} exec ${POD} -- curl -s \
  "http://${SVC}/nacos/v1/cs/configs?dataId=demo.properties&group=DEFAULT_GROUP"

# (B) register a service instance -> "ok", then list it -> hosts[] with 10.0.0.1:8080
kubectl -n ${NAMESPACE} exec ${POD} -- curl -s -X POST \
  "http://${SVC}/nacos/v1/ns/instance" \
  -d 'serviceName=demo-svc&ip=10.0.0.1&port=8080'
kubectl -n ${NAMESPACE} exec ${POD} -- curl -s \
  "http://${SVC}/nacos/v1/ns/instance/list?serviceName=demo-svc"
```

> [!NOTE]
> If the pod-to-own-Service-ClusterIP path does not converge (some CNIs lack hairpin support),
> substitute `localhost:8848` for the Service DNS in the commands above to confirm Nacos itself is
> healthy while you investigate the routing.

## Configuration via the Install Form

The wrapped CR spec mirrors the upstream chart `values.yaml`. The install form (driven by the plugin's
spec descriptors) exposes the main knobs; you can also set them directly on the CR `spec`:

| Group | CR path | Notes |
|-------|---------|-------|
| Topology | `global.mode`, `nacos.replicaCount` | `standalone` (default) or `cluster`. **Cluster mode requires `nacos.replicaCount` ≥ 3 and external MySQL storage** (see Storage), and is subject to the limitations below |
| Storage | `nacos.storage.type`, `nacos.storage.db.*` | `embedded` (default; standalone only) or external `mysql` (`nacos.storage.db.{host,port,name,username,password}`) — required for cluster mode |
| Persistence | `persistence.enabled`, `persistence.data.storageClassName`, `persistence.data.resources.requests.storage` | retain embedded data across restarts |
| Service | `service.type`, `service.nodePort` | `NodePort` (default) or `ClusterIP` + your own Gateway/Ingress |
| Resources | `resources.requests.cpu`, `resources.requests.memory` | server container requests |
| Security | `nacos.authToken` | **override in production** — see below |

> [!IMPORTANT]
> Nacos server 3.x enables its auth plugin by default and initializes the JWT signing key from the
> configured auth token, which must base64-decode to **≥ 32 bytes**. The chart default (`nil`) crashes
> the container on startup, so this plugin ships a **public placeholder** auth token to make the empty
> `spec` boot. **In production you must override `nacos.authToken`** (install form **Auth Token**, or
> `spec.nacos.authToken`) with your own value. Note that the v1 client open-APIs (`/nacos/v1/cs`,
> `/nacos/v1/ns`) remain open in this configuration — the token only initializes the auth plugin — which
> matches upstream community-chart behavior.

### Persistence (optional)

Standalone + embedded storage uses an `emptyDir` by default, so embedded (Derby) data does not survive
a pod restart. To retain it, enable persistence with a StorageClass:

```yaml
apiVersion: nacos-operator.alauda.io/v1
kind: Nacos
metadata: {name: nacos, namespace: nacos-demo}
spec:
  persistence:
    enabled: true
    data:
      storageClassName: <your-sc>
      resources: {requests: {storage: 5Gi}}
```

## Known Limitations

<!-- factory:auto:known-limitations BEGIN -->
- **First release follows the chart-declared server version (3.0.1).** The official
  `nacos-group/nacos-k8s` chart declares `appVersion: 3.0.1`; newer upstream server versions (3.2.x)
  are tracked by the factory's oss-watch bot and picked up on a later chart bump. This plugin
  version-follows the chart as a unit.
- **Release validation is standalone-focused; cluster mode is not exercised in this release.**
  Cluster mode (`global.mode: cluster`) requires `nacos.replicaCount` ≥ 3 **and** external MySQL
  storage (embedded storage is standalone-only), and the release e2e covered the standalone topology.
- **Cluster mode on arm64 is a known limitation.** The chart's `peer-finder` init image
  (`nacos/nacos-peer-finder-plugin:1.1`) is **amd64-only**, and it is rendered only when
  `global.mode: cluster`. Standalone (the default) does not use it, so it is unaffected.
  Cluster-mode-on-arm awaits a multi-arch peer-finder in a future release.
- **Production must override the default Auth Token** (see the Security note above) — the shipped
  placeholder is public.
<!-- factory:auto:known-limitations END -->

## Cleanup

```bash
kubectl delete nacos nacos -n nacos-demo
kubectl delete namespace nacos-demo
# Uninstall the Operator from Administrator > Marketplace > OperatorHub > Installed, or:
kubectl -n <operator-namespace> delete subscription nacos-operator
kubectl -n <operator-namespace> delete csv nacos-operator.v3.0.1
```

## FAQ

**Q: The Nacos pod is in `CrashLoopBackOff` right after install.**
Check the logs for `IllegalArgumentException: the length of secret key must ... >= 32 bytes`. That
means `nacos.authToken` was set to an invalid (too-short / `nil`) value. Use the shipped default or a
value that base64-decodes to at least 32 bytes.

**Q: The Nacos pod is stuck in `ImagePullBackOff`.**
The plugin rewrites the operand reference to `docker.io/nacos/nacos-server` so the platform image
allowlist can match and rewrite it to the in-cluster registry. On an air-gapped cluster, ensure the
`sync-images` step mirrored `nacos-server:v3.0.1` to the platform registry and that the ImageWhiteList
rewrite is in effect.

**Q: My embedded config disappeared after a pod restart.**
Standalone + embedded storage uses an `emptyDir` by default. Enable `persistence` with a StorageClass
(see [Persistence](#persistence-optional)) to retain data across restarts.

**Q: How do I expose the console outside the cluster without NodePort?**
Set `spec.service.type: ClusterIP` and place your own Gateway/Ingress in front of the `nacos-cs`
Service (console on port 8080, server on 8848).

**Q: How do I upgrade Nacos?**
Upgrade the Operator to the new version from the Marketplace; it reconciles the `Nacos` CR to the
matching chart/operand version. Version-following upgrades are handled by the factory's version-follow
pipeline.

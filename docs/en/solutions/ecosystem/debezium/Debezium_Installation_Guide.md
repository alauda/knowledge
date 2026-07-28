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
  Debezium releases, only the slots fenced with `factory:auto:*` markers below are updated by
  the factory pipeline (version, supported versions, operand image tags, known limitations).
  Do NOT hand-edit inside a factory:auto block — those are regenerated from component.yaml /
  release evidence. Prose outside the markers is human-owned and preserved across releases.
-->

# Alauda support for Debezium — Installation Guide

## Overview

**Alauda support for Debezium** is the Alauda Application Services (S2, certified) packaging of
[Debezium](https://debezium.io/) — the Apache-2.0 change-data-capture (CDC) engine that streams
row-level database changes to messaging and streaming systems — listed on the Alauda Cloud
marketplace and installable from the ACP OperatorHub.

This plugin packages the official Debezium Operator (built from its upstream `debezium/debezium-operator`
Helm chart) as an installable Marketplace Operator. Installing and using it has **two tiers**, which is
worth understanding before you start:

1. You install the **Operator** from the Marketplace (creates the CSV).
2. You create a single **`Debezium`** custom resource. This installs the **Debezium Operator** itself
   (the `debezium-operator` Deployment) with default settings and registers the **`DebeziumServer`**
   CRD.
3. You then create one or more **`DebeziumServer`** custom resources. The Debezium Operator reconciles
   each into a standalone **Debezium Server** instance that captures changes from a source database
   and streams them to a configurable sink.

```
Marketplace install → CSV
   └─ Debezium (debezium-operator.alauda.io/v1)      ← you create this once; deploys the operator
        └─ DebeziumServer (debezium.io/v1alpha1)     ← you create one per CDC pipeline
             └─ Debezium Server pod  →  source DB ⇒ sink (Kafka / Redis / Pulsar / HTTP / …)
```

This guide describes how to install **Alauda support for Debezium** from the ACP Marketplace, bring up
the Debezium Operator, and run a CDC pipeline end to end.

### Supported Versions

<!-- factory:auto:supported-versions BEGIN -->
| Item | Version |
|------|---------|
| ACP | 4.1, 4.2, 4.3 |
| Architectures | amd64 (x86_64), arm64 |
| Alauda support for Debezium (bundle) | v3.6.0 |
| Debezium Operator image | `quay.io/debezium/operator:3.6.0` (multi-arch) |
| Debezium Server image | `quay.io/debezium/server:3.6.0.Final` (multi-arch) |
| Upstream chart | `debezium/debezium-operator` `debezium-operator-3.6.0.tgz` (release asset, appVersion 3.6.0.Final) |
<!-- factory:auto:supported-versions END -->

> **Networking:** this release is validated on both IPv4 and IPv6 clusters. Validation covered
> ACP 4.3 on amd64/IPv6, ACP 4.2 + 4.1 on arm64/IPv4, and ACP 4.1 on amd64/IPv4 — a full
> two-architecture × two-IP-stack matrix, with a live PostgreSQL → Debezium Server → HTTP-sink CDC
> round-trip on every combination. Dual-stack clusters are expected to work but were not exercised.

## Prerequisites

- An ACP cluster at one of the supported versions above, and `cluster-admin` access to the target
  workload cluster.
- The **Alauda support for Debezium** plugin available in your cluster's OperatorHub. If it is not yet
  uploaded, an administrator can push it with the `violet` CLI (downloaded from **App Store >
  App Onboarding**, matching the target platform version):
  ```bash
  violet push <debezium-operator-plugin-package>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- `kubectl` configured against the target cluster.
- A **source database reachable from the cluster** with its CDC prerequisites in place. Debezium's
  requirements are connector-specific; for PostgreSQL (used in the Quick Start below) that means
  `wal_level = logical` and a role that can create a replication slot and a publication.

## Install Alauda support for Debezium

1. In the ACP Console, go to **Administrator > Marketplace > OperatorHub**, select the target cluster,
   find **Alauda support for Debezium**, and click **Install**.
2. Keep the default channel (`alpha`), choose the target namespace (the plugin's default is
   `debezium`), and confirm the installation. The platform creates a `Subscription` and approves the
   `InstallPlan`.

### Verify the Operator

```bash
# The CSV should reach the Succeeded phase
kubectl -n <operator-namespace> get csv | grep debezium-operator
```

Expected: the CSV `debezium-operator.v3.6.0` reaches phase `Succeeded`.

## Quick Start

### 1. Deploy the Debezium Operator (the `Debezium` CR)

Create one `Debezium` resource. An empty `spec` is sufficient — this installs the Debezium Operator
(the `debezium-operator` Deployment) with its default settings. (The `spec` mirrors the upstream
chart's `values.yaml` under `app.*`; see [Configuration](#configuration).)

```yaml
apiVersion: debezium-operator.alauda.io/v1
kind: Debezium
metadata:
  name: debezium
  namespace: debezium
spec: {}
```

```bash
kubectl create namespace debezium 2>/dev/null || true
kubectl apply -f debezium.yaml
```

Wait for the operator Deployment to become Ready:

```bash
kubectl -n debezium rollout status deployment/debezium-operator --timeout=600s
```

> The first rollout can take a few minutes — the plugin installs the Debezium Operator, which has a
> cold start. Allow up to ~10 minutes before treating a not-yet-Ready Deployment as a failure.

Expected: the `debezium-operator` Deployment is `1/1` Available, and the `DebeziumServer` CRD
(`debeziumservers.debezium.io`) is registered:

```bash
kubectl get crd debeziumservers.debezium.io
```

### 2. Run a CDC pipeline (a `DebeziumServer` CR)

Each `DebeziumServer` is one standalone CDC pipeline: a **source** connector reading a database and a
**sink** streaming the change events out. The example below captures changes from a PostgreSQL
database using the `pgoutput` logical-decoding plugin and streams them to Redis. Adjust the `source`
and `sink` for your environment.

```yaml
apiVersion: debezium.io/v1alpha1
kind: DebeziumServer
metadata:
  name: pg-to-redis
  namespace: debezium
spec:
  image: quay.io/debezium/server:3.6.0.Final
  runtime:
    api:
      enabled: true          # exposes the server's status/health API
  source:
    class: io.debezium.connector.postgresql.PostgresConnector
    offset:
      memory: {}             # demo only; use a durable offset store in production (see note)
    schemaHistory:
      memory: {}
    config:
      database.hostname: <postgres-host>
      database.port: 5432
      database.user: <cdc-user>
      database.password: <cdc-password>
      database.dbname: <database>
      topic.prefix: demo
      schema.include.list: public
      plugin.name: pgoutput
  sink:
    type: redis
    config:
      address: "<redis-host>:6379"
```

```bash
kubectl apply -f debeziumserver.yaml
kubectl -n debezium get debeziumserver pg-to-redis
kubectl -n debezium rollout status deployment/pg-to-redis --timeout=300s
```

### 3. Verify change events flow

Make a change in the source database and confirm it reaches the sink:

```bash
# In the source PostgreSQL:  INSERT INTO <table> ...  /  UPDATE ...  /  DELETE ...
# Then confirm the Debezium Server captured it (server API enabled above):
kubectl -n debezium logs deploy/pg-to-redis | grep -i 'Snapshot ended\|Streaming\|captured'
```

Expected: the Debezium Server log shows the snapshot completing and streaming starting, and your sink
(Redis stream, Kafka topic, HTTP endpoint, …) receives one change event per row change, ordered and
durable.

> [!IMPORTANT]
> **HTTP sink specifics.** If you use `sink.type: http`, the Debezium Server requires an explicit
> record format — set `spec.format: json` (or `cloudevents`) on the `DebeziumServer`, otherwise the
> HTTP sink fails to start. Also note the sink URL key is `url` (the operator prefixes it to
> `debezium.sink.http.url`), **not** `http.url`.

## Configuration

The `Debezium` CR `spec` mirrors the upstream chart's `values.yaml` settings (your values are merged
over the chart defaults). Common knobs:

| Group | CR path (`Debezium.spec`) | Notes |
|-------|---------------------------|-------|
| Operator image | `app.image` | pinned by the plugin to `quay.io/debezium/operator:3.6.0`; override only for private mirrors |
| Probes | `app.startupProbe.*`, `app.livenessProbe.*`, `app.readinessProbe.*` | tune operator probe thresholds |
| Resources | `app.resources.{requests,limits}` | operator container resources |

The **`DebeziumServer`** CR is upstream Debezium's own API (`debezium.io/v1alpha1`) — the full source/
sink connector catalog and their `config` keys are documented in the
[Debezium Server reference](https://debezium.io/documentation/reference/stable/operations/debezium-server.html).
Supported sinks include Apache Kafka, Redis, Apache Pulsar, NATS, Google Cloud Pub/Sub, Amazon
Kinesis, and HTTP.

> [!NOTE]
> **Offset & schema-history storage.** The Quick Start uses `memory` offset/schema-history stores for
> brevity — these do **not** survive a Debezium Server restart, so on restart the server re-snapshots.
> For production, configure a durable store (e.g. a Kafka topic or a Redis stream) via the connector
> `config`. See the Debezium Server reference above.

## Known Limitations

<!-- factory:auto:known-limitations BEGIN -->
- **First release ships Debezium Operator 3.6.0.Final.** Newer upstream Debezium versions are picked
  up in later plugin releases published to the Marketplace. The Operator and its `DebeziumServer` API
  are released together as a unit.
- **Source-database CDC prerequisites are the user's responsibility.** Debezium reads a source
  database's transaction log; the source must be configured for CDC (e.g. PostgreSQL `wal_level =
  logical` + a replication-capable role, MySQL binlog `ROW` format, etc.) before a `DebeziumServer`
  can stream from it. This is outside the plugin's scope.
- **Release validation used a PostgreSQL source and an HTTP/Redis sink.** Validation exercised the
  PostgreSQL connector (`pgoutput`) into an HTTP and a Redis sink across the full architecture ×
  IP-stack matrix. Other connectors and sinks are supported by Debezium but were not exercised in this
  release's validation.
<!-- factory:auto:known-limitations END -->

## Cleanup

```bash
# Remove CDC pipelines, then the operator instance, then the namespace
kubectl -n debezium delete debeziumserver --all
kubectl -n debezium delete debezium debezium
kubectl delete namespace debezium
# Uninstall the Operator from Administrator > Marketplace > OperatorHub > Installed, or:
kubectl -n <operator-namespace> delete subscription debezium-operator
kubectl -n <operator-namespace> delete csv debezium-operator.v3.6.0
```

> [!NOTE]
> Deleting the namespace while a `Debezium` CR still exists can hang: the resource's cleanup cannot
> finish once the operator that manages it is being removed at the same time. Delete the
> `DebeziumServer` and `Debezium` resources **first**, wait for them to clear, then delete the
> namespace.

## FAQ

**Q: The `debezium-operator` Deployment never becomes Ready after I create the `Debezium` CR.**
Check the plugin's operator (controller) pod logs and the `Debezium` CR status. A common cause is one
of the images not being pullable on an air-gapped cluster — see the next question.

**Q: A pod is stuck in `ImagePullBackOff`.**
The plugin runs two images: `quay.io/debezium/operator:3.6.0` (the operator) and
`quay.io/debezium/server:3.6.0.Final` (each Debezium Server). On a cluster with internet access these
are pulled automatically. On an **offline / air-gapped cluster**, both images must be available in
your cluster's image registry — uploading the plugin package to the cluster mirrors them for you, so
make sure the upload completed successfully. One common trap: the Debezium **Server** tag carries the
`.Final` suffix (`3.6.0.Final`) while the **Operator** tag does not (`3.6.0`) — a wrong or missing tag
here shows up as `ImagePullBackOff`.

**Q: My `DebeziumServer` starts but no change events appear at the sink.**
Confirm the source database is configured for CDC (for PostgreSQL: `wal_level = logical`, and the
`database.user` can create a replication slot + publication), that `plugin.name: pgoutput` matches
your setup, and that `schema.include.list` / `table.include.list` actually cover the tables you are
changing. For an HTTP sink, remember `spec.format: json` is required and the sink key is `url`.

**Q: Events replay from the beginning after a Debezium Server restart.**
The Quick Start uses in-memory offset storage. Configure a durable offset store (Kafka/Redis) in the
connector `config` for production so the server resumes from its last committed position.

**Q: How do I upgrade Debezium?**
Upgrade the Operator to the new version from the Marketplace; it reconciles the `Debezium` CR to the
matching Debezium version, and `DebeziumServer` resources pick up the new Server image. New Debezium
releases are published to the Marketplace as they are certified.

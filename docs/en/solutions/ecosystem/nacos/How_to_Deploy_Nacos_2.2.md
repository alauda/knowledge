---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 3.18,4.0,4.1
---

# How to Deploy Nacos 2.2

## Introduction

This guide explains how to deliver a production-ready **Nacos 2.2.3** cluster on Alauda Container Platform (ACP) using the Nacos Chart from the Alauda application catalog. Use this document when a customer's SDK is still pinned to a 2.2-compatible client; otherwise prefer the newer [How to Deploy Nacos 2.5](./How_to_Deploy_Nacos_2.5.md) plan.

> **Note**: "Primary" replaces the previously used term "Master" for the leading Nacos node in a cluster.

## Pre-Delivery Notice

1. **IPv6 is not supported.**
2. Nacos versions that the community has explicitly marked end-of-life cannot be supported by Alauda R&D.
3. The community provides no major-version upgrade path, so Alauda also has no in-place upgrade path. To move to a new major version, redeploy from scratch.
4. Alauda only supports Nacos clusters delivered using this plan. Customer-built Nacos clusters are out of scope.
5. Alauda's support covers troubleshooting, vulnerability patches, and bug fixes layered on top of the community release.
6. The Nacos version delivered by this plan is **2.2.3**. Nacos 2.1 has a known HA bug; customers running below 2.2.3 should be upgraded (by redeploy) to 2.2.3.
7. **Confirm SDK compatibility before delivery.** The most common customer issue is a client SDK that pre-dates 2.2.3 — apps then break in unpredictable ways.

To check whether your application SDK version is compatible with this Nacos version, see the [Spring Cloud Alibaba component version table](https://github.com/alibaba/spring-cloud-alibaba/wiki/%E7%89%88%E6%9C%AC%E8%AF%B4%E6%98%8E#%E7%BB%84%E4%BB%B6%E7%89%88%E6%9C%AC%E5%85%B3%E7%B3%BB).

## Architecture Overview

- Nacos is delivered through a Helm Chart and is installed from the platform App Store.
- The cluster defaults to **three nodes** for high availability and can be scaled to any **odd number ≥ 3** (5, 7, …) to suit larger deployments. The Chart sets Kubernetes readiness/liveness probes by default.
- External access can be exposed through `NodePort` or `LoadBalancer`. On ACP, **ALB is the LoadBalancer implementation**; the Web-console verification section below uses an ALB listener. An Istio Ingress Gateway is also supported when one is already deployed in the cluster.
- Monitoring is enabled by default; customers can scrape Nacos metrics with Grafana.
- The plan does **not** cover cross-site DR replication or data migration.
- Major-version upgrades are achieved by destroying the old cluster and redeploying the new version.

## Prerequisites

### 1. Violet CLI

Download the `violet` tool matching your cluster version from **App Store > App Onboarding**.

### 2. Storage Class

A working `StorageClass` is required.

> **Known issue**: With TopoLVM, a physical-node restart has been observed to cause Nacos data loss. If you must use TopoLVM, plan node maintenance carefully. Other CSI drivers backed by network storage are safer.

### 3. MySQL

The Nacos community lists MySQL 5.6.5 as the absolute minimum, but **this plan requires MySQL 5.7.6 or higher** because the bootstrap SQL below uses `CREATE USER IF NOT EXISTS`, which MySQL 5.6 does not support (the clause was added in 5.7.6). MySQL 5.6 is also community-EOL (since 2021). You can use customer-provided MySQL or the Alauda Application Services MySQL Operator.

> **Known issue — MySQL Router < 8.0.35**: Nacos connecting through MySQL Router prior to 8.0.35 fails with `Couldn't read RSA public key from server`. MySQL Router 8.0.35 fixes this. Alauda Application Services ships MySQL 8.0.36 starting in ACP 3.17 (and back-ported to small versions of 3.14 / 3.16).

## Procedure

### 1. Upload the Nacos Material Package

Sign in to Alauda Cloud with a tenant account and download the `nacos` artifact from the App Marketplace. Then push the Nacos package into the target business cluster:

```bash
violet push \
  --platform-address <platform-address> \
  --clusters <business-cluster-name> \
  --platform-username <platform-admin-username> \
  --platform-password <platform-admin-password> \
  nacos-v2.2.3.tgz
```

Sign in to the platform as an administrator, switch to the **Nacos** project and namespace in the App Store, and confirm that the Nacos package is visible.

### 2. Create the Nacos User and Database in MySQL

The block to use depends on whether MySQL Router 8.0.35+ (which fixed the RSA-key handshake bug) is in front of MySQL: if you sit behind an older MySQL Router use `mysql_native_password`, otherwise prefer `caching_sha2_password`. Replace `<account name>` and `<password>` with the values you intend to configure in the Nacos Chart.

#### MySQL Router ≥ 8.0.35 (or direct connection to MySQL)

```sql
CREATE DATABASE IF NOT EXISTS nacos_config;
CREATE USER IF NOT EXISTS '<account name>'@'%'
  IDENTIFIED WITH caching_sha2_password BY '<password>';
GRANT ALL PRIVILEGES ON nacos_config.* TO '<account name>'@'%';
FLUSH PRIVILEGES;
```

#### MySQL Router < 8.0.35

Compatible with MySQL server `8.0.x` (pre-`8.0.35` Router) and `5.7.6+` — the user must use the legacy `mysql_native_password` auth plugin to avoid the Router RSA-key handshake bug noted in Prerequisites.

```sql
CREATE DATABASE IF NOT EXISTS nacos_config;
CREATE USER IF NOT EXISTS '<account name>'@'%'
  IDENTIFIED WITH mysql_native_password BY '<password>';
GRANT ALL PRIVILEGES ON nacos_config.* TO '<account name>'@'%';
FLUSH PRIVILEGES;
```

### 3. Deploy the Nacos Chart

In the App Store, switch to the **Nacos** project and namespace, locate the Nacos chart, and click **Deploy**.

Most parameters have sane defaults. The following fields deserve attention:

| Field | Notes |
| --- | --- |
| `name` | The instance name; `nacos` is a sensible default. |
| `displayName` | Display name, typically `Nacos`. |
| `templateVersion` | For fresh environments only one version is usually shown; on upgrades, pick the newest. |
| Image registry | Must match the registry where the material was pushed; otherwise pulls will fail. |
| `-XX:InitialRAMPercentage` | Default `75.0`. JDK requires at least one decimal place. |
| `-XX:MaxRAMPercentage` | Default `75.0`. Same JDK requirement. |
| Resources | Lab-validated defaults: request 2 cores / 2.5 Gi, limit 2 cores / 4 Gi. Scale to actual load. |
| Deployment mode | `cluster` (default) for three-node HA; `standalone` for single node. Production must use `cluster`. |
| Startup mode | `naming` (default) — Nacos acts as registry only. `config` — config center only. `all` — both. |
| Context path | Default `/nacos`. If changed, replace `/nacos` in all verification URLs below. |
| Admin password | Default `nacos`. Use a strong custom password. Nacos 2.2.3 honours password changes made in the Web console even after restart. |
| `Server Identity Key` | Header key for inter-node auth. For private networks, `identitykey` is fine. Replaces the pre-1.4.1 User-Agent scheme. |
| `Server Identity Value` | Matching header value, e.g. `identityvalue`. |
| Data StorageClass | Name of the StorageClass that backs Nacos data, e.g. `sc-topolvm`. |
| Log StorageClass | Name of the StorageClass for logs. Keeping logs on a separate class protects the data PV from log-driven exhaustion. |
| `db.host` | MySQL host. When using the platform internal MySQL service, include the namespace: `<service-name>.<namespace>`. |
| `db.port` | MySQL port. Default `3306`. |
| `db.name` | MySQL database name. Default `nacos_config`. |
| `db.user` | MySQL user used by Nacos (and by the init container that creates the schema). Default `nacos`. |
| `db.password` | Password matching the user above. |

> **Warning**: Redeploying the Chart wipes the underlying database. Back up first if you intend to re-create the instance.
>
> **JWT signing key**: Unlike the 2.5 chart, the Alauda 2.2 chart does **not** surface a `JWT signing key` parameter — Nacos 2.2.3 falls back to its built-in default token secret. The default is suitable for inter-namespace traffic on a trusted network but is publicly known, so do not rely on it as a security boundary. If you need a custom key, override `nacos.core.auth.default.token.secret.key` in `application.properties` through the chart's advanced options (and remember the same base64 / decoded-≥-32-bytes rule called out in the 2.5 doc).

## Verification

### 1. API Verification

`exec` into any non-Nacos pod in the cluster:

```bash
kubectl -n <namespace> exec -it <pod-name> -- sh
```

In the commands below, replace `<nacos-svc>` with `<nacos-internal-route>.<namespace>.svc.cluster.local`, `<port>` with the Nacos service port (default `8848`), and `<token>` with the access token returned by the login call.

#### Acquire a Token

```bash
curl -X POST 'http://<nacos-svc>:<port>/nacos/v1/auth/login' \
  -d 'username=nacos&password=nacos'
```

Sample response:

```json
{"accessToken":"eyJhbGciOiJI...","tokenTtl":18000,"globalAdmin":true}
```

#### Register an Instance

```bash
curl -X POST 'http://<nacos-svc>:<port>/nacos/v1/ns/instance?serviceName=nacos.naming.serviceName&ip=20.18.7.10&port=8080&accessToken=<token>'
```

#### Discover Instances

```bash
curl -X GET 'http://<nacos-svc>:<port>/nacos/v1/ns/instance/list?serviceName=nacos.naming.serviceName&accessToken=<token>'
```

> **Note**: The registered instance will report `"healthy":false` because this verification only POSTs a registration and never sends heartbeats. For an ephemeral registration, "unhealthy without heartbeats" is the expected steady state.

#### Publish Configuration

```bash
curl -X POST "http://<nacos-svc>:<port>/nacos/v1/cs/configs?dataId=nacos.cfg.dataId&group=test&content=helloWorld&accessToken=<token>"
```

#### Retrieve Configuration

```bash
curl -X GET "http://<nacos-svc>:<port>/nacos/v1/cs/configs?dataId=nacos.cfg.dataId&group=test&accessToken=<token>"
```

> **Note**: The examples above use the v1 OpenAPI for simplicity. Nacos 2.x also exposes a [v2 OpenAPI](https://nacos.io/docs/next/manual/user/open-api/) (`/nacos/v2/...`) with JSON bodies and a different auth path (`/nacos/v2/auth/user/login`) — useful for production tooling, but the v1 calls shown here are the quickest manual smoke test.

### 2. Web Console Verification

The Nacos console is exposed through ALB. Confirm ALB is deployed first, then add a listener:

| Field | Value |
| --- | --- |
| Port | Any free port. |
| Protocol | `TCP`. |
| Algorithm | Round-Robin (default). |
| Internal route group | `nacos`, port `8848` (Nacos default). |
| Session affinity | `Source IP hash`. |
| Backend protocol | `TCP`. |

Open `http://<alb-vip>:<listener-port>/nacos`. The default credentials are `nacos / nacos` — change them immediately on first login.

## FAQ

### Q1. Memory usage exceeds 80% when a 1.x client connects (Nacos resources 4c8g)

Temporarily scale up the Nacos resources to absorb the load, then migrate the client to a 2.x SDK. The root cause is high-frequency heartbeats from 1.x clients that the server cannot reclaim.

Upstream issue: <https://github.com/alibaba/nacos/issues/11424>.

### Q2. After a graceful shutdown of a Nacos client application, the data Nacos reports is inconsistent

Monitor Nacos disk and memory. Disk exhaustion or memory pressure degrades Nacos performance and produces inconsistent reads.

### Q3. HA Nacos on TopoLVM drops out of sync after a host restart

Affected Nacos versions: **2.2.3 and below.**

- On **2.2.3**, the cluster ends up in a divergent state but is recoverable: restart the offline Nacos pod and it rejoins.
- On versions **below 2.2.3**, the divergence is unrecoverable — redeploy to 2.2.3 (or later).

Upstream issue: <https://github.com/alibaba/nacos/issues/8099>.

### Q4. Nacos pod is in `CrashLoopBackOff` with `User limit of inotify instances reached or too many open files`

The host inotify quota is exhausted (often by other workloads on the same node).

Raise the limits on the host:

```text
fs.inotify.max_queued_events = 32768
fs.inotify.max_user_instances = 65536
fs.inotify.max_user_watches = 1048576
```

Also raise `nofile` in `/etc/security/limits.conf` if applications keep many descriptors open. Review applications that create and destroy inotify instances frequently and pool their usage.

### Q5. Nacos pod logs `UnknownHostException jmenv.tbsite.net`

The Nacos peer-finder plugin failed to write `cluster.conf` (often because the API server is overloaded or temporarily unreachable), so Nacos falls back to a hard-coded Taobao-internal endpoint (`jmenv.tbsite.net`). Verify API server health and restart the Nacos pods once it is stable. Upstream code reference: [`alibaba/nacos` "tbsite" search](https://github.com/search?q=repo%3Aalibaba%2Fnacos%20tbsite&type=code).

### Q6. Nacos client logs `Ignore the empty nacos configuration and get it based on dataId`

Nacos resolves configs by composing names; the log line is expected during startup. With older clients, the **file format used by the client** matters — `bootstrap.yaml` succeeds where `bootstrap.properties` may not retrieve configs cleanly. An Alauda-internal Spring Cloud demo lives at `https://gitlab-ce.alauda.cn/middleware/nacos-spring-cloud-example` (ask your Alauda contact for an exported copy if you do not have access to that GitLab).

### Q7. What MySQL size should Nacos use?

| Scale | CPU (vCores) | Memory (RAM) | Storage (SSD) | InnoDB Buffer Pool |
| --- | --- | --- | --- | --- |
| Small / Test | 2 | 4 GB | 50 GB+ | 2–3 GB |
| Medium production | 4 | 8–16 GB | 100–250 GB+ | 4–12 GB |
| Large production | 8+ | 16–32 GB+ | 250–500 GB+ | 12–24 GB+ |

- **Small** — lab, dev, or low-microservice-density early production.
- **Medium** — stable microservice production with clear performance/availability expectations.
- **Large** — high-throughput, mission-critical production where availability and data safety are paramount.

### Q8. After a Nacos 2.2.3 ephemeral instance is taken offline, the pod remains registered under the service

Known community issue affecting Nacos 2.2.3. Fixed in 2.3.x. Track upstream: <https://github.com/alibaba/nacos/issues/11258>. To eliminate the symptom permanently, redeploy Nacos using the [Nacos 2.5 plan](./How_to_Deploy_Nacos_2.5.md).

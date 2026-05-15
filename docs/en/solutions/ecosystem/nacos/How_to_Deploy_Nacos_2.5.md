---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 3.18,4.0,4.1
---

# How to Deploy Nacos 2.5

## Introduction

This guide explains how to deliver a production-ready Nacos 2.5.x cluster on Alauda Container Platform (ACP) using the Nacos Chart from the Alauda application catalog. The plan covers prerequisites, MySQL initialization, Chart parameters, post-deployment verification through the OpenAPI and Web console, and a Grafana dashboard for ongoing monitoring.

> **Note**: "Primary" replaces the previously used term "Master" for the leading Nacos node in a cluster.

## Pre-Delivery Notice

1. Nacos versions that the community has explicitly marked end-of-life cannot be supported by Alauda R&D.
2. The community provides no major-version upgrade path, so Alauda also has no in-place upgrade path for customers. To move to a new major version, redeploy from scratch.
3. Alauda only supports Nacos clusters delivered using this plan. Customer-built Nacos clusters are out of scope.
4. Alauda's support covers troubleshooting, vulnerability patches, and bug fixes layered on top of the community release.
5. The Nacos version delivered by this plan is **2.5.1**.

To check whether your application SDK version is compatible with this Nacos version, see the [Spring Cloud Alibaba component version table](https://github.com/alibaba/spring-cloud-alibaba/wiki/%E7%89%88%E6%9C%AC%E8%AF%B4%E6%98%8E#%E7%BB%84%E4%BB%B6%E7%89%88%E6%9C%AC%E5%85%B3%E7%B3%BB).

## Architecture Overview

- Nacos is delivered through a Helm Chart and is installed from the platform App Store.
- The cluster is fixed at **three nodes** for high availability. The Chart sets Kubernetes readiness/liveness probes by default.
- External access can be exposed through `NodePort` or `LoadBalancer`. On ACP, **ALB is the LoadBalancer implementation**, and the Web-console verification section below uses an ALB listener; if you exposed Nacos via `NodePort` instead, substitute a NodePort Service for the ALB listener.
- Monitoring is enabled by default; a dedicated Grafana dashboard is provided in this guide.
- The plan does **not** cover cross-site DR replication or data migration. For cross-site DR, see the companion document on Nacos hot standby.
- Major-version upgrades are achieved by destroying the old cluster and redeploying the new version.

## Prerequisites

### 1. Violet CLI

Download the `violet` tool matching your cluster version from **App Store > App Onboarding**.

### 2. Storage Class

A working `StorageClass` is required.

> **Known issue**: With TopoLVM, a physical-node restart has been observed to cause Nacos data loss. If you must use TopoLVM, plan node maintenance carefully. Other CSI drivers backed by network storage are safer.

### 3. MySQL

Nacos requires MySQL 5.6.5 or higher. You can use customer-provided MySQL or the Alauda Application Services MySQL Operator.

> **Known issue — MySQL Router < 8.0.35**: Nacos connecting through MySQL Router prior to 8.0.35 fails with `Couldn't read RSA public key from server`. MySQL Router 8.0.35 fixes this. Alauda Application Services ships MySQL 8.0.36 starting in ACP 3.17 (and back-ported to small versions of 3.14 / 3.16).

## Procedure

### 1. Upload the Nacos Material Package

Sign in to Alauda Cloud with a tenant account and download the `nacos` artifact from the App Marketplace. Then push it into the target business cluster:

```bash
violet push \
  --platform-address <platform-address> \
  --clusters <business-cluster-name> \
  --platform-username <platform-admin-username> \
  --platform-password <platform-admin-password> \
  nacos-v2.5.x-yyyy.tgz
```

Sign in to the platform as an administrator, switch to the **Nacos** project and namespace in the App Store, and confirm that the Nacos package is visible.

### 2. Create the Nacos User and Database in MySQL

Pick the SQL block that matches your MySQL version. If MySQL Router prior to 8.0.35 sits in front of MySQL, use `mysql_native_password` to avoid the RSA-key handshake bug noted in Prerequisites; otherwise prefer `caching_sha2_password`. Replace `<account name>` and `<password>` with the values you intend to configure in the Nacos Chart.

#### MySQL ≥ 8.0.35

```sql
CREATE DATABASE IF NOT EXISTS nacos_config;
CREATE USER IF NOT EXISTS '<account name>'@'%'
  IDENTIFIED WITH caching_sha2_password BY '<password>';
GRANT ALL PRIVILEGES ON nacos_config.* TO '<account name>'@'%';
FLUSH PRIVILEGES;
```

#### MySQL < 8.0.35 (e.g. 8.0.34, 7.x, 6.x, 5.x)

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
| Deployment mode | `cluster` (default) for three-node HA; `standalone` for single node. Production must use `cluster`. The cluster size can be any odd number ≥ 3. |
| Context path | Default `/nacos`. If changed, replace `/nacos` in all verification URLs below. |
| Admin password | Default `nacos`. Use a strong custom password. In Nacos 2.5 the password change in the Web console is honoured after restart. |
| `Server Identity Key` | Header key for inter-node auth. For private networks, `identitykey` is fine. Replaces the pre-1.4.1 User-Agent scheme. |
| `Server Identity Value` | Matching header value, e.g. `identityvalue`. |
| `JWT signing key` | Used to sign user-login JWTs (HS256 / RFC 7518). Must be a **base64-encoded** string whose **decoded** value is at least **32 bytes** long — i.e. the base64 string itself is at least **44 characters**. A shorter key causes Nacos to refuse to start. |
| Data StorageClass | Name of the StorageClass that backs Nacos data, e.g. `sc-topolvm`. |
| Log StorageClass | Name of the StorageClass for logs. Keeping logs on a separate class protects the data PV from log-driven exhaustion. |
| `db.host` | MySQL host. When using the platform internal MySQL service, include the namespace: `<service-name>.<namespace>`. |
| `db.port` | MySQL port. Default `3306`. |
| `db.name` | MySQL database name. Default `nacos_config`. |
| `db.user` | MySQL user used by Nacos (and by the init container that creates the schema). Default `nacos`. |
| `db.password` | Password matching the user above. |

> **Warning**: Redeploying the Chart wipes the underlying database. Back up first if you intend to re-create the instance.

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

> **Note**: The examples above use the v1 OpenAPI for simplicity. Nacos 2.x also exposes a [v2 OpenAPI](https://nacos.io/docs/next/manual/user/open-api/) (`/nacos/v2/...`) with JSON request bodies and a different auth path (`/nacos/v2/auth/user/login`) — useful for production tooling, but the v1 calls shown here are the quickest manual smoke test.

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

## Monitoring Dashboard

Apply the dashboard YAML attached to this guide (file: `nacos-dashboard.yaml`, available from the original Confluence attachment of the Nacos 2.5 plan):

```bash
kubectl create -f nacos-dashboard.yaml
```

Once applied, find the Nacos dashboard under **Platform Management > Operations Center > Monitoring > Dashboards**.

## FAQ

### Q1. After a graceful shutdown of a Nacos client application, the data Nacos reports is inconsistent

Monitor Nacos disk, memory, and CPU. Disk exhaustion or memory pressure degrades Nacos performance and produces inconsistent reads — adjust resources to stay clear of these limits.

### Q2. Nacos pod is in `CrashLoopBackOff` with `User limit of inotify instances reached or too many open files`

The host inotify quota is exhausted (often by other workloads on the same node). Raise the limits on the host:

```text
fs.inotify.max_queued_events = 32768
fs.inotify.max_user_instances = 65536
fs.inotify.max_user_watches = 1048576
```

Also raise `nofile` in `/etc/security/limits.conf` if applications on the node keep many descriptors open, and audit applications that churn inotify instances so they pool them.

### Q3. Nacos pod logs `UnknownHostException jmenv.tbsite.net`

The Nacos peer-finder plugin failed to write `cluster.conf` (often because the API server is overloaded or temporarily unreachable), so Nacos falls back to a hard-coded Taobao-internal endpoint (`jmenv.tbsite.net`). Verify API server health and restart the Nacos pods once it is stable. Upstream code reference: [`alibaba/nacos` "tbsite" search](https://github.com/search?q=repo%3Aalibaba%2Fnacos%20tbsite&type=code).

### Q4. Nacos client logs `Ignore the empty nacos configuration and get it based on dataId`

Nacos resolves configs by composing names; the log line is expected during startup. With older clients, the **file format used by the client** matters — `bootstrap.yaml` succeeds where `bootstrap.properties` may not retrieve configs cleanly. An Alauda-internal Spring Cloud demo lives at `https://gitlab-ce.alauda.cn/middleware/nacos-spring-cloud-example` (ask your Alauda contact for an exported copy if you do not have access to that GitLab).

### Q5. What MySQL size should Nacos use?

| Scale | CPU (vCores) | Memory (RAM) | Storage (SSD) | InnoDB Buffer Pool |
| --- | --- | --- | --- | --- |
| Small / Test | 2 | 4 GB | 50 GB+ | 2–3 GB |
| Medium production | 4 | 8–16 GB | 100–250 GB+ | 4–12 GB |
| Large production | 8+ | 16–32 GB+ | 250–500 GB+ | 12–24 GB+ |

- **Small** — lab, dev, or low-microservice-density early production.
- **Medium** — stable microservice production with clear performance/availability expectations.
- **Large** — high-throughput, mission-critical production where availability and data safety are paramount.

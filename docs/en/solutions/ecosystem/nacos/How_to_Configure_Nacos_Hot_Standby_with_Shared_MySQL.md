---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 3.18,4.0,4.1
---

# How to Configure Nacos Hot Standby for Configuration Disaster Recovery (Shared MySQL)

## Introduction

This guide describes a hot-standby disaster-recovery (DR) topology for **Nacos 2.5 configuration data** built on top of a DR-capable MySQL. A primary Nacos cluster ("Nacos A") and a standby Nacos cluster ("Nacos B") share the same logical MySQL (typically an MGR-based DR setup). A third-tier load balancer fronts both clusters so that the active endpoint can be switched quickly during a site failure.

This plan applies to Nacos 2.5.x on ACP 3.18, 4.0, and 4.1.

## Scope and Limitations

This plan covers **configuration-resource hot standby only**. It does not provide multi-write — both Nacos clusters writing to the same database concurrently will corrupt data.

Other limitations to communicate to customers up-front:

1. **Data consistency**: because both clusters write to the same logical database, high concurrent writes or replication lag can produce transient inconsistencies between active and standby that briefly affect service discovery accuracy. The plan tolerates this for config workloads but not for naming workloads (see "Ephemeral services do not replicate" below).
2. **Resource contention**: dual-cluster access concentrates load on one database. Heavy write traffic can cause lock contention.
3. **Switch-over complexity**: when failing over from A to B, residual DB load or replication lag can extend the switch window.

> **Risk**: This plan is for **read-side hot standby** of configuration data. Do **not** use it in active-active write mode — concurrent writes risk data divergence.

## How Nacos Refresh Works

Nacos-server has two reconciliation paths against MySQL:

| Mechanism | Default interval | Setting |
| --- | --- | --- |
| Full dump | 6 hours | `DUMP_ALL_INTERVAL_IN_MINUTE` (constant) |
| Incremental dump | 30 seconds | `dumpChangeWorkerInterval` (hidden) gated by `dumpChangeOn` (hidden, default `true`) — Nacos 2.5 |

Practically, a direct write to the underlying database (with the matching timestamp update) propagates to the Nacos-server cache in roughly 30 seconds, and from there to clients via push.

For deeper internals, see the Nacos configuration cache reconciliation analysis used internally by the team.

## Architecture

```
                            ┌────────────────────────┐
            (active)        │   External LB / F5      │
       ┌───────────────────►│  8848/http  9848/grpc   │◄───────────────────┐
       │                    └────────────────────────┘                     │
       │                                                                   │
┌──────┴──────┐                                                     ┌──────┴──────┐
│   Nacos A   │                                                     │   Nacos B   │
│  (primary)  │                                                     │ (standby)   │
└──────┬──────┘                                                     └──────┬──────┘
       │                                                                   │
       └──────────────►   DR-capable MySQL (MGR / equivalent)   ◄───────────┘
```

- Nacos A is the active cluster that clients hit.
- Nacos B reads the same database and stands by, ready to take over.
- The LB has two listeners — `8848/http` and `9848/grpc` — and the gRPC port **must** be exactly `http + 1000`.

## Prerequisites

1. A DR-capable MySQL — Nacos supports MySQL or any MySQL-protocol-compatible store. The team's recommended DR pattern is the internal MGR hot-standby scheme (consult your DR runbook for that database).
2. The MySQL endpoint must be reachable from both Nacos clusters.
3. The user/database (`nacos_config` and the Nacos user) must be created exactly once on the shared logical MySQL.
4. An external load balancer or F5 device in front of both Nacos clusters.
5. Both Nacos clusters can be installed using [How to Deploy Nacos 2.5](./How_to_Deploy_Nacos_2.5.md). This document only spells out the deltas between a standalone install and the DR install.

## Procedure

### 1. Provision the DR MySQL

Deploy the DR MySQL according to the team's MySQL DR runbook (MGR hot standby, or equivalent). Initialize the Nacos schema **only once** — Nacos B will reuse Nacos A's tables.

### 2. Deploy Nacos A (Primary)

Follow [How to Deploy Nacos 2.5](./How_to_Deploy_Nacos_2.5.md). When configuring `db.host`, point it at the DR MySQL endpoint accessible from cluster A.

### 3. Deploy Nacos B (Standby)

Follow the same plan, with two deltas:

1. `db.host` must point at the DR MySQL endpoint accessible from cluster B (typically a different reader/writer route, but ultimately the same logical database).
2. The **JWT signing key must match Nacos A**. A user that logs in against A receives a token signed with A's key; once the LB cuts to B, B must accept that token, so both clusters need the same key.

> **Note**: You do **not** need to copy the Nacos admin user across — it lives in the `users` table of the shared MySQL, so B inherits it automatically. `Server Identity Key` / `Server Identity Value` are **intra-cluster peer-auth** headers used between Nacos pods of the same cluster; they may differ between A and B without breaking the DR plan.

### 4. Provision the External Load Balancer

Configure two listeners on the LB:

| Port | Protocol | Purpose |
| --- | --- | --- |
| `8848` | HTTP | Initial connection / handshake. |
| `9848` | gRPC | Real-time push between Nacos and clients. Must be exactly `8848 + 1000`. |

Both listeners initially point at Nacos A.

## Failover

### Replication-Lag Budget

The total propagation delay to a client request answered by the standby has two components:

1. Database replication lag — determined by the underlying MySQL DR mechanism.
2. Nacos cache refresh — bounded by the 30-second incremental dump cycle (with some database-scan variance).

Nacos DR RTO is therefore **at least `database DR RTO + 30 seconds`**, and can exceed that under sustained database load or while a longer full-dump pass is running.

### Failover Steps

1. **Verify standby data integrity** — log in to Nacos B's dashboard and confirm the expected configs are present and current. If MySQL replication has gaps, surface them now so the operator knows what may be missing.
2. **Cut the LB over to Nacos B** — switch both the `8848/http` and `9848/grpc` listeners simultaneously. Mismatched endpoints (HTTP pointing to A, gRPC pointing to B) will break push semantics.

## Verification

The verification scenarios below assume the LB still points at Nacos A.

### Configuration Sync — Create

1. Create config `test.yaml` on Nacos A with values `a: 1`, `b: 2`.
2. Open Nacos B's dashboard and verify `test.yaml` is visible with the same data within ~30 seconds.

### Configuration Sync — Update

1. On Nacos A, change `a` to `111`.
2. Refresh Nacos B's dashboard and confirm `a` is now `111`.

### Configuration Sync — Delete

1. Delete `test.yaml` on Nacos A.
2. Confirm it is gone from Nacos B.

### Naming Data Behavior

Naming data splits along the ephemeral/persistent boundary:

- **Ephemeral instances** (heartbeat-driven, the default for most Spring Cloud / Dubbo apps) live only in each Nacos cluster's memory. They do **not** replicate.
- **Persistent instances** (`ephemeral=false`) are stored in MySQL `instances`-style tables and therefore *do* appear on the standby — but the live health state, push subscriptions, and dispatcher state are still in-memory, so persistent registrations cannot be served seamlessly through this DR scheme either.

Run these to confirm that ephemeral naming traffic is **not** part of this plan:

1. Register an ephemeral instance against Nacos A — it should not appear in Nacos B.
2. Register an ephemeral instance against Nacos B — it should not appear in Nacos A.

For workloads that need DR coverage of naming data, treat that as a separate design and do **not** rely on this configuration-only plan.

## References

1. <https://nacos.io/blog/faq/nacos-user-question-history8438/>
2. <https://nacos.io/blog/faq/nacos-user-question-history15856/>

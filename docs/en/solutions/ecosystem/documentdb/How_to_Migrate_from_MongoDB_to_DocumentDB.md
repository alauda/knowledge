---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.0'
  - '4.2'
  - '4.3'
  - '4.4'
  - '4.5'
---

# How to Migrate from MongoDB to DocumentDB

## Introduction

This guide describes how to migrate existing **MongoDB** instances (hundreds of GB to **1 TB+**
per instance) to **DocumentDB** (`documentdb-operator` bundle `v1.2.2`, upstream operator `1.2.1`,
DocumentDB engine `1.0.1`, bundled CloudNativePG `1.29.1`) running on **ACP `4.0`, `4.2`–`4.5`**
(Kubernetes `1.30`–`1.36`).

All benchmark and compatibility results reported as *verified* in this guide were measured on
an ACP `4.0.12` test environment (`Kubernetes v1.30.14`, `containerd 1.7.23`, `amd64`, IPv4,
TopoLVM storage).

### Scope and Boundaries

**Covered:**

- Pre-migration MongoDB compatibility assessment
- Migration strategy and maintenance-window estimation
- Storage and staging capacity planning
- Step-by-step offline migration procedure
- Data consistency verification and rollback plan

**Not covered:**

- Refactoring application queries or schemas that use unsupported MongoDB features
- Per-instance cutover execution for specific business applications

## Pre-Migration Compatibility Checklist

Target engine metadata measured on DocumentDB `1.0.1`: `hello.maxWireVersion = 21`,
`buildInfo.version = 7.0.0`.

### Verified Capabilities

| Category | Features Tested | Result |
|---|---|---|
| Basic CRUD | `insert`, `find`, `update`, `delete` | Pass |
| Indexes | Single-field, compound, unique (duplicate key rejected), TTL, `text` (`$text`), `2dsphere` (`$near`), partial | Pass |
| Aggregation | `$match`, `$group`, `$lookup` | Pass |
| Transactions | Multi-document transactions (`startSession` + `withTransaction`) | Pass |
| GridFS | `mongofiles` put/get with SHA-256 verification | Pass |

### High-Risk and Unsupported Items (Check Before Migration)

| Item | Risk / Limitation | Recommended Action |
|---|---|---|
| **`collation`** | **Not supported.** Verified error: `collation is not supported in the find command yet`. | Audit queries, indexes, and collection defaults for `collation`; affected workloads require application changes before migration. |
| Legacy drivers / wire protocol | MongoDB 3.x / 4.0 era drivers may not negotiate with the newer wire protocol. | Inventory driver versions across all client applications and test each against DocumentDB. |
| Sharded clusters | Target DocumentDB instances are non-sharded. | Export from `mongos` and consolidate into a single DocumentDB instance; size capacity for the combined dataset. |
| Change Streams (on target) | Requires the `ChangeStreams` feature gate (`wal_level=logical` and separate changestream images), which is **unverified** in `combined` mode. | Treat applications relying on Change Streams as high-risk and evaluate separately. |
| Users and roles | SCRAM users and custom roles are not migrated with BSON dumps. | Recreate users and roles manually on DocumentDB and verify least-privilege access. |
| Views, capped collections, validators, `system.js` | May be unsupported or behave differently. | Export definitions and validate each item against the target instance. |
| Other aggregation stages / operators | Not all MongoDB operators were exercised in baseline verification. | Replay representative production queries and aggregations against a staging DocumentDB instance. |

### Source Discovery Script (`mongosh`)

Run the following checks against the source MongoDB instance before committing to a migration
window:

```javascript
// 1) Server version and topology
db.version();
db.adminCommand({ hello: 1 });

// 2) Collection metadata per database: views, capped, validators, default collation
db.adminCommand({ listDatabases: 1 }).databases.forEach(d => {
  const x = db.getSiblingDB(d.name);
  x.getCollectionInfos().forEach(c => {
    const o = c.options || {};
    if (c.type === "view" || o.capped || o.validator || o.collation) {
      print(
        d.name + "." + c.name,
        JSON.stringify({
          type: c.type,
          capped: !!o.capped,
          validator: !!o.validator,
          collation: o.collation
        })
      );
    }
  });
});

// 3) Indexes with collation
db.adminCommand({ listDatabases: 1 }).databases.forEach(d => {
  const x = db.getSiblingDB(d.name);
  x.getCollectionNames().forEach(n =>
    x[n].getIndexes().forEach(i => {
      if (i.collation) print(d.name + "." + n, i.name, JSON.stringify(i.collation));
    })
  );
});

// 4) Stored JavaScript functions in system.js
db.adminCommand({ listDatabases: 1 }).databases.forEach(d => {
  const n = db.getSiblingDB(d.name).getCollection("system.js").countDocuments({});
  if (n > 0) print(d.name, "system.js:", n);
});

// 5) Users and custom roles (run per database)
db.getUsers();
db.getRoles({ showBuiltinRoles: false });

// 6) Live queries using collation (requires profiler enabled over a representative workload window)
db.system.profile.find({ "command.collation": { $exists: true } }).limit(20);

// 7) Connected client driver versions
db.currentOp(true)
  .inprog.filter(o => o.clientMetadata)
  .map(o => o.clientMetadata.driver);
```

## Migration Strategy

### Baseline Path (Recommended, Verified): Offline `mongodump` / `mongorestore`

```text
Freeze writes → mongodump --gzip (from Secondary) → mongorestore --noIndexRestore → Rebuild secondary indexes → Verify → Cut over
```

#### Measured Baseline (ACP `4.0.12`, 3-Instance DocumentDB, TopoLVM)

| Metric | Measured Value |
|---|---|
| Test dataset | `2.03 GB` raw BSON, 2,000,000 documents, 4 collections (~1 KB average document) |
| Data load (`mongorestore --noIndexRestore`, 4x4 concurrency) | **51 s (~143 GB/h)**, 2,000,000 succeeded, 0 failed |
| Secondary index build (8 indexes) | **63 s** |
| Combined load + index throughput | **~64 GB/h** |
| PostgreSQL storage amplification | **1.33x** (`2,565 MiB` database size / `1,934 MiB` raw BSON, including `_id` and 8 secondary indexes) |
| WAL disk footprint | Capped at **~2.5–3 GB** under defaults (`max_wal_size=2GB`, `wal_keep_size=512MB`); does not grow linearly with dataset size |

> **Note:** The baseline dataset is synthetic and fits largely in memory. Use these numbers only
> for order-of-magnitude planning. **Determine the actual maintenance window by running a
> representative 10–50 GB sample of real production data** (Step 3 below).

#### Linear Estimate for a 1 TB Dataset

| Phase | Linear Projection from Baseline |
|---|---|
| Data load (~143 GB/h) | ~7 hours |
| Secondary index rebuild | ~9 hours (depends heavily on index count and types) |
| Source dump, transfer, and verification | Account for separately based on source I/O and network |
| **Minimum planned maintenance window** | **~16 hours+** |

When data exceeds available RAM, documents are larger, or collections have many indexes,
real-world throughput will be lower than a linear projection. Reserve extra buffer time.

### Incremental / Online Sync (e.g., MongoShake) — Unverified

Online synchronization tools read the source replica set oplog and replay bulk writes and DDL
into the target to shorten cutover downtime.

- **Current status:** Compatibility of bulk upserts, `applyOps`-style batching, and index DDL
  with DocumentDB has **not been verified**.
- **Entry gate:** Do not commit to online sync until a **1–10 GB representative pilot**
  completes full sync + incremental catch-up + zero-diff consistency verification without errors.
- Until that pilot succeeds, **plan exclusively around the offline maintenance-window baseline**.

## Capacity Planning

| Resource | Recommendation |
|---|---|
| PVC per DocumentDB instance | **>= 1.6x–2x source raw data size** (`1.33x` observed amplification + WAL + growth headroom) |
| Total cluster storage | Each replica holds a full copy: for a 3-instance cluster, total storage = `3 x single-instance PVC` |
| Dump staging disk | **0.4x–0.6x source raw data size** (gzip compression ratio varies; verify on a sample) |

Example for **1 TB** of raw source data: allocate **1.6–2 TB PVC per instance** (**4.8–6 TB**
total across 3 instances) and **400–600 GB** for staging dumps.

## Standard Migration Procedure

1. **Pre-check**
   - Complete the compatibility checklist and `mongosh` discovery script above.
   - Confirm all incompatible features are resolved or explicitly accepted.
   - Confirm the maintenance window and rollback owner.
2. **Prepare the Target**
   - Deploy the target `DocumentDB` cluster sized per Capacity Planning (explicitly setting
     `spec.exposeViaService.serviceType`).
   - Recreate application users and roles.
   - Prepare staging storage and MongoDB Database Tools (`mongosh`, `mongodump`, `mongorestore`;
     for air-gapped environments, pre-sync a tools image such as `mongo:7.0`, ~290 MiB).
3. **Sample Rehearsal and Sizing**
   - Run the full export → load → index rebuild → verification workflow on a representative
     **10–50 GB** slice (or the largest collections).
   - Measure real throughput and storage amplification to finalize the production window.
4. **Freeze Writes**
   - Stop application writes and confirm source write counters are flat
     (`db.serverStatus().opcounters`).
   - Optionally place the source instance in read-only mode.
5. **Export from a Secondary**
   ```bash
   mongodump \
     --uri="mongodb://<user>:<password>@<source-secondary>/?authSource=admin&readPreference=secondary" \
     --gzip --numParallelCollections=4 --out=/backup/dump
   ```
   Export only application databases; do **not** restore `admin`, `config`, or `local`.
6. **Load Data Without Indexes**
   ```bash
   mongorestore \
     --uri="mongodb://<user>:<password>@documentdb-service-<instance-name>.<namespace>.svc:10260/?tls=true&directConnection=true" \
     --tlsInsecure --gzip --numParallelCollections=4 --numInsertionWorkersPerCollection=4 \
     --noIndexRestore --nsExclude='admin.*' --nsExclude='config.*' --nsExclude='local.*' \
     /backup/dump
   ```
   - Use `--tlsInsecure` only for self-signed test certificates; in production pass `--tlsCAFile`.
   - Record total restored and failed document counts from the output log.
7. **Rebuild Indexes Explicitly**
   - Recreate secondary indexes using the definitions exported from source `getIndexes()` via
     `createIndex`.
   - Skip or adapt any index that specified `collation`.
   - Record build duration per index.
8. **Verify Consistency**
   - Complete all checks in the Data Consistency Verification section below before cutover.
9. **Cut Over Applications**
   - Update application connection strings (host, port `10260`, TLS settings) or DNS and resume
     writes gradually.
10. **Observation Period**
    - Monitor error logs, slow queries, and storage utilization. Keep the source MongoDB intact
      and read-only throughout the observation period.

## Data Consistency Verification

| Check | Method | Pass Criterion |
|---|---|---|
| Document counts | `countDocuments({})` per collection on source and target | Exact match |
| Index metadata | Compare `getIndexes()` per collection (`name`, `key`, `unique`, `expireAfterSeconds`, `partialFilterExpression`) | Exact match excluding documented unsupported options |
| Content sampling | Randomly sample `0.1%–1%` of `_id` values from source, compute canonical SHA-256 on both sides | `0` mismatches |
| Boundary records | Compare first and last document ordered by `_id` per collection | Exact match |
| Application smoke | Run core read/write business flows | Pass |

### Reference Canonical Hash Sampling Script (`mongosh`)

Generate the sampled `_id` list **once** on the source database, save it, and query the exact
same `_id` list on both source and target to compare hashes:

```javascript
// Sort object keys recursively so field ordering differences do not cause false positives
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object" && !(v instanceof Date) && v.constructor === Object) {
    return Object.keys(v).sort().reduce((o, k) => ((o[k] = canon(v[k])), o), {});
  }
  return v;
}

const crypto = require("crypto");
const coll = db.getSiblingDB("<db-name>").getCollection("<collection-name>");

// Step A (source only): sample N _ids and save the list
const ids = coll
  .aggregate([{ $sample: { size: 1000 } }, { $project: { _id: 1 } }])
  .toArray()
  .map(d => d._id);

// Step B (run on both source and target using the same saved `ids` list)
ids.forEach(id => {
  const d = coll.findOne({ _id: id });
  print(
    EJSON.stringify(id),
    crypto.createHash("sha256").update(EJSON.stringify(canon(d))).digest("hex")
  );
});
```

## Rollback Plan

- **During the maintenance window:** The source MongoDB remains read-only and unmodified. If any
  verification step fails, switch application connection strings or DNS back to the source
  MongoDB and re-enable writes.
- **After cutover:** New writes committed to DocumentDB are **not automatically replicated back**
  to MongoDB.
  - Restrict or closely control critical writes during the initial acceptance window.
  - If rollback is required after cutover, evaluate and reconcile post-cutover writes manually.
  - Do **not** decommission or delete the source MongoDB until formal acceptance is complete.

## Risk Summary

1. **`collation` is unsupported** and is the most common migration blocker — audit it first.
2. Size maintenance windows from a **real 10–50 GB sample rehearsal**; treat ~16 hours for 1 TB
   as a lower bound.
3. Do not promise online/incremental sync (MongoShake) until a 1–10 GB pilot passes end-to-end.
4. Provision `>= 1.6x–2x` raw data size per PVC (`3x` total for 3-instance HA).
5. Ensure client drivers handle automatic reconnection for ~8-second primary failover windows.

## References

- [DocumentDB Kubernetes Operator](https://github.com/documentdb/documentdb-kubernetes-operator)
- [DocumentDB Kubernetes Operator Documentation](https://documentdb.io/documentdb-kubernetes-operator/)
- [DocumentDB Engine](https://github.com/documentdb/documentdb)
- [CloudNativePG Documentation](https://cloudnative-pg.io/documentation/)
- [cert-manager Documentation](https://cert-manager.io/docs/)
- [MongoDB Database Tools (`mongodump` / `mongorestore` / `mongofiles`)](https://www.mongodb.com/docs/database-tools/)
- [MongoShake](https://github.com/alibaba/MongoShake)

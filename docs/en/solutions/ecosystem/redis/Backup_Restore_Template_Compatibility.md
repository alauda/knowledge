---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
---

# Backup and Restore Compatibility With Parameter Templates

## Introduction

Alauda Cache Service for Redis OSS supports two backup destinations and three persistence parameter templates. The combinations do not all interoperate — in particular, restoring an RDB-only backup into an instance configured with the AOF template will not load any data, because Redis prefers AOF on startup when both are available.

This article describes the compatibility matrices and provides a manual workaround for the AOF restore case until the operator supports automatic format conversion.

## Backup Destinations

The platform supports two backup methods:

- **PVC-based backup.** Files are copied to a `PersistentVolumeClaim` and managed alongside the source instance.
- **S3-based backup.** Files are uploaded to an external S3-compatible object store managed by the platform Backup Center.

## Compatibility Matrices

### PVC Backup — Data Format by Redis Version and Template

| Redis version | RDB template | AOF template (5/6) | Diskless template (5/6) |
| --- | --- | --- | --- |
| 5.0 | RDB | RDB / AOF | RDB |
| 6.0 | RDB | RDB / AOF | RDB |
| 7.2 | RDB | RDB | RDB |

### S3 Backup — Data Format by Redis Version and Template

| Redis version | RDB template | AOF template (5/6) | Diskless template (5/6) |
| --- | --- | --- | --- |
| 5.0 | RDB | RDB | RDB |
| 6.0 | RDB | RDB | RDB |
| 7.2 | RDB | RDB | RDB |

:::note
S3 backups always store the dataset in **RDB** format regardless of which parameter template is in use on the source instance. PVC backups capture both files (RDB and AOF) when the AOF template is used on Redis 5.0 or 6.0.
:::

### How Redis Loads Data on Startup

Redis decides what to load based on the active configuration:

| Configuration | RDB | AOF |
| --- | :---: | :---: |
| `save` enabled (RDB only) | Loaded | — |
| `appendonly yes` (AOF only) | — | Loaded |
| Both `save` and `appendonly yes` | — | Loaded |
| Neither configured | Loaded | — |

The implication is that **when AOF is enabled, Redis loads the AOF file and ignores the RDB file**.

## The AOF Restore Problem

Combining the two tables above shows the problematic case:

> **Restoring an RDB-only backup into an instance configured with the AOF parameter template results in no data being loaded.**

This happens because:

1. The backup contains only `dump.rdb`.
2. The new instance starts with `appendonly yes`, so Redis looks for `appendonly.aof` and ignores the RDB file.
3. With no AOF file present, Redis starts with an empty dataset.

## Workaround

Until the operator supports automatic RDB-to-AOF conversion at restore time, use the following two-step procedure to restore an RDB backup into an AOF-enabled instance:

### 1. Create the Restore Instance With AOF Disabled

When you create the new Redis instance for the restore, override the parameter template to set `appendonly: "no"`. This allows Redis to load `dump.rdb` on startup.

For example, on a `RedisFailover` resource:

```yaml
spec:
  redis:
    customConfig:
      appendonly: "no"
    restore:
      backupName: <backup-name>
```

### 2. Wait for Ready, Then Re-Enable AOF

Once the instance reaches the `Ready` state and you have verified that the data has been loaded, switch `appendonly` back to `yes`.

```yaml
spec:
  redis:
    customConfig:
      appendonly: "yes"
```

When `appendonly` is toggled at runtime, Redis writes a fresh AOF file from the in-memory dataset without restarting the process. Once the AOF file is generated, durability returns to AOF behavior.

:::tip
Verify the data is loaded (using `DBSIZE` and a few sample keys) **before** flipping `appendonly` back to `yes`. After the switch, the in-memory dataset is what gets persisted into the new AOF file.
:::

## Important Considerations

- **Always treat RDB as the universal backup format.** Every backup destination supports RDB, so plan recovery procedures around RDB even when the source instance uses AOF.
- **No data loss during the toggle.** Switching `appendonly` from `no` to `yes` does not restart Redis and does not flush the dataset.
- **Plan downtime for AOF rewrite.** When AOF is re-enabled, Redis writes the entire dataset to disk. On large datasets this can briefly increase disk and CPU usage.
- **Future improvement.** A future release of the operator will perform format conversion automatically so this workaround will no longer be necessary.

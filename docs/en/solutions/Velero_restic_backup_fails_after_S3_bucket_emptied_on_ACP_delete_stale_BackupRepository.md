---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Velero restic backup fails after S3 bucket emptied on ACP — delete stale BackupRepository

## Issue

On Alauda Container Platform, Velero is delivered by the velero ModulePlugin (chart `ait/chart-velero` v4.1.0) and runs in the `cpaas-system` namespace with image `velero:v1.15.2-v4.1.0`, server flag `--uploader-type=restic`, and a node-agent DaemonSet using image `velero-node-agent:v1.15.2-v4.1.0` (one `node-agent-<hash>` pod per node). The restic uploader stores its on-disk repository as a tree of objects (`config`, `keys/`, `data/`, `index/`, `snapshots/`) inside the S3-compatible bucket bound by the `BackupStorageLocation`. After a backup for a given namespace has run at least once, a per-namespace `BackupRepository` (velero.io/v1) custom resource exists in `cpaas-system` recording the bucket prefix and the restic-compatible repository identifier Velero must reuse for that namespace.

The failure mode appears when the contents of the S3 bucket under that namespace's restic prefix are deleted out-of-band — for example through the object-storage console — while the `BackupRepository` CR is left in place. Because the CR still exists, Velero treats the on-disk restic repository as already initialized and skips the `restic init` step on the next backup run for that namespace. The subsequent PodVolumeBackup attempt then has no `config` object to open at the bucket prefix and aborts immediately.

## Root Cause

Velero records per-namespace repository state in a `BackupRepository` CR, not in the bucket. Once the CR is `Ready`, the controller path that initializes a fresh restic repository is short-circuited, and every following backup for that namespace assumes the bucket-side layout is intact. Emptying the bucket out-of-band breaks that assumption: the CR still advertises an initialized repository while the bucket no longer holds the `config` object restic needs to open the repo on the next write. The on-disk divergence between the CR and the bucket is what produces the failure.

On ACP's Velero v1.15.2-v4.1.0 build, the `backuprepositories.velero.io` CRD (at `apiVersion: velero.io/v1`) exposes the fields that drive this behavior. `spec.volumeNamespace` is the per-namespace handle, `spec.repositoryType` is the enum `{kopia, restic, ""}` (ACP Velero runs the `restic` branch), `spec.resticIdentifier` carries the full restic-compatible repository identifier (the `s3:…` handle that restic re-uses on every backup), and `spec.backupStorageLocation` binds the repo to its `BackupStorageLocation`. The status surface is `status.phase ∈ {New, Ready, NotReady}` and a free-form `status.message`; a `Ready` phase is the signal that the restic-init step has already happened and will be skipped on subsequent runs, while a `NotReady` phase carries the controller's diagnostic message.

## Resolution

Delete the stale `BackupRepository` CR for the affected namespace. On the next backup attempt for that namespace, Velero recreates the CR, re-runs the restic initialization against the now-empty bucket prefix, and PodVolumeBackup resumes succeeding.

List the per-namespace repository CRs in `cpaas-system` to identify the stale entry:

```bash
kubectl get backuprepository -n cpaas-system
```

Each entry's name encodes its target namespace and `BackupStorageLocation`; cross-reference `spec.volumeNamespace`, `spec.backupStorageLocation`, and `status.phase` to confirm the offending row:

```bash
kubectl get backuprepository -n cpaas-system <name> -o yaml
```

Delete the stale CR; Velero's controller will materialize a fresh one on the next backup run for that namespace and restic will re-initialize the on-disk repository:

```bash
kubectl delete backuprepository -n cpaas-system <name>
```

Re-run (or wait for the schedule to re-trigger) the backup for the affected namespace and confirm the new `BackupRepository` reaches `status.phase: Ready`.

## Diagnostic Steps

The PodVolumeBackup failure surfaces in the node-agent (restic DaemonSet) pod log in `cpaas-system`. The relevant pod is one of the `node-agent-<hash>` replicas — there is one such pod per node, all running the `velero-node-agent:v1.15.2-v4.1.0` image — and the failing line is a `data path backup failed` error whose embedded stderr carries a restic fatal of the form `unable to open config file: Stat: The specified key does not exist. Is there a repository at the following location?` (the standard upstream restic message when the on-disk `config` object is absent, surfaced by the same restic binary ACP ships).

Tail the node-agent logs in `cpaas-system` to locate the failure:

```bash
kubectl logs -n cpaas-system -l name=node-agent --tail=200
```

Once the failing namespace is known, list the repository CRs and select the stale entry by `spec.volumeNamespace`:

```bash
kubectl get backuprepository -n cpaas-system -o wide
```

The pre-v1.10 CRD form is absent on ACP — `kubectl get crd resticrepositories.velero.io` returns `NotFound` because the CRD was renamed upstream to `backuprepositories.velero.io`; use the `backuprepository` form exclusively.

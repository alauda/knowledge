---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Restic Backup Fails After the S3 Bucket Is Emptied — Delete the Stale `ResticRepository` CR
## Issue

A Velero-backed Restic backup flow that was previously working starts failing on every attempt after the underlying S3 / object-storage bucket is manually emptied (accidental `s3 rm`, bucket re-provision, disaster-recovery test, etc.). The backup's node-agent pod logs a Restic-level refusal:

```text
level=error msg="pod volume backup failed:
  data path backup failed: error running restic backup command
  restic backup --repo=s3:https://<bucket> --password-file=<...>
  ...
  with error: exit status 1
  stderr: Fatal: unable to open config file: Stat: The specified key does not exist.
    Is there a repository at the following location?
    s3:https//<bucket>
"
```

Creating a fresh `Backup` CR or re-running the schedule does not help — Restic insists the repository it expects is missing from the bucket. Velero keeps pointing Restic at a repository Velero still thinks exists but the bucket no longer holds.

## Root Cause

Velero tracks each Restic repository as a `ResticRepository` custom resource in the cluster. The object records the repository's URL, its current state, and its initialisation status. When a backup pipeline runs:

1. The namespace has a `ResticRepository` CR pointing at the bucket path.
2. Velero sees the CR and treats the repository as initialised — it does not try to create one, because the CR says one exists.
3. The CR's state is "initialised" even though the bucket's actual contents have been emptied externally.
4. Restic tries to open the repository in the bucket, finds no `config` file (the bucket is empty), and aborts with `Stat: The specified key does not exist`.

The cluster-side view of the world (the CR) and the storage-side view (the bucket) are out of sync. Velero's reconcile does not detect that drift and does not attempt to re-initialise.

The fix is to delete the stale CR so Velero re-initialises the repository on the next backup run — at which point Restic writes a fresh `config` into the empty bucket and the pipeline resumes.

## Resolution

### Delete the stale `ResticRepository` CR

Find the CR for the affected namespace / backup:

```bash
NS=<backup-operator-ns>    # typically the OADP/Velero operator's namespace
kubectl -n "$NS" get resticrepository
```

Each row is a ResticRepository object, named with a hash of `<target-ns>-<bucket>-...`. Identify the one that points at the emptied bucket — the `spec.backupStorageLocation` or `spec.resticIdentifier` field disambiguates it:

```bash
kubectl -n "$NS" get resticrepository <name> -o jsonpath='{.spec}{"\n"}' | jq
```

Delete it:

```bash
kubectl -n "$NS" delete resticrepository <name>
```

On the next backup run (scheduled or manually triggered), Velero notices no matching `ResticRepository` exists, creates a new one, and tells Restic to initialise a fresh repository in the bucket. Restic writes the `config` file, builds the repository structure, and the backup proceeds.

### Trigger a fresh backup to verify

Force a backup rather than waiting for the next scheduled fire:

```bash
cat <<EOF | kubectl apply -f -
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: verify-after-restic-reset-$(date +%s)
  namespace: $NS
spec:
  includedNamespaces:
    - <target-ns>
  defaultVolumesToRestic: true
  ttl: 24h0m0s
EOF

kubectl -n "$NS" get backup -w
```

Watch the new backup transition from `InProgress` to `Completed`. If it reaches `Completed` without the `Stat: The specified key does not exist` error, the reset worked.

### When deleting the CR is not enough

If the CR delete does not auto-reinitialise (Velero does not create a replacement on the next backup), inspect the backup storage location:

```bash
kubectl -n "$NS" get backupstoragelocation -o \
  custom-columns='NAME:.metadata.name,PHASE:.status.phase,LAST_VALIDATED:.status.lastValidationTime'
```

`PHASE: Available` is required for Velero to use the location. An `Unavailable` state (typically due to credentials or bucket policy drift) means Velero will not attempt new repositories against it. Fix the BSL first — rotate credentials, re-upload the bucket's required policy, etc. — then retry.

### Prevent recurrence

Emptying the bucket externally is the triggering action. Two preventive postures:

- **Label the bucket as immutable for the retention window.** Most object storage services support object-lock or immutability policies that prevent accidental deletion. Apply one to the backup bucket.
- **Treat the bucket as cluster-managed.** Avoid out-of-band manipulation of the bucket contents; use Velero's own retention / `BackupStorageLocation` flows to clean up expired backups. When the cluster CR and the bucket are both managed through Velero, drift cannot arise.

## Diagnostic Steps

Confirm the failure signature on the node-agent / restic pod:

```bash
kubectl -n "$NS" logs -l name=node-agent --tail=200 | grep -iE 'restic.*fatal|unable to open config file' | head -5
```

The `unable to open config file` message is the unique signature.

Check the `ResticRepository` state:

```bash
kubectl -n "$NS" get resticrepository -o \
  custom-columns='NAME:.metadata.name,PHASE:.status.phase,STORE:.spec.backupStorageLocation'
```

`PHASE: Ready` on a CR pointing at a bucket that is in fact empty is the mismatch to correct.

Inspect the bucket's contents to verify it actually lacks the Restic repository structure:

```bash
# Using the AWS CLI against an S3-compatible endpoint.
aws --endpoint-url <s3-endpoint> s3 ls s3://<bucket>/<repo-path>/ 2>/dev/null
```

A Restic repository's root contains at minimum `config`, `keys/`, `snapshots/`, `data/`. If the bucket is empty, the CR delete + backup retry path above is correct.

After recovery, the bucket carries a fresh repository structure:

```bash
aws --endpoint-url <s3-endpoint> s3 ls s3://<bucket>/<repo-path>/
# config
# index/
# keys/
# ...
```

And Velero's next scheduled backup succeeds. The ResticRepository CR re-appears in `Ready` state, with `spec.resticIdentifier` pointing at the freshly initialised bucket.

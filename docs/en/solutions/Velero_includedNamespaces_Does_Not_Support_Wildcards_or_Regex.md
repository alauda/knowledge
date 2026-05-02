---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Velero includedNamespaces Does Not Support Wildcards or Regex

## Issue

A backup or restore on the ACP backup surface (`configure/backup`, which packages the upstream Velero project) is declared with a glob pattern in `spec.includedNamespaces`:

```yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: backup-test
  namespace: cluster-backup
spec:
  includedNamespaces:
    - "*test"
```

The expectation is that Velero will expand the pattern into every namespace whose name ends in `test` and back each of them up. What happens instead is that Velero treats the string `*test` as a literal namespace name. Since no namespace is literally called `*test`, the backup records the namespace selector as-is in its metadata but never finds any workload objects to capture. The backup file completes with near-empty content — the namespace definitions for any accidentally-matching namespace may be written, but none of the resources inside are.

The Velero log for this case shows the pattern stored verbatim, with the per-resource enumeration then running against that impossible name:

```text
level=info msg="Including namespaces: *test"
level=info msg="Excluding namespaces: "
level=info msg="Including resources: *"
level=info msg="Listing items" backup=cluster-backup/backup-test \
    namespace="*test" resource=persistentvolumeclaims
```

The result: "`Including namespaces: *test`" is stored literally, the resource enumeration asks the API for items in namespace `*test`, and the API returns none.

## Root Cause

Velero's `includedNamespaces` field (and the symmetric `excludedNamespaces` field, and their `Restore` counterparts) expects a **list of exact namespace names**. The only wildcard Velero recognises is the single character `*` alone, which means "every namespace" and is valid only as the sole entry in the list. Any other string — `*test`, `test-*`, `/test-.*/` — is compared against each namespace name with string equality and will not match.

This is a long-standing design choice in Velero, not a defect in the ACP packaging. The upstream documentation calls it out directly: *"Namespaces that are included/excluded must be listed individually; wildcards and regular expressions are not supported."*

The output field `spec.resources` (what kinds of objects to include) supports the single `*` alone in the same way, but otherwise takes explicit GVK lists. The same "no regex" rule applies.

## Resolution

Enumerate the target namespaces explicitly, either by listing them in the CR or by generating the list at create-time from a label selector.

### Option A — list the namespaces explicitly

Replace the glob with the actual names:

```yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: backup-test
  namespace: cluster-backup
spec:
  includedNamespaces:
    - app-test
    - billing-test
    - frontend-test
  ttl: 720h
  storageLocation: default
```

This is the simplest fix and the only one that survives upstream without any Velero-side change.

### Option B — use a label selector on namespaces

Velero honours `labelSelector` on the Backup CR and applies it to **all objects** in the included namespaces, which is almost always not what was intended (it would also filter out unlabelled ConfigMaps and Deployments). For namespace-level filtering, prefer labelling the namespaces and generating the list at the driver:

```bash
NAMESPACES=$(kubectl get ns -l backup-set=nightly \
             -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' \
             | paste -sd, -)

cat <<EOF | kubectl -n cluster-backup apply -f -
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: backup-$(date -u +%Y%m%d%H%M)
  namespace: cluster-backup
spec:
  includedNamespaces:
$(for n in $(kubectl get ns -l backup-set=nightly -o jsonpath='{.items[*].metadata.name}'); do
    echo "    - $n"
  done)
  ttl: 720h
  storageLocation: default
EOF
```

The backup is then declarative on namespace label membership at the time the CR is created. Adding a new namespace to the set for future backups is a labelling operation; no code change or CR edit.

### Option C — the literal `*` for "everything"

When the intent really is "back up every namespace in the cluster", use the single-entry form:

```yaml
spec:
  includedNamespaces:
    - "*"
```

Pair it with `excludedNamespaces` to carve out kube-system-level namespaces that do not round-trip through a restore anyway:

```yaml
spec:
  includedNamespaces:
    - "*"
  excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    - cluster-backup
```

### Option D — schedule-level namespace templating

`Schedule` CRs generate Backups on a cron, and the template can be regenerated periodically by a controller or a small CronJob that re-reads the namespace label selector and rewrites the Schedule's template. This keeps the expanded namespace list fresh without pre-computing it at each backup.

## Diagnostic Steps

Confirm what Velero actually recorded as the namespace selector on the failing backup:

```bash
kubectl -n cluster-backup get backup backup-test \
  -o jsonpath='{.spec.includedNamespaces}{"\n"}'
```

A literal string containing `*` on anything other than the sole-entry `*` form is the smoking gun.

Inspect the backup's own log for what it enumerated. Velero writes a log file alongside the backup metadata in object storage; fetch it and grep for the namespace line:

```bash
kubectl -n cluster-backup logs deploy/velero | \
  grep 'Including namespaces' | tail -10
```

Each line should be a comma-separated list of real namespace names — never a line ending in `*suffix` or `prefix*`.

Verify the resource counts on the finished backup:

```bash
kubectl -n cluster-backup get backup backup-test -o jsonpath='{.status}{"\n"}' | jq
```

The `progress` block lists `totalItems` and `itemsBackedUp`. A backup that declared three glob-selected namespaces and reports `itemsBackedUp: 0` for anything except `namespaces` itself has hit exactly this issue and needs to be re-run with the explicit-name form.

When rewriting an existing `Schedule` that used a glob, also re-check any `Restore` CRs that might have been pre-authored against the same glob — the restore side is equally literal and will find nothing to restore:

```bash
kubectl -n cluster-backup get restore -o yaml \
  | grep -A1 includedNamespaces
```

Replace every `"*<something>"` or `"<something>*"` pattern with the explicit list the backup was supposed to cover.
</content>
</invoke>
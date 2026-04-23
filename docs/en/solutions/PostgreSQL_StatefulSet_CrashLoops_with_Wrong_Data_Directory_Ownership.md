---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A PostgreSQL pod that runs as part of a managed service (object-storage metadata, operator internal state, audit DB) enters `CrashLoopBackOff` after a restore, PVC remount, or pod reschedule. The container log fails early:

```text
FATAL: data directory "/var/lib/pgsql/data/userdata" has wrong ownership
HINT:  The server must be started by the user that owns the data directory.
```

The PVC still holds the correct data — nothing is lost — but the pod cannot reach `ready` because the in-container user and the on-disk ownership disagree.

## Root Cause

PostgreSQL refuses to start when the UID that owns its data directory differs from the UID the server process runs as. Two common ways this gets out of sync:

- **Credential Secret was rotated without updating on-disk ownership**. The operator that manages the DB reads a Secret such as `<db>-credentials` to derive the container's `postgres` user; when that Secret is regenerated with a new username, the running container picks up the new UID but the PVC's data directory is still owned by the previous one.
- **Restore or node move left stale ownership**. Backups restored with a different storage class (CSI driver A → driver B) or an `fsGroup` change on the StatefulSet can swap the directory owner without touching Postgres's expectation.

Either way, the data is intact — only the owner metadata is wrong.

## Resolution

Pick whichever side is correct: the on-disk ownership is what the data *actually* has; the Secret is what the container *thinks* the user is. Reconcile by changing the one that's behind.

### Option A — Fix the on-disk ownership to match the container user

This is the right option when the Secret is authoritative (operator-driven rotation was intentional).

1. **Discover the container's expected user**. For the NooBaa-style deployment in ACP object storage, the user lives in the credentials Secret:

   ```bash
   NS=<storage-namespace>              # e.g. cpaas-system or the operator's own namespace
   SECRET=<db-credentials-secret>
   EXPECTED_USER=$(kubectl -n "$NS" get secret "$SECRET" -o jsonpath='{.data.user}' | base64 -d)
   echo "expected user: $EXPECTED_USER"
   ```

2. **Chown the data directory inside the pod's filesystem**. Use a debug session so the PVC is mounted but Postgres isn't trying to start:

   ```bash
   kubectl debug node/<pod's-node> -it \
     --image=registry.alauda.cn:60070/tkestack/pause:3.10 \
     -- chroot /host sh -c '
        # Find the kubelet subPath for the PVC
        find /var/lib/kubelet/pods -path "*/volumes/*noobaa-db-storage*" -type d -name "mount" | head -1
     '
   ```

   In most clusters it's faster to start an ephemeral container attached to the pod:

   ```bash
   kubectl -n "$NS" debug <db-pod> --image=alpine --target=<main-container> -- \
     sh -c 'chown -R postgres:postgres /var/lib/pgsql/data/userdata && ls -ld /var/lib/pgsql/data/userdata'
   ```

3. **Delete the StatefulSet pod** so it reconciles onto the freshly-owned directory:

   ```bash
   kubectl -n "$NS" delete pod <db-pod>
   ```

### Option B — Fix the Secret to match what's on disk

This is the right option when the data directory's ownership is authoritative (post-restore, post-migration).

1. **Read the on-disk owner**:

   ```bash
   kubectl -n "$NS" debug <db-pod> --image=alpine --target=<main-container> -- \
     ls -ld /var/lib/pgsql/data/userdata
   # drwx------    1 54321    54321         4096 Mar 10 09:00 /var/lib/pgsql/data/userdata
   ```

   Convert that numeric UID (or username) to the string form the Secret uses. For systems that store the user as a text name in the Secret, use `getent passwd <uid>` inside the container to find the name; if the image has no such user, pick the string the operator expects (check the operator's reconciliation code or its reconciled `Deployment`/`StatefulSet` `env:`).

2. **Patch the Secret**:

   ```bash
   NEW_USER=<actual-on-disk-owner>
   kubectl -n "$NS" patch secret "$SECRET" --type merge \
     -p "{\"stringData\":{\"user\":\"$NEW_USER\"}}"
   ```

3. **Restart the pod**:

   ```bash
   kubectl -n "$NS" delete pod <db-pod>
   ```

### Guardrails

- Operator-managed workloads: the operator may overwrite your change on reconcile. Always fix the side the operator considers authoritative (for most DB operators, that's the Secret).
- Never chown under a running Postgres — even a stopped container in CrashLoop is safer than a Postgres that's mid-startup when ownership flips.
- Backups: snapshot the PVC (if the CSI driver supports it) before either change. A wrong chown on a StatefulSet data directory is easy to reverse; a wrong Secret change that then triggers an automated re-init is not.

## Diagnostic Steps

Confirm the pod's error matches this failure mode:

```bash
kubectl -n <storage-namespace> logs <db-pod> --previous \
  | grep -E 'data directory.*wrong ownership|FATAL|HINT'
```

Read both sides explicitly and compare:

```bash
# Container-expected user
kubectl -n <storage-namespace> get secret <db-credentials> \
  -o jsonpath='{.data.user}' | base64 -d ; echo

# Actual on-disk owner
kubectl -n <storage-namespace> debug <db-pod> --image=alpine --target=<main> -- \
  ls -ld /var/lib/pgsql/data/userdata
```

If the two strings/UIDs disagree, apply Option A or Option B accordingly. If they agree and the pod still fails, the error is in a different field — usually Postgres complaining about `pg_hba.conf`, WAL corruption, or a locked-out superuser; follow the specific log line rather than assuming ownership.

After restart, the pod should reach `Running` and `Ready` within one reconcile cycle (~30s). If the pod goes back into CrashLoop, the operator likely reverted your change — validate that the operator now considers the two sides consistent before the next reconcile window.

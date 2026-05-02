---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500016
---

# Automating etcd Snapshot Backups on the Control Plane

## Overview

etcd is the source of truth for every Kubernetes object. Losing it — through disk corruption, simultaneous node failure, or accidental delete — without a recent backup is a full cluster rebuild. Automating a regular on-host snapshot is the cheapest and most effective disaster-recovery primitive the platform can maintain.

The preferred mechanism on ACP is the platform's own backup surface under `configure/backup`, which orchestrates snapshots, applies retention, and stores them off-cluster. When platform-managed backup is not available (early bring-up, air-gapped labs, or when an operator wants an additional local copy), a least-privilege CronJob calling `etcdctl snapshot` on each control-plane node is a reasonable fallback.

## Resolution

### Preferred: Platform-Managed Backup

Use ACP's configure/backup page to enable control-plane backups for the cluster. Choose a schedule, a retention window, and a target storage location (S3-compatible object store is a common choice). The platform handles:

- consistent invocation on **every** control-plane node, not just the first one a script happens to pick,
- credential management for the target store,
- retention / garbage collection,
- integration with restore tooling (which is the half of DR that people often forget to validate).

A platform-managed backup removes the need for privileged pods in user namespaces; prefer it whenever it is available.

### Fallback: Scheduled Snapshot Job

If the platform surface is not yet enabled, run a CronJob that calls `etcdctl snapshot save` on each control-plane node. Keep permissions tight: the Job needs to read etcd TLS material and write to a well-known directory on each control-plane node, and nothing else.

1. **Create a dedicated namespace and ServiceAccount.**

   ```bash
   kubectl create namespace etcd-backup
   kubectl -n etcd-backup create serviceaccount etcd-backup
   ```

2. **Grant only the cluster-wide reads the Job needs.** Node access is required to enumerate control-plane nodes; `pods/exec` on `kube-system` is required to issue `etcdctl snapshot`. Avoid any privilege that is not listed.

   ```yaml
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRole
   metadata:
     name: etcd-backup
   rules:
     - apiGroups: [""]
       resources: ["nodes"]
       verbs: ["get", "list"]
     - apiGroups: [""]
       resources: ["pods"]
       verbs: ["get", "list"]
     - apiGroups: [""]
       resources: ["pods/exec"]
       verbs: ["create"]
   ---
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRoleBinding
   metadata:
     name: etcd-backup
   subjects:
     - kind: ServiceAccount
       name: etcd-backup
       namespace: etcd-backup
   roleRef:
     apiGroup: rbac.authorization.k8s.io
     kind: ClusterRole
     name: etcd-backup
   ```

3. **Schedule the snapshot.** The Job below runs once a day, iterates over each control-plane pod, takes a snapshot inside the etcd container, and deletes snapshots older than 7 days. Adjust the schedule and retention to your RPO target.

   ```yaml
   apiVersion: batch/v1
   kind: CronJob
   metadata:
     name: etcd-snapshot
     namespace: etcd-backup
   spec:
     schedule: "7 3 * * *"                 # 03:07 UTC daily
     concurrencyPolicy: Forbid
     successfulJobsHistoryLimit: 3
     failedJobsHistoryLimit: 5
     jobTemplate:
       spec:
         backoffLimit: 0
         ttlSecondsAfterFinished: 3600
         template:
           spec:
             serviceAccountName: etcd-backup
             restartPolicy: Never
             containers:
               - name: snapshot
                 image: bitnami/kubectl:1.33
                 command:
                   - /bin/bash
                   - -ec
                   - |
                     set -o pipefail
                     for pod in $(kubectl -n kube-system get pod \
                         -l component=etcd \
                         -o jsonpath='{.items[*].metadata.name}'); do
                       dest="/var/lib/etcd/backup/snapshot-$(date -u +%Y%m%dT%H%M%SZ).db"
                       echo "===== $pod -> $dest"
                       kubectl -n kube-system exec "$pod" -c etcd -- sh -c "
                         mkdir -p \$(dirname $dest) &&
                         ETCDCTL_API=3 etcdctl \
                           --endpoints=https://127.0.0.1:2379 \
                           --cacert=/etc/kubernetes/pki/etcd/ca.crt \
                           --cert=/etc/kubernetes/pki/etcd/server.crt \
                           --key=/etc/kubernetes/pki/etcd/server.key \
                           snapshot save $dest &&
                         find \$(dirname $dest) -name 'snapshot-*.db' -mtime +7 -delete
                       "
                     done
   ```

4. **Ship snapshots off-cluster.** A snapshot that only lives on the control-plane node does not survive the failure mode it was meant to cover. Pair the CronJob with a sidecar or separate Job that uploads new `snapshot-*.db` files to an object store your restore tooling can reach — `rclone`, `aws s3 cp`, or an init-container that mounts a node-local path and streams to a bucket.

5. **Restore drills.** A backup whose restore has never been exercised is guesswork. Restore into a disposable test cluster quarterly and document the runbook. The exact restore procedure is platform-specific (it rebuilds the etcd static pod from the snapshot); reach for the platform's DR documentation rather than improvising under pressure.

## Diagnostic Steps

Confirm the CronJob ran and left artefacts on the expected nodes:

```bash
kubectl -n etcd-backup get jobs --sort-by=.status.startTime | tail -n 10
kubectl -n etcd-backup logs job/$(kubectl -n etcd-backup get job -o jsonpath='{.items[-1].metadata.name}')
```

Inspect a control-plane node for snapshot files:

```bash
NODE=<control-plane-1>
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host ls -lh /var/lib/etcd/backup/ 2>/dev/null
```

Sanity-check the snapshot's integrity before relying on it:

```bash
kubectl -n kube-system exec etcd-<host> -c etcd -- \
  sh -c 'ETCDCTL_API=3 etcdctl snapshot status \
           /var/lib/etcd/backup/<file.db> -w table'
```

Expected output lists the snapshot hash, total keys, and total size — an empty or truncated snapshot usually fails the status command outright. If `snapshot save` returns `context deadline exceeded`, raise the command timeout via `--dial-timeout` and `--command-timeout`; a healthy etcd should complete a snapshot in well under a minute even on clusters with several GB of data.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A LokiStack deployment's compactor pod's PVC climbs toward full (90+%) over time. Cleanup cycles run — the compactor logs report retention being applied successfully — but the free space on the PVC does not recover. Eventually the compactor starts logging `no space left on device` errors and stops making progress on retention:

```text
level=error caller=compactor.go:571
  msg="failed to apply retention"
  err="write /tmp/loki/…: no space left on device"
```

The surprise in the diagnosis is the mismatch between `du` and `df`:

```text
$ df -h /tmp/loki
Filesystem      Size  Used Avail Use% Mounted on
/dev/sdc        9.8G  9.6G  236M  98% /tmp/loki

$ du -sch /tmp/loki/*
 56K    compactor
 16K    lost+found
 72K    total
```

`du` reports only kilobytes of actual visible content, but `df` reports gigabytes in use. The filesystem is being consumed by something invisible to directory walks.

## Root Cause

The compactor unlinks temporary index files during compaction but the process keeps open file descriptors to those files. On Linux, a file that has been deleted but is still held open by a process stays allocated on disk until every descriptor closes — the inode disappears from the directory tree (so `du`'s walk does not see it), but the blocks remain occupied (so `df` reports them as used).

The compactor's handling of its working-directory files has a bug in some Loki / LokiStack operator versions: after compaction finishes, the compactor unlinks the temporary intermediate files but does not close all of their descriptors. Over many compaction cycles, the unlinked-but-held set accumulates, and space on the PVC leaks away.

The definitive evidence is `lsof` showing entries with `DEL` status for files under `/tmp/loki`:

```text
loki  24xxxx  DEL -W REG /tmp/loki/compactor/index_20367/compactor-17xxxxxxxx
loki  24xxxx  DEL -W REG /tmp/loki/compactor/index_20393/compactor-17xxxxxxxx
```

`DEL` means the file has been unlinked but the process still holds a descriptor to it. The only way to reclaim the space without a code-level fix is to close those descriptors — which means restarting the process.

## Resolution

### Preferred — upgrade the LokiStack / Loki operator

The durable fix is a build that closes the descriptors after each compaction cycle. Upgrade the LokiStack operator to a release that carries the fix. After the upgrade's pods reconcile, the compactor's steady-state `df` should stay close to the `du` total — unlinked-open accumulation is no longer occurring.

Verify after the upgrade by running the `lsof | grep DEL` check a day or two into the new build's operation:

```bash
POD=$(kubectl -n cluster-logging get pod -l app.kubernetes.io/component=compactor \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n cluster-logging exec -it "$POD" -- sh -c 'lsof +D /tmp/loki 2>/dev/null | grep -c DEL'
```

A count of zero (or very small, transient single-digit) is healthy. Counts in the dozens or higher on an upgraded build suggest the fix has not taken effect and should be reported.

### Workaround — schedule a periodic compactor restart

Until the fix lands, restart the compactor pod on a schedule. Each restart forces all file descriptors to close, the kernel reclaims the deleted files' blocks, and the PVC's free space returns to what `du` reports.

A simple CronJob in the same namespace does the restart:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: loki-compactor-restart
  namespace: cluster-logging
spec:
  schedule: "0 */6 * * *"                        # every 6 hours
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: loki-compactor-restarter
          restartPolicy: OnFailure
          containers:
            - name: kubectl
              image: bitnami/kubectl:latest
              command: ["sh","-c"]
              args:
                - |
                  kubectl -n cluster-logging delete pod \
                    -l app.kubernetes.io/component=compactor \
                    --wait=false
```

The ServiceAccount needs permission to delete pods in the LokiStack namespace:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: loki-compactor-restarter
  namespace: cluster-logging
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: compactor-pod-restarter
  namespace: cluster-logging
rules:
  - apiGroups: [""]
    resources: [pods]
    verbs: [list, delete]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: compactor-pod-restarter-binding
  namespace: cluster-logging
subjects:
  - kind: ServiceAccount
    name: loki-compactor-restarter
    namespace: cluster-logging
roleRef:
  kind: Role
  name: compactor-pod-restarter
  apiGroup: rbac.authorization.k8s.io
```

### Pick an interval matched to the growth rate

`df` on the compactor's PVC grows by roughly the amount of data compacted per cycle. For a low-volume cluster that compacts 100 MiB per cycle and runs a cycle every 10 minutes, a 6-hour restart covers ~3.6 GiB of growth — safe for a 10 GiB PVC. For a high-volume cluster (several GiB per cycle, frequent cycles), tighten to every hour or two, or raise the PVC size. Monitor and adjust.

### Do not

- Do not force-close the descriptors by sending signals to the compactor process — the process responds to signals in ways that can corrupt in-flight index state. Use pod deletion / restart as the intervention.
- Do not rely on manually running `find -delete` inside the pod — the files are already unlinked; the issue is the open descriptors, not the directory entries.
- Do not blindly raise PVC size without the restart schedule — growth is bounded only by a restart (or the fix), so a larger PVC just delays the same failure.

## Diagnostic Steps

Confirm the `df`/`du` mismatch on the compactor pod:

```bash
POD=$(kubectl -n cluster-logging get pod -l app.kubernetes.io/component=compactor \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n cluster-logging exec -it "$POD" -- sh -c '
  df -h /tmp/loki
  echo ---
  du -sch /tmp/loki/* 2>/dev/null
'
```

A large `df`-`du` gap (gigabytes of used space against kilobytes of visible content) is the definitive marker.

Enumerate the unlinked-but-open files:

```bash
kubectl -n cluster-logging exec -it "$POD" -- sh -c '
  apk add --no-cache lsof 2>/dev/null || \
    (lsof --help >/dev/null 2>&1) || \
    (command -v lsof >/dev/null || echo "lsof not available; skip")
  lsof +D /tmp/loki 2>/dev/null | grep DEL | head -20
'
```

(If `lsof` is not available in the compactor image, you can read `/proc/<pid>/maps` for the leaked mappings or rely on the `df`/`du` gap alone.) Rows with `DEL` are the leaked files; the count and total size approximate the leak.

Verify the workaround takes effect on the first restart:

```bash
# Before restart.
kubectl -n cluster-logging exec "$POD" -- df -h /tmp/loki

kubectl -n cluster-logging delete pod "$POD"
# Wait for the new pod to come up.
kubectl -n cluster-logging wait --for=condition=Ready pod -l app.kubernetes.io/component=compactor --timeout=120s

POD_NEW=$(kubectl -n cluster-logging get pod -l app.kubernetes.io/component=compactor \
            -o jsonpath='{.items[0].metadata.name}')
kubectl -n cluster-logging exec "$POD_NEW" -- df -h /tmp/loki
```

The second `df` should show substantially more free space. If it does not, the issue is not the unlinked-open leak — investigate whether the PVC's actual visible content has grown (retention misconfigured, bucket problems, etc.).

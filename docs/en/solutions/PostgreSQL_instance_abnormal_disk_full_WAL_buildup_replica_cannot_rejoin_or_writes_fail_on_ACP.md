---
kind:
  - Troubleshooting
products:
  - Alauda Application Services
ProductsVersion:
  - "3.18"
  - "4.1"
  - "4.3"
---

# PostgreSQL instance abnormal: disk full, WAL buildup, replica cannot rejoin, or writes fail on ACP

## Issue

A Data Services PostgreSQL instance is reported abnormal. The custom resource is `postgresql` (`acid.zalan.do/v1`), and the members are Patroni-managed Pods `<cluster>-0` and `<cluster>-1`. One of these is visible:

- The PostgreSQL log says the disk is full: `OSError: [Errno 28] No space left on device: '/home/postgres/pgdata/pgroot/data/recovery.conf'`, followed by `WARNING: Postgresql is not running.` (Cause 1)
- The primary cannot serve requests and its data volume is full of WAL; storage dashboards can show the nodes at 99% disk usage although the business data is only megabytes (Cause 2).
- One member Pod is `0/1 Running` while the other is `1/1`, and `patronictl list` shows that member as `Replica` in state `starting`, with an empty `TL` and `Lag in MB` of `unknown`, while the other member is the running `Leader`. It looks like split-brain (Cause 3).
- Containers of the instance do not start, with `SMT Alignment Error: requested 1 cpus not multiple cpus per core = 2` (Cause 4).
- SQL statements fail and the application cannot write data (Cause 5).
- After its host node hung and was rebooted, one replica does not start while the primary runs normally; its log shows that `pg_controldata` failed and `/home/postgres/pgdata/pgroot/data/global/pg_control` could not be read (Cause 6).
- A replica is `stopped` in `patronictl list` and its log repeats `data dir for the cluster is not empty, but system ID is invalid; consider doing reinitialize`. Data Services can show the instance as `Error` while its Pods are `Running`, or the upgrade checklist reports PostgreSQL abnormal (Cause 7).

## Root Cause

### Cause 1: The data volume is full

The PV that backs the PostgreSQL data directory has no free space. The `postgres` container of the member logs:

```text
INFO: Lock owner: None; I am <cluster>-1
INFO: starting as a secondary
ERROR: Exception during execution of long running task restarting after failure
...
  in write_recovery_conf
OSError: [Errno 28] No space left on device: '/home/postgres/pgdata/pgroot/data/recovery.conf'
WARNING: Postgresql is not running.
```

followed by `Database cluster state: shutting down`. Inside the Pod, `df -h` shows the data volume on `/home/postgres/pgdata` at 100% (for example Size `25G`, Used `25G`, Avail `104K`), while `sv status` still lists `cron`, `patroni`, and `pgqd` as `run`. Patroni cannot write `recovery.conf`, so PostgreSQL on that member does not start. Expand the PV, or delete data that is no longer needed. If the space is taken by WAL rather than by tables, see Cause 2.

### Cause 2: WAL fills the primary because replication has been broken for a long time

When primary-replica replication fails for a long time, the primary keeps every WAL segment the replica has not received. The WAL fills the primary's disk and the primary can no longer serve. Slow disks make it worse, because the replica falls behind faster than it can replay. Recovery: expand the primary PVC, rebuild the replica, and let the primary drop the old WAL once the rebuilt replica is streaming.

On TopoLVM storage, the reported disk usage is the capacity already allocated to volumes, not what the data inside them uses. Cleaning other data (for example Elasticsearch indices) does not lower that figure.

### Cause 3: Replica stays starting with Lag unknown after the WAL it needs is lost

`patronictl list` shows the replica `starting` with no timeline and `Lag in MB` `unknown`, and the leader `running` on its timeline. The WAL the replica needs to catch up is no longer available (for example the WAL archive was lost), so it cannot heal on its own. `patronictl reinit` of that member from the leader recovers it.

### Cause 4: SMT Alignment Error: requested 1 cpus not multiple cpus per core = 2

The nodes have NUMA enabled, and the kubelet CPU Manager and Topology Manager policies require SMT alignment. Under that policy an exclusive CPU request must be a multiple of the CPUs per physical core (2 on these nodes). The PostgreSQL container requests 1 CPU, and the kubelet rejects it at start. Setting the CPU resources to an even value fixes it. The rule applies to any Data Services Pod scheduled on those nodes; see the ACP 4.3 documentation on CPU Manager and Topology Manager policies.

### Cause 5: SQL writes fail because the primary/standby switchover is stuck

SQL statements against the instance fail and no data can be written because a primary/standby switchover is stuck. Restarting the PostgreSQL Pod of the instance restores writes. What leaves the switchover stuck has not been identified.

### Cause 6: Replica cannot start because global/pg_control cannot be read after a node crash

The host node became unresponsive (for example because of an operating system kernel bug). After the node was fixed and rebooted, the primary ran normally and the replica did not. The replica's log shows `pg_controldata` failing because `global/pg_control` cannot be read: the control file of that member was damaged by the crash. Resynchronizing the replica from the primary, by deleting the replica's PVC and Pod, returns it to normal.

### Cause 7: Replica stopped with "data dir for the cluster is not empty, but system ID is invalid"

The replica's `postgres` container repeats `INFO: data dir for the cluster is not empty, but system ID is invalid; consider doing reinitialize`. `patronictl list` shows it as `Replica`, state `stopped`, `Lag in MB` `unknown`, while the leader is `running` and logs `no action. I am (<cluster>-0), the leader with the lock`. Patroni does not start PostgreSQL on a non-empty data directory whose system identifier it cannot read, so the replica never rejoins. The instance page can show `could not sync statefulsets: could not recreate pods: skipping switchover: no switchover candidate found`. Bootstrap lines such as `chmod: changing permissions of '/var/log/pg_log': Operation not permitted` and `Disabling 'bypass_api_service'` are not related.

`patronictl reinit` of the replica can return `Success` while the member stays in `creating replica` with Lag `unknown`. Scaling the instance from 2 members to 1 and back to 2, which recreates the replica from the leader, restores the cluster.

## Resolution

### Cause 1: The data volume is full

```bash
kubectl get pvc -n <namespace>
kubectl exec -n <namespace> <cluster>-0 -c postgres -- df -h /home/postgres/pgdata
kubectl get sc <storage-class> -o jsonpath='{.allowVolumeExpansion}{"\n"}'
```

> **Warning:** A PVC can be expanded but never shrunk. Precondition: `allowVolumeExpansion` is `true`, the storage backend has the capacity, and you expand the PVC of the member whose disk is full. There is no rollback for the size; a smaller volume needs a new instance and a data migration.

Raise the volume size of the instance and of the full claim to the same value, so the operator does not work against the new size:

```bash
kubectl patch postgresql <cluster> -n <namespace> --type=merge -p '{"spec":{"volume":{"size":"<new-size>"}}}'
kubectl patch pvc <pvc-name> -n <namespace> -p '{"spec":{"resources":{"requests":{"storage":"<new-size>"}}}}'
kubectl get pvc <pvc-name> -n <namespace> -w
```

If the data owner prefers to free space instead, delete data that is no longer needed through SQL.

### Cause 2: WAL fills the primary because replication has been broken for a long time

Find the leader, how far the replica is behind, and how much of the disk is WAL:

```bash
kubectl exec -n <namespace> <cluster>-0 -c postgres -- patronictl list
kubectl exec -n <namespace> <leader-pod> -c postgres -- du -sh /home/postgres/pgdata/pgroot/data/pg_wal
kubectl exec -n <namespace> <leader-pod> -c postgres -- psql -U postgres -c 'select slot_name, active, restart_lsn from pg_replication_slots'
```

A large `pg_wal`, a replica far behind or not streaming, and an inactive replication slot for that replica fit this cause. Expand the leader PVC first (Cause 1) so the leader can serve while the replica is rebuilt. Then rebuild the replica by deleting its PVC and then its Pod; the StatefulSet creates both again and the member clones itself from the leader.

> **Warning:** Deleting the replica PVC destroys that member's copy of the database. The new member copies the full data set from the leader, which loads the leader's disk and network until it finishes. Precondition: `patronictl list` shows the Pod you delete as `Replica`, not `Leader`; the leader is `running`; a backup of the leader exists. The PVC delete is irreversible. Run it only against the replica.

```bash
kubectl get pod <replica-pod> -n <namespace> -o jsonpath='{.spec.volumes[*].persistentVolumeClaim.claimName}{"\n"}'
kubectl delete pvc <replica-pvc> -n <namespace> --wait=false
kubectl delete pod <replica-pod> -n <namespace>
kubectl get pod,pvc -n <namespace> -w
```

When `patronictl list` shows the rebuilt member `streaming` (or `running` with a small lag), the leader can remove the old WAL. Check `du -sh` on `pg_wal` again; the space is freed after the next checkpoints.

### Cause 3: Replica stays starting with Lag unknown after the WAL it needs is lost

```bash
kubectl exec -n <namespace> <cluster>-0 -c postgres -- patronictl list
kubectl logs -n <namespace> <replica-pod> -c postgres --tail=100
```

Reinitialize only the member that shows `Replica` / `starting` / `unknown`, while the other member is `Leader` / `running`.

> **Warning:** `patronictl reinit` erases the data directory of the named member and copies it again from the leader. Anything that existed only on that member is lost. Precondition: the named member is the replica, the leader is running and serving, and a backup of the leader exists. Irreversible for the member's local data. Name only the replica member.

```bash
kubectl exec -it -n <namespace> <any-member-pod> -c postgres -- patronictl reinit <cluster> <replica-member>
```

The command can run from any member Pod, including the `0/1` replica itself; Patroni asks for confirmation. Watch `patronictl list` until the member shows the leader's timeline and a numeric lag. If it stays in `creating replica` with Lag `unknown`, or its log says `system ID is invalid`, continue with Cause 7.

### Cause 4: SMT Alignment Error: requested 1 cpus not multiple cpus per core = 2

```bash
kubectl get pod <pod> -n <namespace> -o jsonpath='{.status.reason}{" "}{.status.message}{"\n"}'
kubectl get pod <pod> -n <namespace> -o jsonpath='{range .spec.containers[*]}{.name}{" "}{.resources}{"\n"}{end}'
```

On the node named in the Pod spec:

```bash
grep -i -E 'cpuManagerPolicy|cpuManagerPolicyOptions|full-pcpus-only|topologyManagerPolicy' -A2 /var/lib/kubelet/config.yaml
```

> **Warning:** Changing the instance CPU recreates its Pods; each member restarts once and the leader can fail over. Precondition: the nodes have enough free CPU for the even value, and the application owner accepts a short disconnect. Rollback is setting the previous value again, which brings the error back on these nodes.

Set the CPU request and limit of the instance to an even number (for example `2`) with the instance Update action in Data Services.

### Cause 5: SQL writes fail because the primary/standby switchover is stuck

```bash
kubectl exec -n <namespace> <cluster>-0 -c postgres -- patronictl list
kubectl logs -n <namespace> <cluster>-0 -c postgres --tail=100
kubectl exec -n <namespace> <leader-pod> -c postgres -- psql -U postgres -c 'select pg_is_in_recovery()'
```

No member `running` as `Leader`, a pending switchover, or a leader that still answers `t` to `pg_is_in_recovery()` while writes fail fits this cause.

> **Warning:** Deleting a PostgreSQL Pod restarts that member and clients see a disconnect; if it holds the leader lock, Patroni elects a leader again. Precondition: this cause is confirmed with `patronictl list`. Delete Pods only, never PVCs and never the `postgresql` resource. No rollback is needed; the StatefulSet recreates the Pod on its existing PVC.

```bash
kubectl delete pod -n <namespace> <postgresql-pod>
kubectl exec -n <namespace> <cluster>-0 -c postgres -- patronictl list
```

Retry a write from the application. If writes still fail, collect `patronictl list` and the `postgres` logs of both members before any further restart.

### Cause 6: Replica cannot start because global/pg_control cannot be read after a node crash

```bash
kubectl exec -n <namespace> <primary-pod> -c postgres -- patronictl list
kubectl logs -n <namespace> <replica-pod> -c postgres --tail=200 | grep -i -E 'pg_control|pg_controldata'
kubectl get pod <replica-pod> -n <namespace> -o jsonpath='{.spec.nodeName}{" "}{.spec.volumes[*].persistentVolumeClaim.claimName}{"\n"}'
```

The node that hung must be healthy again (`Ready`, the kernel issue fixed), and the primary must be `Leader` and `running`.

> **Warning:** Deleting the replica's PVC permanently removes its data directory, including the damaged `pg_control`. The rebuilt member copies the whole database from the primary, which loads the primary until the copy finishes. Precondition: the `pg_control` read failure is confirmed on a member that `patronictl list` shows as the replica, never on the leader; the leader is `running` and a backup of it exists. Irreversible for the replica's local data.

```bash
kubectl delete pvc <replica-pvc> -n <namespace> --wait=false
kubectl delete pod <replica-pod> -n <namespace>
kubectl get pod,pvc -n <namespace> -w
```

When the new member shows `streaming` with the leader's timeline, the replica is resynchronized. If the leader itself reports the `pg_control` error, this procedure does not apply; collect both logs and contact support.

### Cause 7: Replica stopped with "data dir for the cluster is not empty, but system ID is invalid"

```bash
kubectl logs -n <namespace> <replica-pod> -c postgres --tail=200 | grep 'system ID is invalid'
kubectl exec -n <namespace> <leader-pod> -c postgres -- patronictl list
kubectl get postgresql <cluster> -n <namespace> -o yaml > <cluster>-before.yaml
```

Continue only when the member that logs the message is `Replica` / `stopped` and the other is `Leader` / `running`. First run the Cause 3 `patronictl reinit` against that replica. If it stays in `creating replica` with Lag `unknown`, scale the instance to 1 member and back to 2, with the instance Update action in Data Services or on the resource.

> **Warning:** Scaling to 1 member removes the highest-ordinal Pod (`<cluster>-1`) and leaves the instance without a replica until it is scaled back; if that Pod held the leader lock, Patroni fails over. Precondition: `patronictl list` shows `<cluster>-1` as the `stopped` replica and `<cluster>-0` as `Leader` / `running`, and a backup of the leader exists. Never scale to 0. Rollback is setting `numberOfInstances` back to its previous value. If the broken replica is not the highest-ordinal Pod, scaling down removes the wrong member; use the Cause 6 replica rebuild instead.

```bash
kubectl patch postgresql <cluster> -n <namespace> --type=merge -p '{"spec":{"numberOfInstances":1}}'
kubectl get pod,pvc -n <namespace> -w
kubectl patch postgresql <cluster> -n <namespace> --type=merge -p '{"spec":{"numberOfInstances":2}}'
kubectl exec -n <namespace> <cluster>-0 -c postgres -- patronictl list
```

Patch back to 2 only after `<cluster>-1` is gone. If the new `<cluster>-1` mounts its old PVC again and returns with the same log, use the Cause 6 replica PVC procedure (replica only). The member is healthy when it shows `streaming` or `running` with the leader's timeline and a numeric lag; then rerun the upgrade checklist.

## Diagnostic Steps

```bash
kubectl get postgresql,pods,pvc -n <namespace> -o wide
kubectl exec -n <namespace> <cluster>-0 -c postgres -- patronictl list
kubectl exec -n <namespace> <cluster>-0 -c postgres -- df -h /home/postgres/pgdata
kubectl get events -n <namespace> --sort-by=.lastTimestamp | tail -n 30
```

| Signature | Cause |
| --- | --- |
| `No space left on device` on `recovery.conf`, `df` at 100%, no WAL backlog | Cause 1 |
| `pg_wal` large on the leader, replica far behind or not streaming | Cause 2 |
| Replica `starting`, empty TL, `Lag in MB` `unknown`, leader `running` | Cause 3 |
| `SMT Alignment Error: requested 1 cpus not multiple cpus per core = 2` | Cause 4 |
| Writes fail, switchover stuck in `patronictl list` | Cause 5 |
| Replica log: `pg_controldata` fails, `global/pg_control` unreadable, after its node crashed | Cause 6 |
| Replica `stopped`, Lag `unknown`, log `system ID is invalid; consider doing reinitialize` | Cause 7 |

If a member's container is not running, `patronictl list` still works from the other member. If both members are down because both disks are full, expand both PVCs before any rebuild.

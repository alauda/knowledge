---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Harbor PostgreSQL database Pod never starts after an operator upgrade, with transparent huge pages, low CPU, or on NFS

## Issue

Harbor is unreachable, the login page reports that the core service is unavailable, or `harbor-core` is in `CrashLoopBackOff` because it cannot connect to PostgreSQL. `harbor-jobservice` and `harbor-notary-server` crash for the same database outage. The database itself does not come up, and one of the following is seen:

- The PostgreSQL log contains `unrecognized configuration parameter "wal_keep_segments"`, or no Harbor Pod can start right after the PostgreSQL operator upgraded itself.
- The database Service answers `connection refused` on port 5432 and the operator never creates the `pg` Pod.
- The `pg` Pod stays `Pending`.
- The built-in `harbor-database` Pod takes a very long time to become Ready on NFS storage, logs `FATAL: the database system is starting up` until it times out, or has `FailedMount` events on `database-data`.

Related articles: [Harbor PostgreSQL rejects sessions with too many clients already (SQLSTATE 53300)](Harbor_PostgreSQL_rejects_sessions_with_too_many_clients_already_SQLSTATE_53300.md) covers a database that is up but has no free sessions.

## Root Cause

### Cause 1: a newer PostgreSQL operator upgraded a PostgreSQL 12 cluster

A newer PostgreSQL operator was installed, or upgraded itself automatically through its Subscription, on a cluster still running PostgreSQL 12. That operator no longer supports PostgreSQL 12 and starts an automatic upgrade. The existing configuration still contains `wal_keep_segments`, which the newer server refuses, so startup aborts:

```text
unrecognized configuration parameter "wal_keep_segments"
```

`harbor-core`, `harbor-jobservice`, and `harbor-notary-server` then crash-loop because the database never finishes startup. The log line is not always captured; an instance that became abnormal right after an automatic operator upgrade is the same cause. Rolling the operator back to the previous version restores the instance. Before the newer operator is installed again, PostgreSQL 12 must be upgraded to PostgreSQL 14 or 16.

### Cause 2: transparent huge pages are enabled on the node

Connections to `acid-<cluster>.<namespace>.svc:5432` fail with `connection refused`, and the `pg` Pod is not created. With transparent huge pages enabled on the node, the PostgreSQL cluster fails during startup (its initialization uses `/dev/shm`) and the operator does not create the Pod. Disabling transparent huge pages at the operating-system level lets the cluster start. The fix is the huge-page setting, not a resize of `/dev/shm`.

### Cause 3: the pg Pod is Pending because its node has too little CPU

`harbor-core` logs that it cannot connect to `pg`, and the `pg` Pod has been `Pending` the whole time with `Insufficient cpu`. When the PostgreSQL volume is node-local (for example TopoLVM), the PV is bound to one node and the Pod cannot move. If that node's CPU was reduced at the infrastructure level (for example a VM resized to 1 CPU, leaving about 200m allocatable), the Pod cannot be scheduled and nothing listens on port 5432.

### Cause 4: the built-in harbor-database starts very slowly on NFS storage

The database PVC uses an NFS StorageClass (for example `nfs-client`). A very large number of files on NFS can make Harbor start abnormally or extremely slowly. The database logs `FATAL: the database system is starting up` until startup times out, or the Pod has:

```text
FailedMount: Unable to attach or mount volumes: unmounted volumes=[database-data] ... timed out waiting for the condition
```

The `FailedMount` timeout on `database-data` is a typical NFS server-side timeout. The hang clears after the Harbor operator, the Harbor workloads, and the CSI Pods on the Harbor nodes are restarted and Pods stuck in `Terminating` are force-deleted. Where startup stays slow, a new Harbor instance on local `hostpath` or CephFS storage is the recommended layout.

## Resolution

### Cause 1

1. Confirm the log line and the operator version, and check whether the operator upgraded itself. A recent install plan for a newer `postgres-operator` CSV with `installPlanApproval: Automatic` matches an automatic upgrade.

   ```bash
   PG_NS=<postgresql-namespace>
   PG_POD=<acid-pod>
   kubectl -n "$PG_NS" logs "$PG_POD" --tail=100 | grep wal_keep_segments
   kubectl get csv -A | grep postgres-operator
   kubectl get installplan -A | grep -i postgres
   kubectl get subscription -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,APPROVAL:.spec.installPlanApproval,CURRENT:.status.currentCSV,INSTALLED:.status.installedCSV' | grep -i postgres
   ```

2. Uninstall the newer PostgreSQL operator and install the previous version that was running this PostgreSQL 12 cluster. If a Subscription keeps reinstalling the newer CSV, remove that Subscription and the newer CSV, then install the previous version from OperatorHub.

   > **Warning:** Only when the PostgreSQL log contains `unrecognized configuration parameter "wal_keep_segments"` after a newer operator was installed against PostgreSQL 12, or the instance became abnormal right after an automatic operator upgrade shown in step 1. Impact: while the operator is removed, no PostgreSQL instance on the cluster is reconciled, not only Harbor's. Precondition: a maintenance window, the previous operator version available in OperatorHub, and every `postgresql` resource and its PVCs left in place (if the uninstall offers to delete operands, leave that off). Rollback: reinstall the newer operator, which is valid only after PostgreSQL 12 has been upgraded to 14 or 16.

   ```bash
   OP_NS=<operator-namespace>
   kubectl -n "$OP_NS" delete subscription <postgres-subscription>
   kubectl -n "$OP_NS" delete csv <new-postgres-operator-csv>
   ```

3. After installing the previous version, wait until the cluster is Running and the `wal_keep_segments` line is gone:

   ```bash
   kubectl get postgresql -A
   kubectl -n "$PG_NS" get pods -o wide | grep acid-
   kubectl -n "$PG_NS" logs "$PG_POD" --tail=40
   ```

4. Plan the upgrade of PostgreSQL 12 to 14 or 16 before installing the newer operator again. To prevent another automatic upgrade, set the Subscription to manual approval.

### Cause 2

1. On the node that should run the `pg` Pod (the node that owns the volume, if the volume is node-bound), read and save the current setting:

   ```bash
   cat /sys/kernel/mm/transparent_hugepage/enabled
   cat /sys/kernel/mm/transparent_hugepage/defrag
   ```

   Continue only when `enabled` shows `[always]` and the `pg` Pod is absent or the database never opens port 5432.

2. Disable transparent huge pages and keep the setting across reboots.

   > **Warning:** Only when transparent huge pages are `[always]` and the PostgreSQL cluster fails to start as described. Impact: the change applies to every process on the node, not only PostgreSQL. Precondition: the previous `enabled` and `defrag` values are saved; use a maintenance window if latency-sensitive workloads share the node. Rollback: write the saved values back to both files and disable the unit below.

   ```bash
   echo never | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
   echo never | sudo tee /sys/kernel/mm/transparent_hugepage/defrag
   sudo tee /etc/systemd/system/disable-thp.service >/dev/null <<'EOF'
   [Unit]
   Description=Disable transparent huge pages for PostgreSQL
   After=network.target

   [Service]
   Type=oneshot
   ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled; echo never > /sys/kernel/mm/transparent_hugepage/defrag'
   RemainAfterExit=yes

   [Install]
   WantedBy=multi-user.target
   EOF
   sudo systemctl daemon-reload
   sudo systemctl enable --now disable-thp.service
   ```

3. Watch the operator create the `pg` Pod and the cluster reach `Running`. Harbor reconnects once port 5432 accepts sessions.

### Cause 3

1. Confirm the Pending reason and the node the volume is bound to. Adding CPUs to a different node does not help a node-local volume that is already bound.

   ```bash
   kubectl -n "$PG_NS" describe pod "$PG_POD"
   kubectl describe node <node-name>
   ```

   On the node: `lscpu` and `grep -c processor /proc/cpuinfo`.

2. Give the VM more CPUs at the infrastructure level, then reboot the node.

   > **Warning:** Only when the `pg` Pod is `Pending` with `Insufficient cpu` and its PV is bound to this node. Impact: rebooting stops every Pod on the node, including non-Harbor workloads. Precondition: the new CPU allocation is already applied to the VM, and a maintenance window covers the other Pods on the node. A reboot cannot be undone; reducing the CPUs again returns the Pod to Pending.

   ```bash
   sudo shutdown -r now
   ```

3. When the node is Ready and `lscpu` shows the new CPUs, confirm the `pg` Pod is Running, then restart the Harbor Deployments that are still crash-looping so they connect again.

   > **Warning:** Only when the `pg` Pod is Running and `harbor-core` or `harbor-jobservice` is still in `CrashLoopBackOff`. Impact: in-flight core and jobservice work is dropped until the new Pods are Ready. The Deployments recreate the Pods; nothing needs to be rolled back.

   ```bash
   H_NS=<harbor-namespace>
   CORE=$(kubectl -n "$H_NS" get deploy -o name | grep harbor-core | head -1)
   JOB=$(kubectl -n "$H_NS" get deploy -o name | grep harbor-jobservice | head -1)
   kubectl -n "$H_NS" rollout restart "$CORE" "$JOB"
   kubectl -n "$H_NS" rollout status "$CORE"
   ```

### Cause 4

1. Rule out Causes 1 to 3 and a full NFS export (a database that cannot write to a full export also fails to start; see [Harbor unreachable or its PostgreSQL out of space because Harbor storage is full](Harbor_unreachable_or_its_PostgreSQL_out_of_space_because_Harbor_storage_is_full.md)). Then confirm the volume is on NFS:

   ```bash
   H_NS=<harbor-namespace>
   kubectl -n "$H_NS" get pods -o wide | grep harbor-database
   kubectl -n "$H_NS" describe pod <harbor-database-pod> | sed -n '/Events:/,$p'
   kubectl -n "$H_NS" logs <harbor-database-pod> --tail=100
   kubectl -n "$H_NS" get pvc -o wide | grep -i database
   kubectl get storageclass <storageclass-name> -o jsonpath='{.provisioner}{"\n"}'
   ```

2. Restart the Harbor operator, the Harbor Deployments, and the CSI Pods on the Harbor nodes.

   > **Warning:** Only when the volume is NFS and the database is stuck in `the database system is starting up` or has a `FailedMount` timeout on `database-data`. Impact: Harbor reconciliation pauses until the operator Pod is Ready; restarting CSI node Pods interrupts mount and unmount on those nodes until CSI is Ready again. Precondition: delete only CSI Pods that run on the Harbor nodes. The controllers recreate all of these Pods; no data is changed.

   ```bash
   kubectl get deploy -A | grep -i harbor | grep -i operator
   kubectl -n <operator-namespace> rollout restart deploy/<harbor-operator-deployment>
   kubectl -n "$H_NS" get deploy -o name | grep harbor
   kubectl -n "$H_NS" rollout restart deploy/<harbor-deployment>
   kubectl get pods -A -o wide | grep -i csi | grep <harbor-node>
   kubectl -n <csi-namespace> delete pod <csi-pod-on-harbor-node>
   ```

3. If a Pod stays `Terminating`, force-delete that Pod only.

   > **Warning:** Only for a Pod that has stayed `Terminating` after a normal delete. Impact: `--force --grace-period=0` skips graceful shutdown, and a volume can stay mounted on the node until CSI releases it. The controller recreates a managed Pod; the stuck process cannot be recovered.

   ```bash
   kubectl -n "$H_NS" delete pod <terminating-pod> --force --grace-period=0
   kubectl -n "$H_NS" get pods -o wide | grep -E 'database|harbor'
   ```

4. If the NFS export holds a very large number of files and startup stays slow, deploy a new Harbor instance on local `hostpath` or CephFS storage, and compare its startup time before removing the old instance.

## Diagnostic Steps

```bash
kubectl get postgresql -A
kubectl get pods -A -o wide | grep -E 'acid-|harbor-database|harbor-pg'
```

| What you see | Cause |
| --- | --- |
| `unrecognized configuration parameter "wal_keep_segments"`, or the instance broke right after an automatic operator CSV upgrade | Cause 1 |
| `connection refused` on port 5432, `pg` Pod missing, `/sys/kernel/mm/transparent_hugepage/enabled` shows `[always]` | Cause 2 |
| `pg` Pod `Pending` with `Insufficient cpu`, volume bound to that node | Cause 3 |
| Built-in `harbor-database` slow to become Ready, `FATAL: the database system is starting up`, `FailedMount` timeout on `database-data`, NFS StorageClass | Cause 4 |
| Database Pod Running, `too many clients already (SQLSTATE 53300)` | SQLSTATE 53300 article above |
| Patroni `DCS is not accessible`, core `read-only transaction (SQLSTATE 25006)`, or `MountDevice failed ... globalmount: mkdir ... file exists` | [Harbor returns 500 when its PostgreSQL loses the Kubernetes API, cannot mount its volume, or has corrupt data](Harbor_returns_500_when_its_PostgreSQL_loses_the_Kubernetes_API_cannot_mount_its_volume_or_has_corrupt_data.md) |

The Harbor PostgreSQL resource is `acid.zalan.do/v1` `postgresql`; its Pods and Service use the `acid-` prefix, parameters live under `spec.postgresql.parameters`, and the instance size under `spec.resources`. An install that uses the built-in `harbor-database` workload keeps the database Pod and its PVC in the Harbor namespace.

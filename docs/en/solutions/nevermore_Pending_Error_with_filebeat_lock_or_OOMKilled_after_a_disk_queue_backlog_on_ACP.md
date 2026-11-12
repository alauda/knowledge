---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.14.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# nevermore Pending, Error with filebeat.lock, or OOMKilled after a disk queue backlog on ACP

## Issue

The `nevermore` log agent does not run on some nodes. Typical reports:

- "The log collection component is abnormal", and `nevermore` pods are `Pending` for days.
- "`nevermore` is stuck": one pod is `3/4 Error` while the others are `4/4 Running`.
- A `nevermore` pod cannot start and its status is `OOMKilled` after the log store was down.

`nevermore` is the per-node DaemonSet in `cpaas-system` that collects container logs, Kubernetes audit records and events. Its local queue is under `/cpaas` (`/cpaas/log`, `/cpaas/audit`, `/cpaas/event`), with segment files `*.seg` under, for example, `/cpaas/log/data/diskqueue`. Its own log is `/cpaas/log/logs/nevermore`. The container names differ between releases (for example `audit` and `log`, or `nevermore-audit`, `nevermore-event` and `nevermore-log`). Read them from the DaemonSet before you pass `-c`:

```bash
kubectl -n cpaas-system get ds nevermore -o jsonpath='{.spec.template.spec.containers[*].name}'
```

When `nevermore` is `OOMKilled` without a queue backlog, writes its cache under `/var/cpaas`, or waits for the `log-collector-bearer-auth` Secret, see [nevermore OOMKilled, cache written to /var/cpaas, or callback-secret mount failure on ACP](./nevermore_OOMKilled_cache_written_to_var_cpaas_or_callback-secret_mount_failure_on_ACP.md).

## Root Cause

### Cause 1: nevermore cannot start because the node has too little memory

`kubectl get ars -A` shows `logagent` as `Synced`, with health `WaitReady` and message `chart synced`. One or more `nevermore` pods are `0/4` `Pending`, and their events read:

```text
Warning  FailedScheduling  default-scheduler  0/59 nodes are available: 1 Insufficient memory. preemption: 0/59 nodes are available: 59 No preemption victims found for incoming pod..
```

A DaemonSet pod is bound to one node, so `1 Insufficient memory` refers to that node. `kubectl logs` on the pending pod prints only `Defaulted container ...`, because a pod that never started has no container log. The node is a small machine (for example 2 CPU / 4 GB) that cannot fit the `nevermore` requests next to its other pods. Giving the machine more memory lets the pod schedule.

### Cause 2: nevermore is OOMKilled because its disk queue filled while Elasticsearch was down

The `nevermore` pod cannot start, and its status is `OOMKilled`. Elasticsearch had been abnormal, so `nevermore` could not ship, and the collected data piled up in the local disk queue. `/cpaas/log/data/diskqueue` is large. Repairing Elasticsearch and then deleting the `*.seg` files under `/cpaas/log/data/diskqueue` returns `nevermore` to normal. Raising the limits alone does not empty this queue.

The same cache family also has `/cpaas/audit/data/diskqueue` and `/cpaas/event/data/diskqueue`. Clean those only when `du` shows that they are large, and only the files inside `diskqueue`. Do not delete `/cpaas/log`, `/cpaas/audit` or `/cpaas/event` themselves. Cleaning `diskqueue` while Elasticsearch is still down frees disk space only until the queue refills.

### Cause 3: An old nevermore log container stays on the node and blocks the new one

One `nevermore` pod is `3/4 Error` with a few restarts, while the others are `4/4 Running`. `kubectl logs -p <pod>` defaults to the audit container and answers `previous terminated container "audit" in pod "<pod>" not found`. The failing container is the log container, and its previous log is:

```text
Exiting: /cpaas/log/data/filebeat.lock: data path already locked by another beat. Please make sure that multiple beats are not sharing the same data path (path.data)
```

On its node, `crictl ps -a | grep never` shows the new pod's log container `Exited` with several restarts. It also shows the log container of an old `nevermore` pod, created months earlier, still `Running`, while the old pod's other containers are `Exited`. The old container holds `/cpaas/log/data/filebeat.lock` and prevents the new one from starting. Deleting the old container fails, and killing its process by PID does not remove it either. Rebooting the node clears it, and `nevermore` recovers. Why the container could not be removed is not known.

## Resolution

### Cause 1: nevermore cannot start because the node has too little memory

1. Confirm the signature:

   ```bash
   kubectl get ars -A | grep logagent
   kubectl get pod -A | grep nevermore | grep -v Run
   kubectl -n cpaas-system describe pod <nevermore-pod> | sed -n '/Events:/,$p'
   kubectl get nodes -o custom-columns=NAME:.metadata.name,CPU:.status.capacity.cpu,MEM:.status.capacity.memory
   kubectl describe node <node> | sed -n '/Allocated resources/,/Events/p'
   ```

   `0/N nodes are available: 1 Insufficient memory` on a `Pending` `nevermore` pod, on a node too small for its requests, matches this cause.

2. Add memory (and CPU) to the node. For a VM, this usually needs the VM to be stopped.

   > **Warning:** Resizing the node VM restarts it, which stops every pod on that node. Precondition: the node is cordoned and drained (`kubectl cordon <node>` and `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`). Rollback: resize the VM back; run `kubectl uncordon <node>` when it is up.

3. After the node is back, run `kubectl uncordon <node>`. The DaemonSet pod then schedules.

### Cause 2: nevermore is OOMKilled because its disk queue filled while Elasticsearch was down

1. Repair Elasticsearch first, or the queue refills. See [Elasticsearch log indices red or yellow with unassigned shards on ACP](./Elasticsearch_log_indices_red_or_yellow_with_unassigned_shards_on_ACP.md).

2. On the node, check the queue size:

   ```bash
   du -sh /cpaas/log/data/diskqueue /cpaas/audit/data/diskqueue /cpaas/event/data/diskqueue
   ls /cpaas/log/data/diskqueue | head
   ```

3. Delete the queued segment files and restart the pod.

   > **Warning:** Deleting `*.seg` files removes queued log records that were never shipped, so search has a permanent gap for that window. Precondition: only when `nevermore` is `OOMKilled`, the disk queue is large, and Elasticsearch has already been repaired. Do not delete the parent `/cpaas/log` tree. Rollback: none.

   ```bash
   find /cpaas/log/data/diskqueue -name '*.seg' -delete
   kubectl -n cpaas-system delete pod <nevermore-pod-on-this-node>
   ```

   If `du` also showed a large audit or event `diskqueue`, the same gap applies when you delete the segment files there.

### Cause 3: An old nevermore log container stays on the node and blocks the new one

1. Confirm the signature:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep never
   kubectl -n cpaas-system logs <nevermore-pod> -c <log-container> -p | grep 'filebeat.lock'
   ```

   On the node:

   ```bash
   crictl ps -a | grep -i nevermore
   crictl inspect <old-container-id> | grep -E '"pid"|"state"'
   ```

   `data path already locked by another beat` in the new log container, together with a `Running` log container whose pod ID belongs to an old `nevermore` pod, matches this cause.

2. Try to remove the old container with `crictl rm -f <old-container-id>`. If that fails and killing its PID does not remove it, reboot the node.

   > **Warning:** Rebooting the node stops every pod on it. Precondition: only when an old `nevermore` log container remains, `crictl rm -f` and killing its PID both failed, and the node is cordoned and drained. Rollback: none needed; uncordon the node after the reboot.

   ```bash
   kubectl cordon <node>
   kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
   ```

   On the node:

   ```bash
   systemctl reboot
   ```

3. After the node is back, run `kubectl uncordon <node>`, and check that `nevermore` is `Running`.

## Diagnostic Steps

1. Read the pod state and the node:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep nevermore
   kubectl -n cpaas-system describe pod <nevermore-pod> | grep -E 'State|Reason|Exit Code|Limits' -A2
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | `Pending` with `Insufficient memory` on a small node | Cause 1 |
   | `OOMKilled` with a large `/cpaas/log/data/diskqueue` after Elasticsearch trouble | Cause 2, repair Elasticsearch before deleting `*.seg` |
   | `filebeat.lock: data path already locked by another beat`, with an old container that cannot be removed | Cause 3 |
   | `OOMKilled` with no queue backlog | See the related article on limit-driven OOM |

## Related Information

- [nevermore OOMKilled, cache written to /var/cpaas, or callback-secret mount failure on ACP](./nevermore_OOMKilled_cache_written_to_var_cpaas_or_callback-secret_mount_failure_on_ACP.md)
- [nevermore and ClickHouse log components alert on CPU or memory, restart, or ignore new resource values on ACP](./nevermore_and_ClickHouse_log_components_alert_on_CPU_or_memory_restart_or_ignore_new_resource_values_on_ACP.md)

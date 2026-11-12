---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# nevermore OOMKilled, cache written to /var/cpaas, or callback-secret mount failure on ACP

## Issue

Application pods are logging and `kubectl logs` shows the lines, but the log console is empty or hours behind. On the nodes, one of the following is seen:

- The `nevermore` DaemonSet in `cpaas-system` is restarting, and its main container or its `audit` container shows `OOMKilled`. On the node, `dmesg -T | grep -i -E 'out of memory|killed process'` shows `Memory cgroup out of memory` every few minutes, while the cluster monitoring shows node CPU and memory at only 20% to 30%.
- `/var` is at 100% because files appeared under `/var/cpaas`.
- On a fresh install, the `nevermore` pods sit in `Init:0/1` or `ContainerCreating` with `secret "log-collector-bearer-auth" not found`.

`nevermore` is the per-node log agent. It reads container logs, Kubernetes audit records and events, and produces them into the platform Kafka, from which they are written into Elasticsearch or ClickHouse. Its local queue is under `/cpaas` (`/cpaas/log`, `/cpaas/audit`, `/cpaas/event`), and its own log is `/cpaas/log/logs/nevermore`.

A `Memory cgroup out of memory` kill means that a container reached its **own** memory limit. That happens regardless of how much memory the node has free, which is why node-level monitoring can look low at the same time.

When `nevermore` is `Pending`, fails on `filebeat.lock`, or is `OOMKilled` with a large disk queue after the log store was down, see [nevermore Pending, Error with filebeat.lock, or OOMKilled after a disk queue backlog on ACP](./nevermore_Pending_Error_with_filebeat_lock_or_OOMKilled_after_a_disk_queue_backlog_on_ACP.md).

## Root Cause

### Cause 1: The nevermore main container or its audit container is OOMKilled by its memory limit

`kubectl describe` on a `nevermore-*` pod shows `Reason: OOMKilled` and exit code 137, either on the main container or on the container named `audit`. The container names differ between versions (for example `nevermore-audit`, `nevermore-event` and `nevermore-log` on older releases), so read them from the DaemonSet. While the container is down, the agent stops shipping, and the records wait in its on-disk queue under `/cpaas`.

Consumer lag is the gap between what was produced and what was consumed, so a stopped producer does not raise it. The lag on `ALAUDA_LOG_TOPIC` climbs when the restarted agent flushes its queue faster than the consumer reads it. It falls once the container stays up and the consumer catches up.

The node's log volume exceeds what the current limit allows. The main container stops restarting after its resources are raised (to about 2 CPU and 2Gi). An `audit` container OOM is cleared the same way, by raising that container's resources.

One workload can be the whole cause. On one cluster, the `log` container of `nevermore` ran at its 2000m CPU limit, and its memory spiked toward the 4096Mi limit. The other containers stayed low, and the cache under `/cpaas/log/data` was small. The real-time application log showed about 600 thousand entries per minute, nearly all from one test workload running an `echo` loop with no resource limits. Stopping that application ended the OOM, and the next day the `log` container ran at about 19m CPU and 552Mi.

A full node disk can also push the agent over its limit. Free the disk before you only add memory, or the same pod is OOMKilled again.

### Cause 2: spec.valuesOverride on the logagent ModuleInfo points the cache at /var/cpaas

`df` shows `/var` at 100%, and `du -sh /var/cpaas` shows several gigabytes, while `/cpaas` itself may still have room. The installed log agent module object (kind ModuleInfo, short name `minfo`, on the global cluster) has a `spec.valuesOverride` that changed the `nevermore` local cache directory. The product default is `/cpaas/`. After the override, `event`, `log` and `audit` are written onto the smaller `/var` partition.

Deleting that `spec.valuesOverride` puts the cache back on `/cpaas/`. Files that are already under `/var/cpaas` are not moved by the revert.

### Cause 3: FailedMount for volume callback-secret, secret log-collector-bearer-auth not found

The pod event is:

```text
MountVolume.SetUp failed for volume "callback-secret": secret "log-collector-bearer-auth" not found
```

The agent cannot start because the Secret that the callback volume mounts was never created. For example, on a 4.3 business cluster every `nevermore` pod sits at `0/4` `Init:0/1`. `kubectl get secret -A | grep log` lists `log-callback-secret` and `log-center-secret` in `cpaas-system`, but no `log-collector-bearer-auth`.

Reinstalling the Log Collector does not create the Secret. The Alauda Container Platform Log Essentials plugin (`log-essentials`) creates it. Install Log Essentials on the cluster before the Log Collector, then restart Deployment `cluster-transformer` in `cpaas-system` so that it regenerates the Secret.

## Resolution

### Cause 1: The nevermore main container or its audit container is OOMKilled by its memory limit

1. List the containers and the last termination:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep nevermore
   kubectl -n cpaas-system get ds nevermore -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{" "}{.resources.limits.memory}{"\n"}{end}'
   kubectl -n cpaas-system describe pod <nevermore-pod> | grep -E 'OOMKilled|Exit Code|Limits|Requests'
   ```

2. Before raising limits, check whether one workload floods its output or the disk is full:

   ```bash
   kubectl -n cpaas-system top pod --containers | grep nevermore
   du -sh /cpaas/log/data/* 2>/dev/null
   df -hT /cpaas
   ```

   Run `du` and `df` on the node. If only the `log` container is hot and the cache is small, find the workload with the largest real-time log volume in the console, and stop or fix it. Free a full disk first.

3. Raise the resources of the container that was OOMKilled.

   > **Warning:** Raising CPU and memory on DaemonSet `nevermore` rolls the agent on every node, and collection pauses on a node while its pod restarts. Precondition: the node has the extra memory free, and you noted the previous requests and limits. A module controller can revert a direct DaemonSet edit. If the pod spec snaps back, set the same numbers in the log agent ModuleInfo `spec.valuesOverride`, under the resources key that object already uses. Rollback: `kubectl set resources` with the previous values, or re-apply the saved ModuleInfo.

   ```bash
   kubectl -n cpaas-system set resources ds/nevermore \
     -c <nevermore-container> --requests=cpu=2,memory=2Gi --limits=cpu=2,memory=2Gi
   ```

   Repeat the command with `-c` for the `audit` container if that is the one with `OOMKilled`. Size the `audit` container above the usage that killed it, instead of copying 2Gi onto every container.

4. Watch that `RESTARTS` stops increasing, then confirm that the Kafka lag is falling:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep nevermore
   ```

### Cause 2: spec.valuesOverride on the logagent ModuleInfo points the cache at /var/cpaas

1. On the global cluster, save the ModuleInfo:

   ```bash
   kubectl get minfo | grep logagent | grep <cluster-name>
   kubectl get minfo <logagent-minfo> -o yaml > /tmp/logagent-minfo.before.yaml
   kubectl get minfo <logagent-minfo> -o jsonpath='{.spec.valuesOverride}'
   ```

2. Remove the cache-path override.

   > **Warning:** Clearing the whole `spec.valuesOverride` drops every override on that module, including resource overrides from Cause 1, and `nevermore` rolls back to the default cache directory `/cpaas/`. Precondition: `/cpaas` has free space, you saved the YAML, and you read the override so that other keys can be put back. Rollback: `kubectl apply -f /tmp/logagent-minfo.before.yaml`. If other keys must stay, delete only the key that sets the cache path.

   ```bash
   kubectl edit minfo <logagent-minfo>
   ```

   Wait until DaemonSet `nevermore` is Ready, then check on the node that the default directories exist:

   ```bash
   ls -ld /cpaas/event /cpaas/log /cpaas/audit
   ```

3. If `/cpaas/event`, `/cpaas/log` or `/cpaas/audit` does not exist yet and the only copy is under `/var/cpaas`, move that directory once. Skip the move when `/cpaas/<name>` already exists, because that tree is the live queue.

   > **Warning:** The directories under `/var/cpaas` hold unshipped cache, and a later delete of the source is irreversible. Precondition: `nevermore` has been reverted to `/cpaas/`, and `du` showed these directories under `/var/cpaas`, not `/var/log` or `/var/lib`. Rollback: move the directory back, only if `nevermore` has not started a new queue at the destination.

   ```bash
   mkdir -p /cpaas
   for d in event log audit; do
     if [ -d "/var/cpaas/$d" ] && [ ! -e "/cpaas/$d" ]; then
       mv "/var/cpaas/$d" "/cpaas/$d"
     fi
   done
   ```

4. Free what remains under `/var/cpaas`.

   > **Warning:** `rm -rf` under `/var/cpaas` deletes log cache that has not been shipped, so search has a gap for those records. Precondition: the path that `du` printed is under `/var/cpaas`, and `nevermore` is already writing the restored `/cpaas/` tree. When `/var` is at 100% and pods cannot start, deleting the `logs` directory first gives temporary relief before the revert takes effect. Rollback: none.

   ```bash
   du -sh /var/cpaas /var/cpaas/*
   rm -rf /var/cpaas/<cache>/logs
   ```

### Cause 3: FailedMount for volume callback-secret, secret log-collector-bearer-auth not found

1. Confirm the signature:

   ```bash
   kubectl get secret -A | grep log
   kubectl -n cpaas-system get pods | grep nevermore
   kubectl -n cpaas-system describe pod <nevermore-pod> | grep -A2 FailedMount
   ```

2. Install the `log-essentials` plugin from the cluster plugin page, where the log collector was installed. Reinstalling only the Log Collector does not create the Secret.

3. Restart the transformer so that it regenerates the Secret.

   > **Warning:** Restarting `cluster-transformer` pauses plugin status updates during the rollout. It does not delete log data. Precondition: `log-essentials` is installed or installing. Rollback: none needed; a restart has no spec change to undo.

   ```bash
   kubectl -n cpaas-system rollout restart deployment/cluster-transformer
   kubectl -n cpaas-system rollout status deployment/cluster-transformer
   kubectl -n cpaas-system get secret log-collector-bearer-auth
   kubectl -n cpaas-system get pods | grep nevermore
   ```

   The Secret must exist, and the `nevermore` pods must leave `Init` and `ContainerCreating`.

4. If Log Essentials was already installed and `log-collector-bearer-auth` is still missing after the transformer rollout, this procedure does not apply. That situation needs a different investigation, for example on a standby global cluster.

## Diagnostic Steps

1. Compare the source with the agent before you look at Kafka:

   ```bash
   kubectl logs <pod> -n <namespace> -c <container> --tail=20
   kubectl -n cpaas-system get pods -o wide | grep nevermore
   ```

   If the line is absent from the source, this article does not apply.

2. On the node that reports OOM kills, read the kernel log and the container that was killed:

   ```bash
   dmesg -T | grep -i -E 'out of memory|killed process' | tail -5
   kubectl -n cpaas-system describe pod <nevermore-pod> | grep -E 'OOMKilled|Exit Code|Limits|Requests'
   ```

   `Memory cgroup out of memory` naming a `nevermore` process, together with `OOMKilled` on a `nevermore` container, is Cause 1.

3. For the cache path, run `df -hT /var /cpaas` and `du -sh /var/cpaas` on the node, then read the `logagent` ModuleInfo `spec.valuesOverride` on the global cluster. A cache path under `/var/cpaas` is Cause 2.

4. The `callback-secret` event with pods at `Init:0/1`, on a cluster without Log Essentials, is Cause 3.

5. When the pod is up, read the agent log for enqueue or connection errors:

   ```bash
   kubectl -n cpaas-system logs <nevermore-pod> -c <container> --tail=100
   ```

## Related Information

- [nevermore Pending, Error with filebeat.lock, or OOMKilled after a disk queue backlog on ACP](./nevermore_Pending_Error_with_filebeat_lock_or_OOMKilled_after_a_disk_queue_backlog_on_ACP.md)
- [nevermore and ClickHouse log components alert on CPU or memory, restart, or ignore new resource values on ACP](./nevermore_and_ClickHouse_log_components_alert_on_CPU_or_memory_restart_or_ignore_new_resource_values_on_ACP.md)

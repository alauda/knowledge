---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.2"
  - "4.3"
---

# Cluster plugin stuck at wait resources ready: Pod Pending, /cpaas I/O error, or missing log secret on ACP

## Issue

The plugin chart is applied, and the install or upgrade then waits for the plugin's workloads to become ready and never gets there:

- The multus plugin installation hangs in Deploying. `kubectl describe ars -n cpaas-system multus` shows Reason `NotReady` with `failed to wait chart alauda-multus-plugin-v3.18.3 state, err: timed out waiting for the condition`.
- The Elasticsearch log storage plugin upgrade stays at the `CheckStatus-logcenter` step, and the progress log repeats `WaitReady: wait resources ready`.
- After the 4.3.2 logging packages (`log-agent`, `log-api`, `log-clickhouse`) were pushed, the upgrade button of the logging cluster plugins stays greyed out. Once it appears, the "Alauda Container Platform Log Collector" v4.3.2 upgrade on a business cluster fails (`安装失败`, installation failed) with `wait resources ready`.

In each case one workload Pod of the plugin cannot become Ready, and the AppRelease (`ars`) waits for it until it times out. A plugin Pod that cannot pull its image is a different problem; see the related article below.

Related articles: "Operator or plugin ImagePullBackOff or exec format error: registry address, 401, architecture, or search domain on ACP" covers image pull failures; "Cluster plugin install or upgrade stuck in chart sync: sentry, StatefulSet Forbidden, hook Job, or missing ModuleConfig" covers failures before the workloads are created.

## Root Cause

### Cause 1: a DaemonSet Pod of the plugin is Pending with Insufficient cpu on one node

The chart waits for every Pod of its DaemonSets. When one node lacks the CPU that a DaemonSet Pod requests, that Pod stays `Pending` with `Insufficient cpu`, the DaemonSet has one Pod fewer ready than desired (for example `delete-multus-cfg-ds` in `kube-system` at 10/11), and the AppRelease stays in `WaitReady` until it times out. Once CPU is freed on that node, the Pod is scheduled and the installation completes.

### Cause 2: the log storage Pods on one node fail because /cpaas returns Input/output error

The log storage components (`cpaas-elasticsearch-<n>`, `cpaas-kafka-<n>`, `cpaas-zookeeper-<n>` in `cpaas-system`) keep their data under `/cpaas` on the node. When the filesystem behind `/cpaas` on one node fails, every log storage Pod scheduled there is `0/1`, and the upgrade never passes `CheckStatus-logcenter` (`prepare-logcenter-upgrade` has already completed). On that node, `ls` in `/cpaas` or `/cpaas/data` returns `ls: cannot open directory .: Input/output error` (or `cannot access 'data': Input/output error`).

When the I/O error is a transient fault of an LVM-based mount, rebooting the host restores `/cpaas`, and the log storage Pods recover on their own. When the underlying block device or its paths (for example a SAN or multipath device) are failing, a reboot does not help until the storage is repaired.

### Cause 3: nevermore cannot start, secret log-collector-bearer-auth not found, Log Essentials on global was not upgraded first

The Log Collector upgrade on the business cluster fails with `wait resources ready`, and the `nevermore` Pods in `cpaas-system` stay `0/4` `Init:0/1` with:

```text
Warning  FailedMount  MountVolume.SetUp failed for volume "callback-secret" : secret "log-collector-bearer-auth" not found
```

`kubectl get secret -A | grep log-collector` returns nothing on the business cluster.

The Secret `log-collector-bearer-auth` is distributed to business clusters by the "Alauda Container Platform Log Essentials" plugin on `global`. When Log Essentials on `global` is still on the previous release line (for example v4.2.9) while the business cluster plugins are upgraded to v4.3.2, the Secret does not exist yet. After Log Essentials is upgraded, `log-collector-bearer-auth` and `log-database-bearer-auth` are created in `cpaas-system` on the business cluster, and Log Collector and Log Storage for ClickHouse there finish their upgrade.

A greyed-out upgrade button after the packages were pushed is cleared by restarting `cluster-transformer` on `global`.

## Resolution

### Cause 1: a DaemonSet Pod of the plugin is Pending with Insufficient cpu on one node

1. Find the Pending Pod and the node it cannot fit on:

   ```bash
   kubectl get ars -A
   kubectl describe ars -n cpaas-system multus
   kubectl get ds -A | grep multus
   kubectl get pods -A --field-selector status.phase=Pending -o wide | grep multus
   kubectl -n kube-system describe pod <pending-pod> | grep -A5 Events
   ```

2. Check the allocation of the node named by the scheduler event, or of the node missing from the `-o wide` list:

   ```bash
   kubectl describe node <node-name> | grep -A10 'Allocated resources'
   ```

3. Free CPU requests on that node: move or scale down workloads that do not need to run there, or lower requests that are larger than needed. The Pending Pod schedules by itself.
4. Confirm that the DaemonSet is complete and the AppRelease leaves `WaitReady`:

   ```bash
   kubectl get ds -n kube-system delete-multus-cfg-ds
   kubectl get ars -n cpaas-system multus
   ```

### Cause 2: the log storage Pods on one node fail because /cpaas returns Input/output error

1. Find the node that runs the failing Pods:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep -E 'cpaas-elasticsearch|cpaas-kafka|cpaas-zookeeper'
   ```

2. On that node, confirm the I/O error and look at the storage stack under the mount:

   ```bash
   ls /cpaas /cpaas/data
   findmnt /cpaas /cpaas/data
   lsblk
   lvs
   dmesg -T | grep -iE 'i/o error|blk_update_request|xfs|ext4|dm-' | tail -30
   ```

   If the device is a multipath device, also check its paths with `multipath -ll`. Failed paths, or kernel messages that another process (for example a partitioning tool) has the device open exclusively for writing, point at the storage itself; involve the storage owner before rebooting.

3. Do not delete or clean `/cpaas/data` while it returns I/O errors; the data cannot be read in that state and may be needed after the storage is repaired.

4. Reboot the host.

   > **Warning:** Rebooting the host stops every Pod on it, including other log storage replicas and platform components scheduled there, until the node is back. Precondition: only when `/cpaas` on that node returns `Input/output error`, the failing log storage Pods are on that node, and the other nodes can carry the load meanwhile. Drain the node first where possible. Rollback: none for the reboot itself. If `/cpaas` still fails after the reboot, the disk, its paths, or the LVM volume is damaged; keep the `dmesg` output and involve the storage owner before touching the volume.

   ```bash
   kubectl cordon <node-name>
   kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
   systemctl reboot
   ```

5. After the node is back, confirm the mount and return the node to scheduling:

   ```bash
   ls /cpaas
   kubectl uncordon <node-name>
   kubectl -n cpaas-system get pods -o wide | grep -E 'cpaas-elasticsearch|cpaas-kafka|cpaas-zookeeper'
   ```

   The log storage Pods recover by themselves, and the upgrade passes `CheckStatus-logcenter`.

### Cause 3: nevermore cannot start, secret log-collector-bearer-auth not found, Log Essentials on global was not upgraded first

1. On the business cluster, confirm the mount failure and the missing Secret:

   ```bash
   kubectl get pod -A | grep nevermore
   kubectl -n cpaas-system describe pod <nevermore-pod> | grep -A3 FailedMount
   kubectl get secret -A | grep log-collector
   ```

2. On `global`, compare the version of Log Essentials with the logging plugins of the business cluster:

   ```bash
   kubectl get minfo | grep -i log
   ```

3. Upgrade "Alauda Container Platform Log Essentials" on `global` to the same release line (for example v4.3.2) from Cluster Plugins first.
4. Check that the Secrets arrived on the business cluster, then retry the business cluster plugin upgrade:

   ```bash
   kubectl get secret -n cpaas-system | grep -E 'log-collector-bearer-auth|log-database-bearer-auth'
   kubectl get pod -A | grep nevermore
   ```

5. If the upgrade button of a pushed version stays greyed out, restart `cluster-transformer` on `global`.

   > **Warning:** Restarting `cluster-transformer` pauses plugin synchronization until the new Pod is Ready. Precondition: only when the new plugin versions were pushed and the upgrade button stays greyed out. Rollback: none needed; the Deployment recreates the Pod.

   ```bash
   kubectl -n cpaas-system rollout restart deployment/cluster-transformer
   kubectl -n cpaas-system rollout status deployment/cluster-transformer
   ```

## Diagnostic Steps

1. List AppReleases that are not settled and read their reason:

   ```bash
   kubectl get ars -A | grep -v -E 'Synced|Ready'
   kubectl describe ars -n cpaas-system <ars-name> | grep -E 'Reason|Message'
   ```

   Expected for this article: Reason `NotReady` with `timed out waiting for the condition`, or a progress log that repeats `wait resources ready`.

2. Find the plugin Pod that is not Ready and read its events:

   ```bash
   kubectl get pods -A -o wide | grep -v -E 'Running|Completed'
   kubectl -n <namespace> describe pod <pod> | grep -A10 Events
   ```

   - `Pending` with `Insufficient cpu`: Cause 1.
   - Several log storage Pods failing on one node whose `/cpaas` returns `Input/output error`: Cause 2.
   - `nevermore` in `Init` with `secret "log-collector-bearer-auth" not found`: Cause 3.
   - `ImagePullBackOff` or `ErrImagePull`: not this article; see the image pull article named above.

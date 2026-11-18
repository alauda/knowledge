---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.2"
  - "4.3"
---

# No default etcd backup on ACP: Cluster Enhancer not installed or etcd-backup-default not created

## Issue

- An inspection finds no etcd backup on a cluster. After the Cluster Enhancer plugin is installed, `kubectl get ebc -A` is empty and `kubectl get acj,bcj -A | grep -i etcd` shows no backup job.
- Creating the default backup by hand fails: `kubectl create -f ebc.yaml` for `etcd-backup-default` returns `Error from server (MethodNotAllowed): error when creating "ebc.yaml": the server does not allow this method on the requested resource` (HTTP 405).
- On a 4.2.1 `global` cluster the etcd backup feature is missing, and the monitoring dashboard list shows only `container-platform`, `log`, and `monitor`, without `cluster` and `kubernetes`.
- After the platform moved from 3.16 to 4.2, it is unclear whether the etcd backup policy reached the workload clusters, including workload clusters still on 3.16.

Related articles: "etcd backup dates missing in the console, backup tab gone, duplicate copies, or retention to change on ACP" covers an existing backup configuration; "Scheduled etcd backups stop after an upgrade because the etcd-backup-default AdvancedCronJob stops triggering on ACP" covers backups that stop.

## Root Cause

### Cause 1: Cluster Enhancer is installed but does not create the default backup until create-etcd-backup-default is true

The default etcd backup (`EtcdBackupConfiguration`, short name `ebc`, named `etcd-backup-default`) is created by the Cluster Enhancer API Deployment (its name contains `cluster-enhancer-api`) only when its argument `--create-etcd-backup-default` is `true`. Without it, no `ebc` and no backup jobs exist, and the object cannot be created by hand because the API does not allow `create` (`MethodNotAllowed`). Setting the argument to `true` creates the object. For example, on a 4.3 cluster with the `Alauda Container Platform Cluster Enhancer` plugin `v4.3.0`, `kubectl get ebc -A` then lists `etcd-backup-default` with schedule `0 0 * * *`, PAUSED `false`, local path `/cpaas/backup`, TTL `604800`, and 0 records. When the default backup path is also missing, the argument `--default-etcd-backup-path=<path>` (for example `/var/cpaas/backup`) is added next to it.

### Cause 2: the Cluster Enhancer plugin is not installed on the cluster

etcd backup rules come from the `Alauda Container Platform Cluster Enhancer` cluster plugin, which backs up etcd data, monitors certificates, cleans up events, and provides the `cluster` and `kubernetes` monitoring dashboards. A cluster without the plugin has neither the etcd backup feature nor those two dashboards. After the plugin is installed (for example version `v4.2.6` on 4.2.1), the dashboard list shows `container-platform`, `cluster`, `log`, `monitor`, and `kubernetes`, and etcd backup is available through `EtcdBackupConfiguration`.

The policy is per cluster: deploying the etcd backup plugin on the global cluster after an upgrade from 3.16 to 4.2 does not push the policy onto every workload cluster. Backup rules exist on the clusters where Cluster Enhancer is deployed after the 4.2 upgrade, and workload clusters left on 3.16 keep their 3.16 backup rules.

## Resolution

### Cause 1: Cluster Enhancer is installed but does not create the default backup until create-etcd-backup-default is true

1. Confirm that the plugin is installed, no `ebc` exists, and find the Deployment:

   ```bash
   kubectl get mplugin cluster-enhancer -o yaml | grep -iE 'version|status' | head
   kubectl get ebc -A
   kubectl get acj,bcj -A | grep -i etcd || true
   kubectl get deploy -A | grep cluster-enhancer-api
   kubectl -n <namespace> get deploy <cluster-enhancer-api> -o jsonpath='{.spec.template.spec.containers[*].args}{"\n"}'
   ```

2. Save the Deployment:

   ```bash
   kubectl -n <namespace> get deploy <cluster-enhancer-api> -o yaml > /tmp/cluster-enhancer-api.yaml
   ```

3. Set `--create-etcd-backup-default=true` in the container arguments, and add `--default-etcd-backup-path=<path>` if no default backup path is configured.

   > **Warning:** Editing the Deployment restarts the Cluster Enhancer API Pods; backup and enhancement API calls pause until the new Pods are Ready. Precondition: only when the default etcd backup objects are absent and the argument is not already `true`. Rollback: `kubectl apply -f /tmp/cluster-enhancer-api.yaml`.

   ```bash
   kubectl -n <namespace> edit deploy <cluster-enhancer-api>
   kubectl -n <namespace> rollout status deploy <cluster-enhancer-api>
   ```

4. Check that the default backup now exists:

   ```bash
   kubectl get ebc -A
   ```

   Expected: `etcd-backup-default` with a schedule, PAUSED `false`, a local path, and a TTL.

### Cause 2: the Cluster Enhancer plugin is not installed on the cluster

1. Check whether the plugin and a backup configuration exist on the cluster in question:

   ```bash
   kubectl get deploy -A | grep cluster-enhancer
   kubectl get etcdbackupconfiguration -A
   ```

2. Install the `Alauda Container Platform Cluster Enhancer` cluster plugin from **Administrator → Marketplace → Cluster Plugins** for that cluster.
3. Check the dashboard list (it should now include `cluster` and `kubernetes`) and run `kubectl get etcdbackupconfiguration -A` again. If no default object appears, continue with Cause 1.
4. To change a backup rule, edit `EtcdBackupConfiguration` on the cluster whose rule you mean to change. A workload cluster still on 3.16 keeps its existing 3.16 backup configuration.

## Diagnostic Steps

```bash
kubectl get deploy -A | grep cluster-enhancer
kubectl get ebc -A
kubectl get acj,bcj -A | grep -i etcd
```

- Cluster Enhancer Deployments present, `ebc` empty, or `MethodNotAllowed` (405) when creating an `ebc` by hand: Cause 1. Expected: the `cluster-enhancer-api` arguments do not contain `--create-etcd-backup-default=true`.
- No Cluster Enhancer Deployment on the cluster, no etcd backup, and no `cluster` or `kubernetes` dashboards: Cause 2.
- An `ebc` exists and backups ran before but stopped: see "Scheduled etcd backups stop after an upgrade because the etcd-backup-default AdvancedCronJob stops triggering on ACP".

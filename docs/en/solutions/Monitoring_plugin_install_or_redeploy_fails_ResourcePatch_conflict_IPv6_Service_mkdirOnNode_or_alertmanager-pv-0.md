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

# Monitoring plugin install or redeploy fails: ResourcePatch conflict, IPv6 Service, mkdirOnNode, or alertmanager-pv-0

## Issue

Installing, redeploying or running the platform monitoring plugin (Prometheus or VictoriaMetrics) fails in one of these ways:

- A VictoriaMetrics redeploy fails because the new vmagent objects are not created; a VictoriaMetrics uninstall stays in Uninstalling; or the Prometheus plugin shows `部署中` (deploying) forever.
- The monitoring AppRelease fails with an error that requires an IPv6 address on an IPv4 single-stack cluster.
- VictoriaMetrics install fails in `mkdirOnNode` with an invalid Pod name that contains a space, such as `<node-name>- -var-cpaas-monitoring-alertmanager`, and `metadata.name: Invalid value` against the RFC 1123 subdomain rule.
- A VictoriaMetrics install waits on an unbound PVC because PV `alertmanager-pv-0` was never created.
- On a standby global cluster with high-availability Prometheus, `prometheus-1` and `prometheus-2` are rebuilt again and again, and an alert reports Prometheus status 0.

Related article: [Monitoring plugin uninstall or Prometheus to VictoriaMetrics switch leaves ModuleInfo, AppRelease, or Pods on ACP](Monitoring_plugin_uninstall_or_Prometheus_to_VictoriaMetrics_switch_leaves_ModuleInfo_AppRelease_or_Pods_on_ACP.md).

## Root Cause

### Cause 1: leftover ResourcePatch (rpch) records conflict with the monitoring objects

Earlier changes to monitoring components left `rpch` records (sentry resource patches). They conflict with newly deployed objects, so a VictoriaMetrics redeploy does not create the new vmagent resources. The same records block other transitions: a VictoriaMetrics uninstall stays in Uninstalling while `Active` records of release `cpaas-system/victoriametrics` target VMAgent `agent`, VMCluster `cluster` and PersistentVolume `alertmanager-pv-0`. A Prometheus plugin stays in deploying when an `rpch` of release `cpaas-system/kube-prometheus` targets PersistentVolume `prometheus-pv-0` with a `jsonPatch` that adds `/metadata/deletionTimestamp` and `/metadata/deletionGracePeriodSeconds: 0`, so it keeps re-applying a delete to the PV.

### Cause 2: a Kyverno policy writes IPv6 into Services on an IPv4 cluster

The cluster has no IPv6. A Kyverno policy mutates `Service` objects and writes an IPv6 `ipFamilies` (or a similar IPv6 field), and the monitoring chart then fails to create its Service.

### Cause 3: the LocalVolume storage path has a leading space

The installer builds the temporary directory-init Pod name from the node name and the LocalVolume `storage.path`, and does not strip spaces. A value of `" /var/cpaas/monitoring"` instead of `/var/cpaas/monitoring` produces an invalid name.

### Cause 4: an old Prometheus PVC still holds the alertmanager-pv name

An old Prometheus PVC is still bound to a PV that uses the same name pattern, `alertmanager-pv-<n>`, that the VictoriaMetrics deployment wants to create, so `alertmanager-pv-0` is not created and the new PVC stays unbound.

### Cause 5: the standby global etcd sync overwrites prometheus-1 and prometheus-2

In a primary/standby global setup, `etcd-mirror` Pods in `kube-system` sync etcd from the primary to the standby. ConfigMap `etcd-sync-ignore-text` in `kube-system` has ignore entries only for `prometheus-0` (`/registry/secrets/cpaas-system/prometheus-kube-prometheus-0`, `...-0-tls-assets`, `...-0-web-config`, `/registry/monitoring.coreos.com/prometheuses/cpaas-system/kube-prometheus-0`), so the sync keeps overwriting the objects of the other two replicas. This is a known issue.

## Resolution

### Cause 1: leftover ResourcePatch (rpch) records conflict with the monitoring objects

1. Check for Pods stuck in `Terminating`, then list and back up the monitoring `rpch` records on the business cluster:

   ```bash
   kubectl get pods -A | grep -E 'vm|prometheus' | grep Terminating
   kubectl get rpch -A | grep -Ei 'vm|prometheus'
   kubectl get rpch -A -o yaml > /tmp/rpch-backup.yaml
   kubectl get rpch -n <namespace> <rpch-name> -o yaml | grep -n -E 'release|kind|name:|deletionTimestamp'
   ```

2. Delete only the records that belong to the monitoring release and target the objects that are not being created or deleted.

   > **Warning:** Deleting an `rpch` drops that sentry patch; an intentional customization stored only in it is gone on the next reconcile. Precondition: the deploy, redeploy or uninstall is not progressing, and the records belong to VictoriaMetrics or Prometheus monitoring objects. Rollback: `kubectl apply -f /tmp/rpch-backup.yaml`.

   ```bash
   kubectl delete rpch -n <namespace> <rpch-name>
   ```

3. The components are created and reach Running, the uninstall completes, or the plugin changes to `部署成功` (deployed). Retry the redeploy if it does not continue by itself.

### Cause 2: a Kyverno policy writes IPv6 into Services on an IPv4 cluster

1. Find the policy whose mutation writes IPv6 into Services:

   ```bash
   kubectl get policy,clusterpolicy -A
   kubectl -n cpaas-system get svc -o yaml | grep -n -i ipfamil
   ```

2. Remove that policy, or rewrite its mutation so it no longer injects IPv6.

   > **Warning:** Deleting a Kyverno policy stops that control for every object it matched, not only the monitoring Service. Precondition: the policy YAML is saved and its mutation is the IPv6 field the AppRelease rejected. Rollback: `kubectl apply -f /tmp/kyverno-policy-backup.yaml`.

   ```bash
   kubectl get clusterpolicy <policy-name> -o yaml > /tmp/kyverno-policy-backup.yaml
   kubectl delete clusterpolicy <policy-name>
   ```

   Use `policy -n <namespace>` for a namespaced policy. The next reconcile creates the Service with IPv4 only and the AppRelease becomes Ready.

### Cause 3: the LocalVolume storage path has a leading space

The init Pod was rejected by the API, so there is nothing to delete. Correct the LocalVolume storage path in the VictoriaMetrics install parameters (`spec.config.storage.path` on the ModuleInfo) so it has no leading or trailing space, then install again:

```text
storage.path: /var/cpaas/monitoring
```

The default path is `/cpaas/monitoring`; on Alauda OS it is `/var/cpaas/monitoring`.

### Cause 4: an old Prometheus PVC still holds the alertmanager-pv name

```bash
kubectl get pvc -A | grep -Ei 'alertmanager|prome'
kubectl get pv | grep alertmanager-pv
```

> **Warning:** Deleting the old Prometheus PVC also deletes its PV, and the old Alertmanager data on it is gone. Precondition: the PV `alertmanager-pv-<n>` is bound to a PVC of the earlier Prometheus deployment and the VictoriaMetrics PVC waits for that name. Copy the data off first if it is needed. There is no rollback after the PV is deleted.

```bash
kubectl -n <namespace> delete pvc <old-prometheus-alertmanager-pvc>
```

The VictoriaMetrics deployment then creates `alertmanager-pv-<n>` itself and the PVC binds.

### Cause 5: the standby global etcd sync overwrites prometheus-1 and prometheus-2

1. Check the ignore list:

   ```bash
   kubectl get cm -n kube-system etcd-sync-ignore-text -o yaml | grep prome
   ```

2. Recommended: reinstall Prometheus on that global cluster as single-node instead of high-availability.

   > **Warning:** Reinstalling Prometheus stops monitoring on that cluster until the new install is Ready, and history is not carried over unless the volumes are reused. Precondition: the rebuilt Pods are `prometheus-1` and `prometheus-2` on the standby global and the ignore list lacks them. Rollback: reinstall in the previous mode.

3. Alternative: add ignore entries for `prometheus-1` and `prometheus-2` under `data.ignore-equal.txt`, copying the format of the existing `prometheus-0` entries.

   > **Warning:** Editing `etcd-sync-ignore-text` creates an `rpch`, which may block later upgrades. Precondition: same signature as above, and a saved copy. Rollback: `kubectl apply -f /tmp/etcd-sync-ignore-text.yaml`, then remove the generated `rpch`.

   ```bash
   kubectl get cm -n kube-system etcd-sync-ignore-text -o yaml > /tmp/etcd-sync-ignore-text.yaml
   kubectl edit cm -n kube-system etcd-sync-ignore-text
   ```

## Diagnostic Steps

1. Read the module and release state:

   ```bash
   kubectl get minfo -A | grep -Ei 'prometheus|victoriametrics'
   kubectl -n cpaas-system get ars
   kubectl get rpch -A | grep -Ei 'vm|prometheus'
   ```

2. A redeploy, uninstall or "deploying" state that does not progress, with monitoring `rpch` records present: Cause 1. A record whose `jsonPatch` adds `deletionTimestamp` to a PV is the deploying variant.

3. An AppRelease error about IPv6 on a single-stack cluster: Cause 2.

4. `mkdirOnNode` and an RFC 1123 name with a space in it: Cause 3. Expected after the fix: the install proceeds past `mkdirOnNode`.

5. A PVC waiting for `alertmanager-pv-0` while an old Prometheus PVC holds an `alertmanager-pv-<n>` volume: Cause 4.

6. `prometheus-1` and `prometheus-2` rebuilt in a loop only on the standby global, with only `prometheus-0` in `etcd-sync-ignore-text`: Cause 5.

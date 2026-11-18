---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.2"
  - "4.3"
---

# etcd-sync check reports localMissedKeys or localSurplusKeys, or what a primary/standby global pair replicates on ACP

## Issue

On the standby global cluster of a primary/standby (disaster recovery) setup, the sync check of the etcd Synchronizer (`curl "http://<etcd-sync-monitor-clusterip>/check"`) or a daily inspection lists keys under `LOCAL ETCD missed keys` / `localMissedKeys` or `LOCAL ETCD surplus keys` / `localSurplusKeys`, and it is not clear whether they need action. Examples:

- Right after disaster recovery is set up: `localMissedKeys [0]` and `localSurplusKeys [2]`, the two keys being `/registry/auth.alauda.io/disabletokens/<name>` and `/registry/monitoring.coreos.com/servicemonitors/cpaas-system/etcd-sync-monitor`.
- A daily inspection with `localMissedKeys [4]` and `localSurplusKeys [88]`.
- `/registry/secrets/cpaas-logging/clickhouse-operator` stays in the missed list after the `etcd-sync` Pod is restarted several times.
- Dozens of missed keys under `/registry/ait.alauda.io/notifications/...`, or a question about which objects the pair replicates, or whether the nodes of the two clusters need full network connectivity.

Missed keys exist on the primary and not on the standby. Surplus keys exist only on the standby.

Related articles: "etcd Synchronizer plugin install stuck or etcd-sync does not start on the standby global cluster on ACP"; "etcd-sync Pod stuck in ContainerCreating with failed to sync secret cache on the standby global cluster on ACP".

## Root Cause

### Cause 1: platform surplus keys and rotated platform objects are expected differences

Some keys differ between the clusters by design and need no action:

- `/registry/monitoring.coreos.com/servicemonitors/cpaas-system/etcd-sync-monitor`: the ServiceMonitor of the etcd Synchronizer, which is installed only on the standby, so the primary has no such key.
- `/registry/auth.alauda.io/disabletokens/<name>`: created when an account logs out, to ban that user's unexpired tokens.
- dex `authrequests` and `refreshtokens`, and `auth.alauda.io` sessions and groups.
- Rotated certificate and token Secrets in platform namespaces, for example `cpaas-system/dex.tls-*`, `etcd-ca-*`, `base-operator.tls-*`, `argocd-manager-token-*`, and operator service certificates such as `<operator-namespace>/<operator>-service-cert`.
- Platform alert and monitoring rules (`ait.alauda.io/alertrules/cpaas-system/cpaas-*-rules`, `monitoring.coreos.com/prometheusrules/cpaas-system/cpaas-*-rules`, `operator.victoriametrics.com/vmrules/cpaas-system/cpaas-*-rules`), and the etcd-sync monitor dashboard.
- Inspection results (`ait.alauda.io/inspections/inspection-<date>-<id>` and `inspectiondetails/...`), a `cluster.alauda.io/moduleinfoes/<name>` entry, and an empty `productentries` key.

With `localMissedKeys [0]`, the synchronization is normal; surplus keys from the list above do not affect business workloads or platform use. A daily inspection whose 4 missed and 88 surplus keys all fall into these classes needs no handling either.

### Cause 2: a few missed keys clear after the etcd-sync leader Pod is restarted

Missed keys are often caused by garbage collection during synchronization, when objects arrive in an order that leaves their owner references unresolved. Restarting the current etcd-sync leader Pod runs a full sync again and clears them.

### Cause 3: the clickhouse-operator Secret stays missed and a restart does not create it

`localMissedKeys [1]`: `/registry/secrets/cpaas-logging/clickhouse-operator`, a Secret with an `ownerReferences` entry of kind `ClusterServiceVersion` (for example `clickhouse-operator.v4.2.1`). Restarting the `etcd-sync` Pod more than once leaves the key missing. The standby copy has to be created by hand, with its owner reference pointing to the CSV on the standby.

### Cause 4: plugins, feature gates, component YAML edits, OperatorHub installs, and customized keys are not in the sync set

From 4.2 on, the sync program runs on the standby cluster and pulls from the primary: a full sync when it starts, then incremental sync. Only the keys listed in the ConfigMap that the sync workload mounts are replicated. Installed plugins, feature-gate settings, YAML edits of platform components, and OperatorHub installs are not replicated; each of those changes has to be applied on both clusters. Customized keys are also outside the set, for example custom notification objects (`/registry/ait.alauda.io/notificationgroups/<namespace>/...`, `notifications/...`, `notificationtemplates/...`). Their absence on the standby is expected, not a failed sync.

Losing one primary etcd member does not stop synchronization. Losing two or more interrupts it until the primary recovers; the sync Pod restart then runs a full sync again.

### Cause 5: which network the primary and standby global clusters need

The two clusters do not need full node-to-node connectivity. The reference design:

- Both global clusters are installed with the same platform access domain. Normally it resolves to the primary cluster's VIP; on failover it is re-resolved to the standby cluster's VIP.
- Each cluster has its own VIP, and each VIP forwards TCP `443` (and `80` when the platform is accessed over HTTP), `6443`, `2379` (unless the etcd endpoints are reached directly), and `11443` to that cluster's own control-plane nodes.
- Those ports are allowed in both directions between the primary and standby networks, because the roles reverse after failover.
- etcd data is copied from the primary to the standby by the etcd Synchronizer.

## Resolution

### Cause 1: platform surplus keys and rotated platform objects are expected differences

Compare each listed key with the classes above. If `localMissedKeys` is `0` and every surplus key belongs to those classes, no action is needed. Do not delete these keys from the standby. Only a difference in a key that the business itself writes needs to be reviewed with the operations team before anything is deleted.

### Cause 2: a few missed keys clear after the etcd-sync leader Pod is restarted

1. Find the current leader Pod:

   ```bash
   kubectl get po -n cpaas-system -l app=etcd-sync
   kubectl get lease -n cpaas-system etcd-sync-mirror -o jsonpath='{.spec.holderIdentity}{"\n"}'
   ```

   On versions without this Lease, restart one of the `etcd-sync` Pods.

2. Restart it.

   > **Warning:** Deleting the leader Pod restarts the sync process; synchronization pauses until a Pod takes over and runs a full sync. Precondition: only when the missed list is small and does not name a key covered by Cause 3. Rollback: none needed; the Deployment recreates the Pod.

   ```bash
   kubectl delete pod -n cpaas-system <etcd-sync-leader-pod>
   ```

3. Run the check again. A business key that is still missing after the restart is Cause 3 or Cause 4, not a reason for further restarts.

### Cause 3: the clickhouse-operator Secret stays missed and a restart does not create it

1. On the primary, export the Secret. On the standby, read the uid of the ClickHouse operator CSV:

   ```bash
   # primary
   kubectl -n cpaas-logging get secret clickhouse-operator -o yaml > /tmp/clickhouse-operator.secret.yaml
   # standby
   kubectl -n cpaas-logging get csv | grep -i clickhouse
   kubectl -n cpaas-logging get csv <clickhouse-csv-name> -o jsonpath='{.metadata.uid}{"\n"}'
   ```

2. In the saved file, remove `metadata.creationTimestamp`, `metadata.resourceVersion`, `metadata.uid`, and `metadata.managedFields`, and set the `uid` under `ownerReferences` (kind `ClusterServiceVersion`) to the standby CSV uid just printed. Use the CSV name that `get csv` shows on the standby.
3. Apply it on the standby.

   > **Warning:** This creates or overwrites `clickhouse-operator` in `cpaas-logging` on the standby. Precondition: only when that name is the missed key and an `etcd-sync` restart did not create it. A wrong owner uid leaves the operator unable to adopt the Secret. Rollback: `kubectl -n cpaas-logging delete secret clickhouse-operator` if the apply created it; if a Secret existed before, save it first and re-apply that copy.

   ```bash
   kubectl apply -f /tmp/clickhouse-operator.secret.yaml
   ```

   Expected: `secret/clickhouse-operator created`. Run the check again; the key is no longer listed.

### Cause 4: plugins, feature gates, component YAML edits, OperatorHub installs, and customized keys are not in the sync set

1. Read the sync scope from the ConfigMap that the sync workload mounts, on the cluster that runs the sync program:

   ```bash
   kubectl get deploy -n cpaas-system | grep -E 'etcd-sync|etcd-mirror'
   kubectl -n cpaas-system get deploy <sync-deployment> -o jsonpath='{.spec.template.spec.volumes}{"\n"}'
   kubectl -n cpaas-system get configmap <mounted-configmap> -o yaml
   ```

2. Apply plugin installs, feature-gate changes, platform component YAML edits, and OperatorHub installs on the other global cluster as well.
3. Handle missing customized keys with the team that owns the customization; they are not synchronized automatically.
4. Before a planned switchover, take an etcd backup on both the active and the standby cluster.

### Cause 5: which network the primary and standby global clusters need

From a host outside each cluster, check that the VIP forwards the ports to its own control-plane nodes, once for the primary VIP and once for the standby VIP:

```bash
for p in 443 6443 2379 11443; do nc -vz -w 3 <cluster-vip> $p; done
```

Also check the same ports from the standby network to the primary and back.

## Diagnostic Steps

Run the sync check on a control-plane node of the standby global cluster. The ClusterIP of the `etcd-sync-monitor` Service is wrapped in brackets when it is IPv6:

```bash
mirror_svc=$(kubectl get svc -n cpaas-system etcd-sync-monitor -o jsonpath='{.spec.clusterIP}')
if [[ $mirror_svc =~ ^[0-9a-fA-F:]+$ ]]; then mirror_host="[$mirror_svc]"; else mirror_host="$mirror_svc"; fi
curl -g "http://${mirror_host}/check"
```

- `localMissedKeys [0]` and only platform surplus keys such as `etcd-sync-monitor` and `disabletokens`: Cause 1, normal.
- A few missed keys of platform objects: Cause 2.
- `clickhouse-operator` still missed after a restart: Cause 3.
- Missing plugins, feature gates, or customized keys such as `ait.alauda.io/notifications`: Cause 4.
- A question about network connectivity between the two clusters: Cause 5.

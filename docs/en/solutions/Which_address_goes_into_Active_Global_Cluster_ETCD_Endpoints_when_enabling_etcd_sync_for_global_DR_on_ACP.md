---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x
---

# Which address goes into Active Global Cluster ETCD Endpoints when enabling etcd sync for global DR on ACP

## Issue

While deploying a standby `global` cluster for disaster recovery (DR), the last installation step is to enable etcd synchronization. On the standby cluster's Web Console, under **Marketplace** > **Cluster Plugins** with the `global` cluster selected, the **etcd Synchronizer** plugin is installed with these parameters:

- **Active Global Cluster VIP**
- **Active Global Cluster ETCD Endpoints**
- **Standby Cluster ETCD Endpoints**
- **Active Global Cluster Token Secret**
- **Data Check Interval**
- **Print detail logs**

The installation guide only says to "configure **Active Global Cluster ETCD Endpoints** correctly" when port `2379` is not forwarded through a load balancer, and it is not obvious which address that field expects: the active cluster or the standby cluster, a VIP or the individual control plane nodes.

## Root Cause

### Cause 1: the field names the etcd of the active cluster, reached through its VIP on port 2379

The etcd Synchronizer runs on the **standby** `global` cluster. It reads etcd data from the **active** (primary) `global` cluster on port `2379` and writes it into the standby cluster's local etcd. **Active Global Cluster ETCD Endpoints** tells it where to read from, so it must point at the active cluster, not at the standby. The value is the VIP of the active `global` cluster followed by port `2379`, for example `https://<active-global-vip>:2379`.

**Standby Cluster ETCD Endpoints** is the local side and normally keeps its default value.

## Resolution

### Cause 1: the field names the etcd of the active cluster, reached through its VIP on port 2379

1. On the **active** `global` cluster, read the bearer token that the standby cluster uses to access the active cluster's API server:

   ```bash
   kubectl -n cpaas-system get secret k8sadmin -o jsonpath='{.data.token}' | base64 -d
   ```

2. On the **standby** `global` cluster, store that token in the `etcd-sync-active-cluster-token` Secret, under the data key `token`:

   ```bash
   ACTIVE_CLUSTER_TOKEN='<paste-the-token-from-the-active-cluster>'
   kubectl -n cpaas-system create secret generic etcd-sync-active-cluster-token \
     --from-literal=token="${ACTIVE_CLUSTER_TOKEN}" \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

3. Make sure the standby cluster's control plane nodes can reach port `2379` on the active cluster's VIP over TCP (see Diagnostic Steps). If a load balancer is used for this port, it must forward in TCP mode; L7 forwarding is not supported.

4. Open the **standby** cluster's Web Console through its own VIP, switch to the **Administrator** view, go to **Marketplace** > **Cluster Plugins**, select the `global` cluster, and install the **etcd Synchronizer** plugin with:

   | Parameter | Value |
   | --- | --- |
   | Active Global Cluster VIP | VIP of the active `global` cluster |
   | Active Global Cluster ETCD Endpoints | VIP of the active `global` cluster with port `2379`, for example `https://<active-global-vip>:2379` |
   | Standby Cluster ETCD Endpoints | Default value, unless the local etcd is exposed through a different endpoint |
   | Active Global Cluster Token Secret | `etcd-sync-active-cluster-token` |
   | Data Check Interval | Default value |
   | Print detail logs | Disabled, unless troubleshooting |

5. During installation the `etcd-sync-bootstrap` Job runs before the `etcd-sync` Deployment starts. Verify the Job and the resources it prepares, on the standby cluster:

   ```bash
   kubectl get job -n cpaas-system etcd-sync-bootstrap
   kubectl logs -n cpaas-system job/etcd-sync-bootstrap
   kubectl get secret -n cpaas-system remote-etcd-ca
   kubectl get issuer -n cpaas-system remote-etcd-issuer
   kubectl get certificate -n cpaas-system remote-etcd-client
   kubectl get secret -n cpaas-system remote-etcd-client
   ```

6. Verify that the sync Pods run and that the leader has started syncing:

   ```bash
   kubectl get po -n cpaas-system -l app=etcd-sync
   leader_pod=$(kubectl get lease -n cpaas-system etcd-sync-mirror -o jsonpath='{.spec.holderIdentity}')
   kubectl logs -n cpaas-system "$leader_pod" | grep -E "Acquired leader lease|Start Sync update"
   ```

## Diagnostic Steps

1. From a control plane node of the **standby** cluster, check that port `2379` on the active cluster's VIP accepts TCP connections:

   ```bash
   nc -vz -w 3 <active-global-vip> 2379
   ```

   Expected: the connection succeeds. A timeout or `Connection refused` means the standby cluster cannot reach the active etcd through that address, and the network path or load balancer forwarding has to be fixed before the plugin can sync.

2. Check the values the plugin was installed with. **Active Global Cluster VIP** and **Active Global Cluster ETCD Endpoints** must both refer to the **active** cluster; **Standby Cluster ETCD Endpoints** refers to the standby cluster.

3. Check that the token Secret exists on the standby cluster and holds the key `token`:

   ```bash
   kubectl -n cpaas-system get secret etcd-sync-active-cluster-token -o jsonpath='{.data}' | grep -o '"token"'
   ```

   Expected output: `"token"`.

4. Check the leader's log on the standby cluster. Expected: `Acquired leader lease` followed by `Start Sync update`. If the sync Pods do not start at all, see [etcd-sync Pod stuck in ContainerCreating with failed to sync secret cache on the standby global cluster on ACP](etcd-sync_Pod_stuck_in_ContainerCreating_with_failed_to_sync_secret_cache_on_the_standby_global_cluster_on_ACP.md).

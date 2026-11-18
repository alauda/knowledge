---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.2"
---

# etcd Synchronizer plugin install stuck or etcd-sync does not start on the standby global cluster on ACP

## Issue

The etcd Synchronizer cluster plugin of a primary/standby (disaster recovery) global setup does not come up on the standby global cluster:

- Installing or reinstalling the plugin (Administrator → Marketplace → Cluster Plugins → `global`) stays in the installing state, and `kubectl get ars -A` shows:

  ```text
  cpaas-system   etcd-sync   ChartValuesRenderFailed   failed to render values for chart ait/chart-etcd-sync-v4.2.1, err: run script error: exit status 2, stderr: base64: invalid input...
  ```

- During a disaster-recovery upgrade (for example 4.0.9 to 4.2.4) the sync plugin is deployed on the standby global cluster and never becomes Ready.
- `etcd-sync` fails to deploy while the historical primary cluster still runs an `etcd-mirror` Deployment.
- The `ars` of the plugin on the standby times out calling the etcd sync API.
- The plugin has to be removed or installed again with `kubectl`.

Related articles: "etcd-sync check reports localMissedKeys or localSurplusKeys, or what a primary/standby global pair replicates on ACP" covers a running synchronizer; "etcd-sync Pod stuck in ContainerCreating with failed to sync secret cache on the standby global cluster on ACP" covers `invalid padding on input`.

## Root Cause

### Cause 1: ChartValuesRenderFailed with base64: invalid input because the token was entered in plaintext

The installation takes a token for the active global cluster as a parameter. The chart's values-rendering script expects that token base64-encoded and decodes it. A plaintext token makes the script fail with `base64: invalid input`, the AppRelease stays in `ChartValuesRenderFailed`, and the installation never reaches the point of creating Pods. Replacing the token with its base64-encoded form lets the installation complete.

On plugin versions that read the token from the `etcd-sync-active-cluster-token` Secret instead of a parameter, the Secret is created from the plaintext token as the installation documentation describes.

### Cause 2: Secret etcd-ca is missing in cpaas-system, the sync plugin does not start

The sync plugin needs the Secret `etcd-ca` in `cpaas-system`. When it is missing on the primary and the standby (for example after a 4.0.9 to 4.2.4 disaster-recovery upgrade), the plugin deployed on the standby does not become Ready. Creating the Secret on both clusters from the etcd CA certificate and key, then redeploying the plugin, brings it up.

### Cause 3: a leftover etcd-mirror Deployment on the historical primary blocks etcd-sync

An `etcd-mirror` Deployment from an earlier synchronization setup is still running on the cluster that used to be the primary. It is not the current sync plugin, and while it exists, `etcd-sync` fails to deploy. Deleting the leftover Deployment clears the install.

### Cause 4: the plugin was installed while the platform domain still resolved to the standby

The standby cluster is installed while the platform domain temporarily points at the standby VIP, and the domain has to point back at the primary VIP before the etcd Synchronizer is installed. When the plugin is installed while the domain still resolves to the standby, the standby's `ars` times out calling the etcd sync API. After the domain resolves to the primary again and the plugin is redeployed, the timeout clears.

### Cause 5: the plugin is installed and uninstalled through its ModuleInfo

The etcd Synchronizer, like other cluster plugins, is represented by a ModuleInfo (`minfo`). Deleting that object uninstalls the plugin, and creating it again installs it.

## Resolution

### Cause 1: ChartValuesRenderFailed with base64: invalid input because the token was entered in plaintext

1. Confirm the render failure:

   ```bash
   kubectl get ars -n cpaas-system etcd-sync
   kubectl describe ars -n cpaas-system etcd-sync | grep -iE 'reason|message|base64'
   ```

2. Encode the token without a trailing newline:

   ```bash
   echo -n '<active-cluster-token>' | base64 -w0; echo
   ```

3. Enter the encoded value as the token in the plugin's installation parameters and install again.
4. Check that the AppRelease leaves the failed state and the Pods run:

   ```bash
   kubectl get ars -n cpaas-system etcd-sync
   kubectl get po -n cpaas-system -l app=etcd-sync
   ```

### Cause 2: Secret etcd-ca is missing in cpaas-system, the sync plugin does not start

1. On the primary and on the standby, check the Secret and the CA files on a control-plane node:

   ```bash
   kubectl get secret -n cpaas-system etcd-ca
   sudo ls -l /etc/kubernetes/pki/etcd/ca.crt /etc/kubernetes/pki/etcd/ca.key
   ```

2. On each cluster where it is missing, create it from that cluster's etcd CA.

   > **Warning:** The Secret stores the etcd CA private key in `cpaas-system`. Precondition: only when `etcd-ca` is missing and the plugin does not start; if the Secret exists, do not recreate it. Rollback: `kubectl delete secret -n cpaas-system etcd-ca` for a Secret this command just created; do not delete one that other components already use.

   ```bash
   kubectl create secret tls etcd-ca \
     --cert=/etc/kubernetes/pki/etcd/ca.crt \
     --key=/etc/kubernetes/pki/etcd/ca.key \
     -n cpaas-system
   ```

3. Redeploy the sync plugin after both clusters have the Secret.

### Cause 3: a leftover etcd-mirror Deployment on the historical primary blocks etcd-sync

1. On the historical primary cluster, not on the standby, find the leftover:

   ```bash
   kubectl get deploy -A | grep etcd-mirror
   ```

2. Save and delete it.

   > **Warning:** Deleting `etcd-mirror` stops that old sync process. Precondition: only the leftover Deployment on the historical primary, only while the `etcd-sync` install is failing. Do not delete an `etcd-sync` Deployment in this step. Rollback: `kubectl apply -f /tmp/etcd-mirror.yaml`.

   ```bash
   kubectl -n <namespace> get deploy etcd-mirror -o yaml > /tmp/etcd-mirror.yaml
   kubectl -n <namespace> delete deploy etcd-mirror
   ```

3. Retry the etcd-sync install.

### Cause 4: the plugin was installed while the platform domain still resolved to the standby

1. Check where the platform domain resolves, from a standby node and from inside the cluster:

   ```bash
   getent hosts <platform-domain>
   kubectl exec -n cpaas-system deployments/sentry -- nslookup <platform-domain>
   kubectl get ars -A | grep -i etcd
   ```

2. Point the domain at the primary global cluster's VIP.
3. Redeploy the etcd Synchronizer on the standby global cluster, as the installation documentation describes, and check that the `ars` timeout is gone.

### Cause 5: the plugin is installed and uninstalled through its ModuleInfo

1. Find the object:

   ```bash
   kubectl get minfo -A | grep -i etcd-sync
   ```

2. Save it and delete it to uninstall.

   > **Warning:** Uninstalling the etcd Synchronizer stops disaster-recovery synchronization. Uninstalling it while the standby is missing data that the primary holds can make owner references resolve incorrectly and lead to workload-cluster node `Machine` objects being deleted. Precondition: only when the sync check reports no missed or surplus keys that are unexplained, and the name is the etcd-sync plugin. Rollback: `kubectl apply -f /tmp/etcd-sync-minfo.yaml`.

   ```bash
   kubectl get minfo <etcd-sync-minfo> -o yaml > /tmp/etcd-sync-minfo.yaml
   kubectl delete minfo <etcd-sync-minfo>
   ```

   Add `-n <namespace>` to both commands if the list printed a namespace.

3. To install it again, apply a ModuleInfo for `etcd-sync` taken from the saved object (remove `metadata.resourceVersion`, `metadata.uid`, and `status` first), not a hand-written manifest.

## Diagnostic Steps

```bash
kubectl get ars -A | grep -i etcd
kubectl get pods -A | grep -E 'etcd-sync|etcd-mirror'
kubectl get secret -n cpaas-system etcd-ca
kubectl get minfo -A | grep -i etcd
kubectl logs -n cpaas-system <etcd-sync-pod> --tail=200
```

- `ChartValuesRenderFailed` with `base64: invalid input`: Cause 1; no Pods exist yet.
- Plugin Pods not Ready and `etcd-ca` reported `NotFound`: Cause 2.
- Install fails and the historical primary still lists an `etcd-mirror` Deployment: Cause 3.
- `ars` times out on the etcd sync API, and the platform domain resolved to the standby when the plugin was installed: Cause 4.
- Removing or reinstalling the plugin from `kubectl`: Cause 5.

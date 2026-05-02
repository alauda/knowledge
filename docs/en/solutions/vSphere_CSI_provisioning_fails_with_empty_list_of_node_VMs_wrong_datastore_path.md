---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# vSphere CSI provisioning fails with "empty list of node VMs" — wrong datastore path
## Issue

The cluster's storage operator goes `Degraded` and every PVC that targets the vSphere CSI StorageClass stays in `Pending`. The provisioner sidecar logs an `empty List of Node VMs returned from nodeManager` error:

```text
csi.vsphere.vmware.com_vsphere-csi-controller-...
  failed to provision volume with StorageClass "csi":
  rpc error: code = Internal desc = failed to get shared datastores
  in kubernetes cluster.
  Error: empty List of Node VMs returned from nodeManager
```

A `kubectl describe pvc` on any pending claim adds the smoking gun:

```text
failed: unable to fetch default datastore url:
  failed to access datastore /<DC>/datastore/<DS>:
  datastore '/<DC>/datastore/<DS>' not found
```

## Root Cause

The vSphere CSI driver discovers the cluster's nodes by walking the configured datacenter and finding the VMs that share a datastore. If the datastore path it is told to use does not actually exist in vCenter (typo, datastore renamed, datastore moved into a folder), the driver cannot enumerate any node VMs against it. With zero node VMs the provisioner has nothing to schedule the volume to and fails with `empty List of Node VMs`.

The path the driver believes is the truth comes from two places — they have to agree, and they have to match what vCenter actually shows:

- The `cloud-provider-config` ConfigMap that the storage operator mounts into the vSphere CSI controller.
- The cluster-level Infrastructure CR's `spec.platformSpec.vsphere` (or equivalent platform CR), where the datastore is recorded for the platform as a whole.

When the path is wrong, every CSI provisioning attempt fails the same way — the symptom is a bound, healthy CSI driver pod producing identical errors for every claim.

## Resolution

Correct the datastore path on the configuration that the CSI driver reads, then restart the driver pods so they pick it up.

### 1. Read the current configuration

```bash
kubectl get cm -n <csi-config-namespace> cloud-provider-config -o yaml
kubectl get infrastructure cluster -o yaml
```

Compare the `datastore` (or `defaultDatastore`) entry against what vCenter reports. The path is `/<datacenter>/datastore/<datastore-name>` — including any folder a vSphere admin may have moved the datastore into. A datastore that lives under `Datacenter/datastore/Cluster-A/ds01` resolves to `/Datacenter/datastore/Cluster-A/ds01`, not `/Datacenter/datastore/ds01`.

### 2. Fix the path

Patch the ConfigMap in place:

```bash
kubectl edit cm -n <csi-config-namespace> cloud-provider-config
# or, scripted:
kubectl get cm -n <csi-config-namespace> cloud-provider-config -o yaml \
  | sed 's|<old-path>|<new-path>|g' \
  | kubectl apply -f -
```

If your platform exposes vSphere settings through the platform CR, update both — the operator may overwrite the ConfigMap from the CR on the next reconcile. The exact CR name depends on the cluster, but the field is the datastore path:

```yaml
spec:
  platformSpec:
    vsphere:
      vcenters:
      - datacenters: [<datacenter>]
      failureDomains:
      - topology:
          datastore: /<datacenter>/datastore/<correct-name>
```

### 3. Restart the CSI driver

The driver caches the datastore lookup at startup. After the path is corrected, bounce the controller and node DaemonSet pods so they re-read it:

```bash
kubectl -n <csi-driver-namespace> rollout restart deploy/vsphere-csi-controller
kubectl -n <csi-driver-namespace> rollout restart ds/vsphere-csi-node
kubectl -n <csi-driver-namespace> rollout status deploy/vsphere-csi-controller
```

### 4. Verify

```bash
kubectl get pvc -A | grep -v Bound      # no more Pending claims on the vSphere SC
kubectl get co/storage 2>/dev/null      # if a storage cluster operator is present
kubectl logs -n <csi-driver-namespace> deploy/vsphere-csi-controller \
  -c csi-provisioner --tail=50 | grep -iE 'empty list|provision'
```

A clean controller log and a fresh PVC binding within seconds is the signal the path resolves.

## Diagnostic Steps

1. Capture the failure on the PVC itself — the datastore path it could not access is printed verbatim:

   ```bash
   kubectl describe pvc <pvc> -n <ns> | sed -n '/Events/,$p'
   ```

2. Verify the path on the ConfigMap and the infrastructure CR are identical (a mismatch means an operator will overwrite your fix on its next reconcile):

   ```bash
   kubectl get cm -n <csi-config-namespace> cloud-provider-config \
     -o jsonpath='{.data.config}' | grep -i datastore
   kubectl get infrastructure cluster -o yaml | yq '.spec.platformSpec.vsphere'
   ```

3. From a node or jumphost with vCenter access, list the datastores under the datacenter and confirm the spelling and folder path are exactly what the cluster has configured. If the datastore was renamed or moved, both ends of that change have to be reflected in the cluster config.

4. If the driver still complains after the path is fixed and the pods are restarted, look for stale `CSINode` objects pointing at hosts that no longer exist:

   ```bash
   kubectl get csinodes -o yaml | yq '.items[] | {name: .metadata.name, drivers: .spec.drivers[].name}'
   ```

   Any `csinode` for a removed host can be deleted manually; the driver re-registers live nodes automatically.

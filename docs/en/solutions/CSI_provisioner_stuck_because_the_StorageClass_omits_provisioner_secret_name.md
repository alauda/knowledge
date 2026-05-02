---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A StorageClass that delegates to an external CSI driver fails to provision PVCs. Pods that wait on the claim — most visibly the CDI (Containerized Data Importer) importer used to seed VM disks — sit in `Pending`, and the controller pod for the CSI external-provisioner emits an error that points back to a templating problem in the StorageClass parameters:

```text
E0424 18:52:37.340275 1 controller.go:988] "Unhandled Error"
  err="error syncing claim \"pvc-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\":
       failed to provision volume with StorageClass \"sc-name\":
       failed to get name and namespace template from params:
       Provisioner secrets specified in parameters but value of either
       namespace or name is empty"
```

The PVC stays in `Pending`. The cluster has no events that suggest a backend outage, and other StorageClasses on the same CSI driver provision normally.

## Root Cause

The CSI external-provisioner sidecar reads four well-known parameters from the StorageClass to learn which Secret it should authenticate to the storage backend with:

```text
csi.storage.k8s.io/provisioner-secret-name
csi.storage.k8s.io/provisioner-secret-namespace
csi.storage.k8s.io/controller-publish-secret-name
csi.storage.k8s.io/controller-publish-secret-namespace
```

When any of these is *declared* (the key is present in `parameters:`) but its value is the empty string, the sidecar treats it as a templating misconfiguration rather than an absent secret reference and refuses to proceed. The behaviour is intentional — the empty key is almost always a copy-paste mistake from a templated StorageClass that was rendered without its values — and is exactly what the error message reports.

The "secret namespace is set, secret name is empty" pattern in the diagnostic dump is the most common shape: the namespace is hardcoded to a storage-operator namespace, but the secret name was meant to be filled by a Helm/Kustomize value that did not get rendered.

## Resolution

Pick the option that matches who owns the StorageClass.

### Option A — fix the StorageClass (preferred)

Add the missing secret name and verify the namespace points to a Secret that actually exists. The Secret usually lives next to the CSI driver's controller pods and contains the credential the driver uses to talk to the array.

```bash
kubectl get secret -n <storage-driver-namespace>

kubectl patch sc <sc-name> --type=merge -p '{
  "parameters": {
    "csi.storage.k8s.io/provisioner-secret-name": "<the-real-secret>",
    "csi.storage.k8s.io/provisioner-secret-namespace": "<storage-driver-namespace>"
  }
}'
```

After patching, delete the stuck PVCs (or let the importer retry) — the provisioner will pick up the new parameters on the next reconcile and bind the volume.

### Option B — switch to a healthy StorageClass

If the broken StorageClass is owned by an operator that re-renders it on every reconcile (so your patch will be reverted), point new claims at a different StorageClass that does have the secret reference filled in:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-claim
spec:
  storageClassName: <the-working-sc>      # not the broken one
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 50Gi
```

For VM disks created by CDI, the same field lives on the DataVolume:

```yaml
apiVersion: cdi.kubevirt.io/v1beta1
kind: DataVolume
spec:
  pvc:
    storageClassName: <the-working-sc>
    accessModes: [ReadWriteOnce]
    resources:
      requests:
        storage: 50Gi
```

This is a workaround, not a fix — the broken StorageClass still poisons every claim that lands on it, so escalate to the operator owner so the parameter rendering bug gets corrected upstream.

## Diagnostic Steps

1. Look at the PVC events — the provisioner records the failure reason directly on the claim:

   ```bash
   kubectl describe pvc <pvc-name> -n <namespace>
   ```

   Look for the `failed to provision volume … secrets specified in parameters but value of either namespace or name is empty` line. That string is what proves the parameter, not the backend, is the problem.

2. Inspect the StorageClass `parameters` and verify both `name` and `namespace` for every `*-secret-*` key are non-empty:

   ```bash
   kubectl get sc <sc-name> -o yaml | yq '.parameters'
   ```

   A typical broken shape looks like:

   ```yaml
   parameters:
     connectionType: fc
     csi.storage.k8s.io/provisioner-secret-name: ""
     csi.storage.k8s.io/provisioner-secret-namespace: xxx-storage-xxx
   ```

   The empty `name` is the smoking gun.

3. Confirm the named Secret actually exists in the namespace the StorageClass points to. A non-empty but non-existent reference fails differently (the provisioner reports `secret not found`); an empty reference is the case described in this article.

4. Check the CSI provisioner sidecar logs to confirm the error is template parsing rather than backend rejection:

   ```bash
   kubectl logs -n <storage-driver-namespace> \
     deploy/<csi-controller> -c csi-provisioner --tail=200 \
     | grep -E 'name and namespace template|Provisioner secrets'
   ```

5. After the fix, watch a fresh PVC bind end-to-end:

   ```bash
   kubectl get pvc -n <namespace> -w
   kubectl get events -n <namespace> --field-selector involvedObject.kind=PersistentVolumeClaim --sort-by=.lastTimestamp | tail -20
   ```

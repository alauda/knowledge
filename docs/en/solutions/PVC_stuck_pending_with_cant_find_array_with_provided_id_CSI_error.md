---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A PersistentVolumeClaim never reaches `Bound`. The associated provisioner pod
emits a Kubernetes event of the form:

```text
Warning  ProvisioningFailed  persistentvolumeclaim/pvc-xxx
  failed to provision volume with StorageClass "<class>":
  rpc error: code = Internal desc = can't find array with provided id Unique
```

The literal string `Unique` (or any other token that does not correspond to a
registered storage backend) appears at the bottom of the error. Subsequent
retries by the external provisioner emit the same event every few minutes
without ever completing.

## Root Cause

The CSI driver behind that StorageClass identifies the target storage backend
by an `arrayID` (or equivalent) parameter in `StorageClass.parameters`. The
external provisioner forwards that value to the driver's `CreateVolume` RPC,
and the driver looks it up in the set of arrays it has been registered with.

If the value in the StorageClass is a placeholder copied from sample
documentation — `Unique`, `array-id-1`, `<replace-me>` — the driver returns
`InvalidArgument` because no matching backend is registered. The provisioner
treats that as a transient failure and keeps retrying, so the PVC remains
stuck in `Pending` indefinitely instead of failing fast.

## Resolution

Replace the placeholder with the real array identifier the CSI driver already
knows about. For drivers that maintain a configuration secret per backend
(common pattern for enterprise SAN/NAS CSI drivers), the identifier is the key
under which that backend is keyed in the driver's config.

Inspect the StorageClass:

```bash
kubectl get storageclass <class-name> -o yaml
```

Look for the parameter that names the backend (the field is driver-specific —
common names are `arrayID`, `backend`, `storageSystemID`, `system`):

```yaml
parameters:
  arrayID: <real-id-from-driver-config>
```

Patch the value in place and reissue the PVC. StorageClass parameters are
immutable for an existing class, so when the value is wrong from the start the
options are:

```bash
# Option 1: delete and recreate the StorageClass with the correct parameter.
kubectl delete storageclass <class-name>
kubectl apply -f corrected-storageclass.yaml

# Option 2: create a new StorageClass with a distinct name and reissue PVCs
# against it; leave the broken class alone for legacy claims.
```

Reapply the PVC manifest after the StorageClass is fixed:

```bash
kubectl delete pvc <pvc-name> -n <ns>
kubectl apply -f pvc.yaml -n <ns>
```

The provisioner's next reconcile loop will pick the corrected backend and the
PVC binds normally.

## Diagnostic Steps

1. Confirm the failure is in the provisioner, not in the kubelet attach path:

   ```bash
   kubectl get events -n <ns> --field-selector involvedObject.name=<pvc-name>
   ```

   `ProvisioningFailed` events come from the external provisioner sidecar; if
   the failure is `FailedAttachVolume` instead, the StorageClass parameter is
   correct and the issue is elsewhere (node staging, secrets, network reach
   to the array).

2. Inspect the StorageClass parameter and confirm whether it matches what
   the driver expects:

   ```bash
   kubectl get sc <class-name> -o jsonpath='{.parameters}' | jq .
   ```

3. Cross-check against the CSI driver's configuration. Most enterprise CSI
   drivers expose their registered backends either via a Secret or a CR
   under the driver's namespace; the registered identifier must match the
   StorageClass parameter character-for-character (case-sensitive).

4. Tail the provisioner sidecar to confirm the rejection message and rule
   out unrelated errors:

   ```bash
   kubectl logs -n <csi-driver-ns> deploy/<csi-controller> -c csi-provisioner
   ```

   The line `can't find array with provided id <value>` confirms the
   placeholder lookup failure.

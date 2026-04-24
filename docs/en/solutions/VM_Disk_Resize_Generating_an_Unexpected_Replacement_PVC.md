---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

When growing the size of a virtual machine boot or data disk through the
virtualization console flow (VM detail -> Configuration -> Storage -> Edit on
the chosen disk -> raise the PVC size), the operation does not enlarge the
existing volume in place. Instead a brand new PVC is materialised next to the
original, named with a `dv-{vm-name}-{disk-name}-XXXX` pattern, and the VM is
silently rebound to the new claim. Operators end up with two PVCs occupying
storage capacity, the original PVC orphaned, and any workflow that referenced
the previous claim name (backup selectors, snapshot policies, monitoring
dashboards) drifting out of sync.

## Root Cause

The console-side resize action goes through the DataVolume reconciler. When
the requested size is larger than the underlying PVC, the reconciler in
certain KubeVirt CDI builds takes the create-and-rebind path rather than the
expand-in-place path: it provisions a new DataVolume + PVC at the target
capacity and updates the VM volume reference to point at it. The original PVC
is left untouched on the cluster because deleting user data implicitly is a
non-starter; the side effect is the duplicate-PVC pattern operators observe.

The behaviour is fixed in newer CDI / virtualization controller releases that
trigger a standard PVC `spec.resources.requests.storage` patch when the
underlying StorageClass advertises `allowVolumeExpansion: true`, which keeps
the existing claim and lets the CSI driver grow the volume online.

## Resolution

### Preferred: Resize the PVC Directly

Skip the VM-disk edit dialog and operate on the PVC backing the disk. ACP's
virtualization storage surface exposes the PVC under `virtualization/storage`
so the change is visible from the same console; the equivalent CLI patch is
also supported and is the safer option for scripted workflows:

```bash
kubectl -n <vm-namespace> patch pvc <disk-pvc-name> \
  --type=merge \
  -p '{"spec":{"resources":{"requests":{"storage":"<new-size>"}}}}'
```

Two preconditions:

- The StorageClass must have `allowVolumeExpansion: true`. Confirm with
  `kubectl get sc <name> -o jsonpath='{.allowVolumeExpansion}{"\n"}'`.
- Online expansion requires CSI driver support; if the driver only accepts
  offline expansion, stop the VM first so the PVC is unbound from a running
  pod, then patch.

After the patch lands, the file system inside the guest still needs to be
extended (`growpart` + `xfs_growfs` / `resize2fs`) unless the disk image was
prepared with `cloud-init` autosize.

### Alternative: Upgrade the Virtualization Controller

If the duplicate-PVC behaviour is reproducible from the console, the platform
virtualization controller predates the CDI fix. Schedule an upgrade to a
build that contains the in-place expansion change and re-test the dialog
against a disposable VM. Track the upgrade in `virtualization/overview` so
the controller, CDI, and KubeVirt operator versions move together.

### Cleanup of the Stranded PVC

If the duplicate PVC was already created, validate which one the VM is now
bound to before deleting anything:

```bash
kubectl -n <vm-namespace> get vm <vm-name> -o jsonpath='{.spec.template.spec.volumes}' | jq .
kubectl -n <vm-namespace> get vmi <vm-name> -o jsonpath='{.status.volumeStatus}' | jq .
```

Only after confirming the VM no longer references the original PVC, and that
no snapshot or backup pipeline depends on it, remove the stranded claim:

```bash
kubectl -n <vm-namespace> delete pvc <orphaned-pvc-name>
```

## Diagnostic Steps

List PVCs that match the duplicated-name pattern in the VM namespace:

```bash
kubectl -n <vm-namespace> get pvc | grep "^dv-<vm-name>-"
```

Inspect the DataVolume reconcile events for the VM:

```bash
kubectl -n <vm-namespace> get datavolume
kubectl -n <vm-namespace> describe datavolume <dv-name> | sed -n '/Events:/,$p'
```

A duplicate-creation incident leaves a `Successfully created PVC` event for
the new claim and no `Resized` event on the old one — the absence of the
resize event on the original PVC is the marker that the create-and-rebind
path was taken.

Confirm the StorageClass supports online expansion before re-attempting any
resize:

```bash
kubectl get sc <name> -o yaml | grep -E 'allowVolumeExpansion|provisioner'
```

If `allowVolumeExpansion` is `false`, no flow — console or CLI — can resize
the PVC; the StorageClass admin must enable it first or the disk must be
migrated to a class that supports expansion.

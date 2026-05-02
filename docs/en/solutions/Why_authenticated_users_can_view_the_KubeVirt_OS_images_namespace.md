---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

A standard rule of multi-tenant clusters is that namespaces are isolated by default — an authenticated user without explicit permission cannot list resources in a namespace they do not own. KubeVirt-based virtualization stacks intentionally break that rule for one specific namespace: the namespace that holds the curated OS boot-source images (the DataVolumes / DataSources / PVCs cloned to back new VMs).

When a regular cluster user runs `kubectl get datasource -n <kubevirt-os-images-namespace>` and gets a populated list, this is the expected behaviour, not an RBAC misconfiguration. The platform ships a ClusterRole and a ClusterRoleBinding that grant `view` on the boot-source images namespace to every `system:authenticated` principal — without it, namespace-scoped users could not select a base image when creating a VM, because the VM-creation flow needs to read the source DataVolume's manifest to clone it into the user's own namespace.

## Resolution

The grant is deliberate and is provided by two upstream KubeVirt resources:

- **ClusterRole `os-images.kubevirt.io:view`** — allows `get`, `list`, `watch` on `datavolume`, `datasource`, `persistentvolumeclaim` in the boot-source namespace.
- **ClusterRoleBinding `os-images.kubevirt.io:view`** — binds the above ClusterRole to the `system:authenticated` group, so every user that holds a valid token automatically inherits read access on the OS-images namespace.

Inspect the binding to see this directly:

```bash
kubectl get clusterrole os-images.kubevirt.io:view -o yaml
kubectl get clusterrolebinding os-images.kubevirt.io:view -o yaml
```

Both reference the namespace by label and by hard-coded name, depending on the operator version.

### What "view" actually allows

Authenticated users with this binding can:

- `get`, `list`, `watch` DataVolume / DataSource / PVC objects in the OS-images namespace (the source manifests).
- See the `status` of those resources, including which underlying image volumes are imported and ready.

They **cannot**:

- Modify, delete, or replace any object in that namespace (no `update`, `patch`, `delete`, `create`).
- Read the underlying image data through the cluster API. Read-through to the volume's bytes still requires a normal `kubectl exec` into a pod that mounts the PVC, which a viewer cannot create here.
- Read other namespaces' KubeVirt resources unless granted separately.

If a security review flags the broad read access as unwanted, the binding can be tightened — but the trade-off is that the VM-creation wizard then needs an explicit per-user binding (or a "select-by-name" UX) before users can clone a golden image. The two ClusterRoles `os-images.kubevirt.io:edit` and `os-images.kubevirt.io:admin` cover the higher-privilege cases (modify images, manage the namespace).

### Tightening the grant (optional)

When the broad `system:authenticated` grant is incompatible with the cluster's tenancy model, replace the upstream binding with a narrower one. Be aware that the operator will recreate the original binding on every reconciliation, so the override needs to live in a controller-aware place (a custom Kustomize patch, a GitOps overlay, or the operator's CR if it exposes a knob for this).

A workable pattern is to bind the existing `os-images.kubevirt.io:view` ClusterRole to a smaller group only, then disable the default `system:authenticated` binding via the operator CR (consult the platform's KubeVirt operator CR for the field name). For environments that cannot disable the upstream binding, accept the broad read and treat the OS-images namespace as a public catalogue.

## Diagnostic Steps

To see exactly what a particular user is allowed to do in the OS-images namespace, use `kubectl auth can-i`:

```bash
NS=cpaas-virtualization-os-images   # the actual namespace name on this cluster
USER=alice@example.com

kubectl --as="$USER" -n "$NS" auth can-i list datasource
kubectl --as="$USER" -n "$NS" auth can-i create datasource
kubectl --as="$USER" -n "$NS" auth can-i delete persistentvolumeclaim
```

`yes` for `list`, `no` for `create`/`delete` is the expected baseline for a regular user.

To enumerate every binding that grants access to that namespace:

```bash
kubectl get clusterrolebinding -o json \
  | jq '.items[]
        | select(.roleRef.name | test("^os-images.kubevirt.io"))
        | {name: .metadata.name, role: .roleRef.name,
           subjects: [.subjects[]?.kind + ":" + .subjects[]?.name]}'
```

Anything in that list with `Group:system:authenticated` is the broad upstream grant.

To check which DataSources and DataVolumes are currently published as boot sources, look in the OS-images namespace as any authenticated user:

```bash
kubectl -n "$NS" get datasource
kubectl -n "$NS" get datavolume
```

Each `DataSource` carries a `spec.source` pointing at a `DataVolume` (the importable image manifest); the underlying PVC is the cloneable artifact the VM-creation flow uses.

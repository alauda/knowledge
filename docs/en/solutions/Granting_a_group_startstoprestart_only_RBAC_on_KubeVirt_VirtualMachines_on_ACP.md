---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500551
---

# Granting a group start/stop/restart-only RBAC on KubeVirt VirtualMachines on ACP

## Issue

On Alauda Container Platform, KubeVirt (build `v1.7.0-alauda.2`, control plane in namespace `kubevirt`) implements the lifecycle actions start, stop, and restart on a `VirtualMachine` as the subresources `virtualmachines/start`, `virtualmachines/stop`, and `virtualmachines/restart` under the aggregated apiGroup `subresources.kubevirt.io/v1` (namespaced, served unchanged from upstream). The desired outcome is to give a population of users the ability to start, stop, and restart any VM in any namespace via the API (`kubectl`, `virtctl`, or any console that drives the same subresources), but not the ability to add, remove, or edit a VM's disks or other spec fields.

Binding the KubeVirt-shipped aggregated `kubevirt.io:edit` ClusterRole to such a group is too broad: that role grants write verbs `[get, delete, create, update, patch, list, watch]` on the parent `virtualmachines` resource in apiGroup `kubevirt.io` (it carries the aggregation label `rbac.authorization.k8s.io/aggregate-to-edit=true` and the install annotation `kubevirt.io/install-strategy-version=v1.7.0-alauda.2`), so any subject bound to it can mutate the VM spec, including disks. The disk list lives in the `VirtualMachine` spec at `spec.template.spec.domain.devices.disks[]` (per the `virtualmachines.kubevirt.io/v1` CRD), and changing it requires `update`/`patch` on `kubevirt.io/virtualmachines` — there is no path from the lifecycle subresources to that field.

## Resolution

Define a custom ClusterRole that grants only `update` on the three lifecycle subresources in `subresources.kubevirt.io`, together with read verbs on the parent `virtualmachines` resource so the subject can list and inspect VMs to act on. This is the canonical verb pattern the upstream-shipped `kubevirt.io:edit` ClusterRole uses for the lifecycle subresources (verb `update` against `virtualmachines/{start,stop,restart}`), and `kubevirt.io:view` confirms read on VMs uses `[get, list, watch]` on apiGroup `kubevirt.io / virtualmachines` with no write verbs. Apply the following ClusterRole:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubevirt-vm-lifecycle-only
rules:
  - apiGroups: ["subresources.kubevirt.io"]
    resources:
      - virtualmachines/start
      - virtualmachines/stop
      - virtualmachines/restart
    verbs: ["update"]
  - apiGroups: ["kubevirt.io"]
    resources: ["virtualmachines"]
    verbs: ["get", "list", "watch"]
```

Bind the ClusterRole to the target group with a ClusterRoleBinding. On ACP, the RBAC subject kinds remain the upstream Kubernetes set (`User`, `Group`, `ServiceAccount` — `rbac.authorization.k8s.io/v1` is served unchanged), and a `kind: Group` subject matches any authenticated user whose authentication-layer groups claim contains the bound `name`; the group identity itself is supplied by whatever identity provider (OIDC, LDAP, etc.) the cluster is integrated with — that population is established outside this RBAC recipe. Replace `<group-name>` with the group string carried in the user's token:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubevirt-vm-lifecycle-only
subjects:
  - kind: Group
    name: <group-name>
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: kubevirt-vm-lifecycle-only
  apiGroup: rbac.authorization.k8s.io
```

Apply both objects:

```bash
kubectl apply -f kubevirt-vm-lifecycle-only-clusterrole.yaml
kubectl apply -f kubevirt-vm-lifecycle-only-clusterrolebinding.yaml
```

Because the binding is cluster-scoped, every authenticated user whose groups claim contains `<group-name>` inherits start/stop/restart-only permission against every VM in every namespace; no other VM-spec mutation is reachable through the bound permissions.

## Diagnostic Steps

Confirm that the lifecycle subresources are served on the cluster and that the resource strings the ClusterRole references match the cluster's served API:

```bash
kubectl get --raw /apis/subresources.kubevirt.io/v1 \
  | python3 -m json.tool \
  | grep -E 'virtualmachines/(start|stop|restart)'
```

The aggregated apiGroup `subresources.kubevirt.io/v1` lists `virtualmachines/start`, `virtualmachines/stop`, and `virtualmachines/restart` as namespaced subresources — these are the exact resource strings the ClusterRole rule must use.

Inspect the upstream-shipped `kubevirt.io:edit` ClusterRole to confirm the canonical verb on the lifecycle subresources is `update` and to see why a narrower custom role is required (it grants write verbs on the parent `virtualmachines` resource as well):

```bash
kubectl get clusterrole kubevirt.io:edit -o yaml
kubectl get clusterrole kubevirt.io:view -o yaml
```

`kubevirt.io:edit` groups `virtualmachines/{start,stop,restart}` (apiGroup `subresources.kubevirt.io`) under `verbs: [update]`, carries the `rbac.authorization.k8s.io/aggregate-to-edit=true` label, and lists `[get, delete, create, update, patch, list, watch]` on `kubevirt.io / virtualmachines` — too broad for this requirement. `kubevirt.io:view` confirms the read-only half (`[get, list, watch]` on `kubevirt.io / virtualmachines` and `virtualmachineinstances`), which composes with the custom subresource-update rule to deliver start/stop/restart-only behavior with no disk-edit reachability.

Verify the disk field is reachable only through write verbs on the parent resource, not through any lifecycle subresource:

```bash
kubectl explain virtualmachine.spec.template.spec.domain.devices.disks
```

The output anchors the disk list at `spec.template.spec.domain.devices.disks[]` on `virtualmachines.kubevirt.io/v1`; mutating it requires `update`/`patch` on `kubevirt.io/virtualmachines`, which the custom role deliberately omits.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A VM configured to use an SR-IOV network stays in `Starting` and never reaches `Ready`. The VM's status surfaces a `FailedCreate` condition pointing at a missing NetworkAttachmentDefinition:

```yaml
status:
  conditions:
    - type: Ready
      status: "False"
      reason: PodNotExists
      message: virt-launcher pod has not yet been scheduled
    - reason: FailedCreate
      message: >-
        failed to render launch manifest: failed to locate network attachment
        definition mtv-system/example-net-01
```

The SR-IOV `NetworkAttachmentDefinition` (NAD) exists on the cluster — `kubectl get nad -A` confirms it. The problem is the **namespace** where it exists does not match the VM's **namespace**.

## Root Cause

`NetworkAttachmentDefinition` is a **namespace-scoped** resource. A VM or pod in namespace A cannot reference a NAD in namespace B by the unqualified name — it must use the fully qualified `namespace/name` form, and both the consumer and the NAD must be in the same cluster security context for Multus to plumb the attachment.

The SR-IOV Network Operator, unlike Multus in general, does **not** publish its NADs in an arbitrary namespace. It publishes them in the namespace named by the `SriovNetwork` CR's `spec.networkNamespace` field:

```yaml
apiVersion: sriovnetwork.alauda.io/v1
kind: SriovNetwork
metadata:
  name: p1-sriov
  namespace: cpaas-sriov-network-operator     # always lives in the operator's namespace
spec:
  capabilities: '{"mac": true}'
  logLevel: info
  networkNamespace: mtv-system                # <-- target NAD namespace
  resourceName: intel_x710_p1
  vlan: 992
```

The SR-IOV operator creates a NAD called `p1-sriov` in the `mtv-system` namespace. A VM in the `default` namespace references `mtv-system/p1-sriov` in its `spec.networks[].multus.networkName` — but Multus rejects cross-namespace references for NADs (the scoped access control is deliberate). From the VM's perspective, `mtv-system/p1-sriov` is a NAD "over there somewhere" that it cannot consume.

The rule: **the VM must live in the same namespace as the NAD, which is the namespace named by `SriovNetwork.spec.networkNamespace`.**

Manually creating a second NAD in the VM's namespace does not work for SR-IOV — SR-IOV NADs are managed by the operator, and any hand-created one lacks the PCI-device and resource metadata the operator injects.

## Resolution

Two routes, pick based on how the cluster is organised.

### Route A — move the VM to the SR-IOV NAD's namespace

The simplest fix: put the VM (and its PVCs, etc.) in the namespace the SR-IOV operator wrote the NAD into. The NAD sits in `mtv-system`; put the VM there too:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: app-vm
  namespace: mtv-system     # move here, matches the SR-IOV NAD namespace
spec:
  template:
    spec:
      networks:
        - name: nic-01
          multus:
            networkName: p1-sriov    # or mtv-system/p1-sriov — same ns either way
      # ... rest of VM spec ...
```

Apply the moved VM; `virt-launcher` can now resolve the NAD and the pod starts.

### Route B — add a `SriovNetwork` CR targeting the VM's namespace

If the VM's namespace is fixed by other constraints, create a second `SriovNetwork` that targets it. The operator will publish a sibling NAD in the VM's namespace:

```yaml
apiVersion: sriovnetwork.alauda.io/v1
kind: SriovNetwork
metadata:
  name: p1-sriov-for-default
  namespace: cpaas-sriov-network-operator
spec:
  capabilities: '{"mac": true}'
  logLevel: info
  networkNamespace: default             # <-- VM's namespace
  resourceName: intel_x710_p1
  vlan: 992
```

After the operator reconciles, a NAD named `p1-sriov-for-default` appears in the `default` namespace. The VM references it:

```yaml
networks:
  - name: nic-01
    multus:
      networkName: p1-sriov-for-default
```

Both SriovNetwork CRs can coexist; the underlying physical SR-IOV VF pool is shared. The only constraint is the `resourceName` must match a SriovNetworkNodePolicy that publishes the right number of VFs — watch for exhaustion if many namespaces claim VFs from the same pool.

### What does not work

- **Hand-creating a NAD in the VM's namespace.** SR-IOV NADs carry operator-injected metadata about the VF pool; without it the CNI cannot claim a VF and the pod fails differently. Let the operator create them.
- **Changing the VM's `networkName` to a cross-namespace reference.** Multus does not cross-namespace attach. The reference is interpreted inside the VM's namespace and the cross-namespace lookup fails.
- **Setting `spec.networkNamespace` to a namespace that does not exist.** The operator waits for the namespace to exist before writing the NAD. Create the namespace first, then the SriovNetwork.

## Diagnostic Steps

Confirm the VM's error message and compare namespace scoping between VM and NAD:

```bash
NS=<vm-namespace>
VM=<vm-name>
kubectl -n "$NS" get vm "$VM" -o jsonpath='{.status.conditions}{"\n"}' | jq
# Look for: failed to locate network attachment definition <ns>/<name>
```

List the NAD in question and its actual home:

```bash
kubectl get networkattachmentdefinitions -A | grep <nad-name>
```

If the NAD's namespace differs from the VM's namespace, the root cause is confirmed.

List all SriovNetworks and see which namespaces they target:

```bash
kubectl get sriovnetwork -A -o \
  custom-columns='NAME:.metadata.name,TARGET_NS:.spec.networkNamespace,VLAN:.spec.vlan,RESOURCE:.spec.resourceName'
```

Make sure there is a SriovNetwork targeting the VM's namespace (Route B) or move the VM to an existing target (Route A).

After applying the fix, watch the VM come up:

```bash
kubectl -n "$NS" get vm "$VM" -w
kubectl -n "$NS" get vmi "$VM" -o jsonpath='{.status.interfaces}{"\n"}' | jq
```

The `interfaces` block should list the SR-IOV NIC with its assigned IP and MAC. No `FailedCreate` events should accrue on the `virt-launcher` pod.

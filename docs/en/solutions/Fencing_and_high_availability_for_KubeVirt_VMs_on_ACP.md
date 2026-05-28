---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500411
---

# Fencing and high availability for KubeVirt VMs on ACP

## Issue

On Alauda Container Platform with the `kubevirt-operator` bundle installed (CSV `kubevirt-hyperconverged-operator.v4.3.5`, HCO operator `v1.7.0-alauda.1`, KubeVirt `v1.7.0-alauda.2`, HyperConverged singleton in the `kubevirt` namespace) on Kubernetes server `v1.34.5`, a `VirtualMachine` that lives on a node which suddenly becomes unreachable will not automatically recover on a surviving node unless three things are set up in advance — a restart policy that asks the virt-controller to recreate the VMI, an eviction policy that names what to do when the node drains, and a node-level remediation path that lets stuck volumes detach so the new VMI can mount them elsewhere. Each piece lives in a different resource and ships separately on ACP, so the HA story has to be assembled rather than enabled with a single switch.

Environment anchor for the rest of this article: cluster installed from `installer-v4.3.0-online`, Kubernetes server `v1.34.5`, `kubevirt-hyperconverged-operator.v4.3.5`, `node-healthcheck-operator.v0.9.13`, and `self-node-remediation-operator.v0.10.23` — the last two ship as `PackageManifest` objects in the platform catalog and are installable but not subscribed by default.

## Root Cause

A KubeVirt `VirtualMachine` carries two independent fields that together govern recovery behaviour. The first is `.spec.runStrategy` on the VM (type `string`) — the CRD marks the older `.spec.running` boolean as Deprecated and treats `runStrategy` and `running` as mutually exclusive, so any HA-oriented VM must use `runStrategy` to express its restart intent. The second is `.spec.template.spec.evictionStrategy` on the VMI template (type `string`); the CRD description states that this field "describes the strategy to follow when a node drain occurs" and enumerates the accepted values as `None`, `LiveMigrate`, `LiveMigrateIfPossible`, and `External`.

Neither of those fields, on their own, deals with the case where the node is not draining gracefully but is simply gone. When a node stops reporting and its VMI pod is stuck `Terminating`, the underlying RWO `PersistentVolume` is still recorded as attached to that node, so the virt-controller cannot start a replacement VMI on a healthy node. The upstream Kubernetes resolution is the `node.kubernetes.io/out-of-service` taint primitive: a taint of shape `{key: node.kubernetes.io/out-of-service, value: nodeshutdown, effect: NoExecute}` on the unreachable `Node` triggers the attach-detach controller to force-detach the volume. The `NodeOutOfServiceVolumeDetach` feature gate that backs this primitive is GA on Kubernetes `v1.28` and locked-on by the time of `v1.34.5`, so the cluster does not need any feature-gate toggle for it to work.

## Resolution

Configure the `VirtualMachine` for HA, then install a node-level remediator that can apply the out-of-service taint on its behalf. The three pieces — `runStrategy`, `evictionStrategy`, and a `NodeHealthCheck` selecting the VMI's host node — together meet the fencing-readiness criteria.

Set `.spec.runStrategy: Always` on every VM that must auto-recover. This instructs the virt-controller to keep one VMI running and to recreate it once the previous VMI object is removed; do not also set `.spec.running`, since the CRD marks the two fields as mutually exclusive.

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: ha-vm
  namespace: my-vms
spec:
  runStrategy: Always
  template:
    spec:
      evictionStrategy: LiveMigrate
      domain:
        devices: {}
```

Pick `.spec.template.spec.evictionStrategy` to match the workload. The CRD-enumerated values are `None`, `LiveMigrate`, `LiveMigrateIfPossible`, and `External`, and the strategy fires on node drain. `LiveMigrate` requires the drain to wait for migration and only suits VMs whose storage and network allow migration; `LiveMigrateIfPossible` falls back to a normal shutdown when migration is not feasible; `External` defers eviction to an external controller; `None` lets the standard pod eviction proceed.

A fenced VM is recovery-ready only when all three of the following hold together: the `VirtualMachine` declares `runStrategy: Always`, the VMI uses RWX storage or RWO storage on a CSI driver that supports `VolumeAttachment` force-detach, and a `NodeHealthCheck` resource selects the node that hosts the VMI. Without the third leg in place, an unreachable node never receives the out-of-service taint and the RWO volume never releases — the VM cannot restart on a surviving node no matter what `runStrategy` says.

Install the node remediation stack from the platform catalog. The `node-healthcheck-operator` bundle is present as a `PackageManifest` on ACP (catalog `platform`, install mode `AllNamespaces`, suggested namespace `workload-availability`, current CSV `node-healthcheck-operator.v0.9.13`) and the matching CRD group `remediation.medik8s.io` is absent on a fresh cluster — the operator is installable but not subscribed by default and must be subscribed before any `NodeHealthCheck` resource can be created. A companion `self-node-remediation-operator` bundle ships through the same catalog (see the environment anchor above for its CSV) and provides a `SelfNodeRemediationTemplate` that a `NodeHealthCheck` references via `remediationTemplate`; the upstream remediation flow then drives the unreachable node toward the `node.kubernetes.io/out-of-service=nodeshutdown:NoExecute` taint whose primitive shape is the same Node taint triple the kubelet/attach-detach controller already honour on this Kubernetes version.

Create a `NodeHealthCheck` resource that watches the right nodes. The `NodeHealthCheck.spec` shape carries four keys — `selector` (a label selector picking which nodes the check watches), `unhealthyConditions` (a list of `{type, status, duration}` entries), `minHealthy` (an integer or percentage string such as `"51%"` describing how many nodes must remain healthy before remediation is allowed), and `remediationTemplate` (an objectReference pointing at a `*RemediationTemplate` CR).

```yaml
apiVersion: remediation.medik8s.io/v1alpha1
kind: NodeHealthCheck
metadata:
  name: vm-hosts
spec:
  selector:
    matchLabels:
      node-role.kubernetes.io/worker: ""
  unhealthyConditions:
    - type: Ready
      status: "False"
      duration: 300s
    - type: Ready
      status: Unknown
      duration: 300s
  minHealthy: "51%"
  remediationTemplate:
    apiVersion: self-node-remediation.medik8s.io/v1alpha1
    kind: SelfNodeRemediationTemplate
    namespace: workload-availability
    name: self-node-remediation-resource-deletion-template
```

`selector` accepts either form of a standard Kubernetes `LabelSelector` — `matchLabels` (as above) or `matchExpressions` (e.g. `[{key: node-role.kubernetes.io/worker, operator: Exists}]`, which is the form the bundle's `alm-examples` sample uses). Both forms select the same set of nodes; pick whichever matches the rest of the CR set in the namespace.

## Diagnostic Steps

When a VM is stuck after a node failure, walk the chain field-by-field. Read the VM to confirm `runStrategy` and the VMI template's `evictionStrategy` are set to the expected values; both fields live on `virtualmachines.kubevirt.io/v1` and are read from the same object.

```bash
kubectl get vm -n my-vms ha-vm \
  -o jsonpath='{.spec.runStrategy}{"\n"}{.spec.template.spec.evictionStrategy}{"\n"}'
```

Check whether the unreachable `Node` has acquired the out-of-service taint. The taint shape is the upstream triple `node.kubernetes.io/out-of-service=nodeshutdown:NoExecute`; on Kubernetes `v1.34.5` the `NodeOutOfServiceVolumeDetach` gate is locked GA, so the kube-controller-manager will act on the taint as soon as it appears.

```bash
kubectl get node <unreachable-node> \
  -o jsonpath='{range .spec.taints[*]}{.key}={.value}:{.effect}{"\n"}{end}'
```

If the taint is absent, the node remediator has not run. Confirm the remediation stack is actually subscribed — on a stock ACP cluster the `node-healthcheck-operator` and `self-node-remediation-operator` bundles are present as `PackageManifest` objects in the catalog but their CRDs (`nodehealthchecks.remediation.medik8s.io`, `selfnoderemediationtemplates.self-node-remediation.medik8s.io`) only appear after the bundles are subscribed.

```bash
kubectl get packagemanifest node-healthcheck-operator \
  -o jsonpath='{.status.channels[?(@.name=="stable")].currentCSV}{"\n"}'
kubectl get crd nodehealthchecks.remediation.medik8s.io 2>/dev/null \
  || echo "node-healthcheck-operator not subscribed"
```

Once a `NodeHealthCheck` is in place and its `unhealthyConditions` match for the configured duration, the upstream remediation flow drives the unreachable node toward the `node.kubernetes.io/out-of-service=nodeshutdown:NoExecute` taint — the shape of that taint primitive and the fact that the `NodeOutOfServiceVolumeDetach` feature gate is locked-GA on Kubernetes `v1.34.5` are what this cluster anchors directly. What happens downstream of the taint — force-detach of an RWO `VolumeAttachment` and a fresh VMI pod scheduled on a surviving node — is the documented upstream sequence and depends on the CSI driver backing the VM's storage. On a stock ACP cluster whose only `StorageClass` resolves to a host-local CSI such as `topolvm.cybozu.com` (where `volumeattachments.storage.k8s.io` is not used because `ATTACHREQUIRED=false`), the force-detach pathway is moot and the fenced volume cannot migrate — verify the cluster has an RWX or force-detach-capable CSI before relying on this final hop.

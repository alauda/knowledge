---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500542
---

# All KubeVirt VMs simultaneously power off after the VirtualMachineInstance CRD is deleted by a cluster-admin third-party service account on ACP

## Issue

On Alauda Container Platform, KubeVirt is installed through the `kubevirt-operator` OperatorBundle. The control plane runs in the `kubevirt` namespace and is composed of `virt-operator` (2/2), `virt-api` (1/1), `virt-controller` (1/1), and the per-node `virt-handler` DaemonSet (one pod per linux node), all packaged by the OLM CSV `kubevirt-hyperconverged-operator.v4.3.5` and reporting `observedKubeVirtVersion=v1.7.0-alauda.2`. The `virtualmachineinstances.kubevirt.io` CRD is registered cluster-wide under `apiextensions.k8s.io/v1`, `group=kubevirt.io`, `plural=virtualmachineinstances`, `shortNames=[vmi,vmis]`, `scope=Namespaced`, and carries the label `app.kubernetes.io/managed-by=virt-operator` plus the annotation `kubevirt.io/install-strategy-version=v1.7.0-alauda.2` — `virt-operator` owns and reconciles this CRD.

The reported symptom: every running KubeVirt-managed virtual machine on the cluster powers off at the same moment. On each affected node, `virt-handler` (image `build-harbor.alauda.cn/3rdparty/kubevirt/virt-handler:v1.7.0-alauda.2`) drives a graceful shutdown of the underlying QEMU process for the VMs it manages and waits for up to `--graceful-shutdown-seconds=315` while QEMU delivers an ACPI power-button event and SIGTERM propagates to guest processes. During the teardown window `virt-handler` emits structured JSON log lines following the upstream envelope `{component, level, msg, pos, timestamp}` (for example a `"Signaled graceful shutdown"`-shape message keyed off the per-VM teardown path).

## Root Cause

The KubeVirt control plane reconciles VMs against the cluster-scoped `virtualmachineinstances.kubevirt.io` CRD; when that CRD object is deleted from `apiextensions.k8s.io/v1`, the cluster no longer admits VMI instances and the per-VM teardown path runs on every node — producing the simultaneous power-off pattern.

Deletion of the VMI CRD is reachable by any principal bound to the upstream `cluster-admin` ClusterRole, whose rule is the RBAC wildcard `{apiGroups:[*], resources:[*], verbs:[*]}` and therefore grants delete on every cluster-scoped resource including CRDs. In the observed scenario, a third-party automation/backup service account had been bound to `cluster-admin` and used that authorization to delete the VMI CRD as part of its workflow. The legitimate principal that owns this CRD is the `virt-operator` ServiceAccount (`system:serviceaccount:kubevirt:kubevirt-operator`), which the bound ClusterRole grants `[get,list,watch,create,delete,patch]` on `apiextensions.k8s.io/customresourcedefinitions`; any other service account showing up as the `create` principal on a CRD recreation is therefore out of band.

## Resolution

Restore the `virtualmachineinstances.kubevirt.io` CRD so that VMs which were running before the deletion can be reconciled again. `virt-operator` (image `build-harbor.alauda.cn/3rdparty/kubevirt/virt-operator:v1.7.0-alauda.2`) owns the CRD and reconciles it back when it is missing; the recommended path is to let `virt-operator` recreate it rather than re-applying the CRD object out of band, which avoids leaving a recreate-moment `creationTimestamp` and a non-operator principal on the audit trail.

Confirm the CRD has been restored by listing it with `kubectl`:

```bash
kubectl get crd | grep virtualmachineinstance
kubectl get crd virtualmachineinstances.kubevirt.io -o yaml
```

The restored CRD should carry `group=kubevirt.io`, `plural=virtualmachineinstances`, `shortNames=[vmi,vmis]`, `scope=Namespaced`, label `app.kubernetes.io/managed-by=virt-operator`, and annotation `kubevirt.io/install-strategy-version=v1.7.0-alauda.2`. Once present, VMs that were running before the deletion restart automatically and service is restored.

Revoke the third-party automation/backup service account's binding to `cluster-admin` and rebind it to a least-privilege role that does not grant `delete` on `apiextensions.k8s.io/customresourcedefinitions`; otherwise the same outage class can recur on the next workflow run.

## Diagnostic Steps

Inspect the restored CRD object's `generation` and `creationTimestamp` to confirm whether a delete/recreate event happened. The signature is `generation: 1` with a `creationTimestamp` matching the recreation moment rather than the original cluster install time (the live install-time stamp on this cluster is `2026-05-13T05:21:49Z`):

```bash
kubectl get crd virtualmachineinstances.kubevirt.io \
  -o jsonpath='{.metadata.generation}{"\t"}{.metadata.creationTimestamp}{"\n"}'
```

Pull `virt-handler` logs from the `kubevirt` namespace during the outage window. `virt-handler` emits structured JSON of the upstream envelope `{component, level, msg, pos, timestamp}`; a graceful-shutdown signal for each VM whose VMI is being torn down appears on this stream:

```bash
kubectl -n kubevirt logs ds/virt-handler --since=1h
```

Confirm whether the third-party automation/backup service account is bound to `cluster-admin` and therefore has the privilege required to delete the VMI CRD. Use the upstream `kubectl auth can-i` probe with `--as` impersonation to evaluate the binding without touching the live CRD:

```bash
kubectl auth can-i delete crd \
  --as=system:serviceaccount:<ns>:<sa>
kubectl get clusterrolebinding -o json \
  | jq '.items[] | select(.roleRef.name=="cluster-admin") | {name:.metadata.name, subjects:.subjects}'
```

Attribute the recreation principal by reading the kube-apiserver audit log. On ACP the audit log file lives on each control-plane host at `/etc/kubernetes/audit/audit.log`; reach it by opening a shell on a control-plane host (or attaching to a debug pod that mounts the host filesystem) and reading the file directly, then filtering for the CRD path:

```bash
ssh <user>@<control-plane-host>
sudo grep '"resource":"customresourcedefinitions"' /etc/kubernetes/audit/audit.log \
  | grep 'virtualmachineinstances.kubevirt.io'
```

Each matching record is an `audit.k8s.io/v1` Event with `user.username`, `verb`, `objectRef.resource`, `requestURI`, and `responseStatus.code` fields. A `create` event whose `user.username` is anything other than `system:serviceaccount:kubevirt:kubevirt-operator` indicates the CRD was recreated by a principal other than `virt-operator` — typically the same out-of-band actor that originally deleted it.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500780
---

# VMI and virt-launcher pod not removed when a runStrategy:Manual VirtualMachine is shut down from the guest OS (CNV-71224) on ACP

## Issue

On Alauda Container Platform with KubeVirt installed via the HCO operator (`kubevirt-hyperconverged-operator.v4.3.6` CSV, `kubevirts.kubevirt.io/kubevirt-kubevirt-hyperconverged` reporting `observedKubeVirtVersion=v1.7.0-alauda.2`, virt-controller image `build-harbor.alauda.cn/3rdparty/kubevirt/virt-controller:v1.7.0-alauda.2`), a `VirtualMachine` configured with `.spec.runStrategy: Manual` is started and stopped via the `virtualmachines/start` and `virtualmachines/stop` subresources on `subresources.kubevirt.io/v1` rather than by an auto-restart policy — virt-controller logs the explicit action as `Starting VM due to start request and runStrategy: Manual` and creates the `VirtualMachineInstance` only when the `/start` subresource is invoked.

Symptom: when the guest OS of such a `runStrategy: Manual` VM is shut down from inside the guest (for example by running `poweroff` in the guest session), the `VirtualMachine` object correctly reports `STATUS=Stopped` / `READY=False`, but the associated `VirtualMachineInstance` is not deleted and remains with `PHASE=Succeeded`, and the matching `virt-launcher-<vmi>-<hash>` pod is not deleted either and remains with `STATUS=Completed`. The VM's reported state and its actual runtime objects are inconsistent at the same point in time, exactly as the upstream bug CNV-71224 describes:

```
NAME                AGE     STATUS    READY
vm-manual-demo   5m15s   Stopped   False

NAME                                    READY   STATUS      RESTARTS   AGE
virt-launcher-vm-manual-demo-6jxpk   0/3     Completed   0          4m7s

NAME                AGE    PHASE       IP         NODENAME          READY
vm-manual-demo   4m8s   Succeeded   10.0.2.2   192.168.136.179   False
```

## Root Cause

This is an upstream KubeVirt defect tracked as CNV-71224: under `.spec.runStrategy: Manual`, when the guest itself initiates the shutdown (rather than a `stop` subresource call from outside), the virt-controller transitions the `VirtualMachineInstance` to `PHASE=Succeeded` and emits the `Stopped: The VirtualMachineInstance was shut down` event, but does not subsequently delete the VMI. Because the `virt-launcher` pod's `metadata.ownerReferences[0]` points at the VMI (`apiVersion: kubevirt.io/v1, kind: VirtualMachineInstance, controller: true, blockOwnerDeletion: true`), the launcher pod cannot be garbage-collected while the VMI persists, so it lingers as `Completed`. The VM-level `printableStatus` is reconciled from the absence of a Running VMI and correctly reports `Stopped`, which produces the visible state inconsistency.

ACP ships this code path unchanged — the virt-controller image on the cluster is a v1.7.0-alauda.2 rebuild of upstream KubeVirt 1.7.0, so the same reconcile path applies and the behavior reproduces with a CentOS 7.9 containerDisk VM that runs `/sbin/poweroff` via the qemu-guest-agent. Across a 90-second observation window after the in-guest poweroff, the VMI stayed at `PHASE=Succeeded` and the virt-launcher pod stayed at `STATUS=Completed`; the virt-controller logs contain no delete/gc/restart entries for that VMI between the `Stopped` event and the end of the window. The Manual run strategy itself is working correctly here — virt-controller takes no action on a Manual VM after its VMI Succeeded, which is the intended "manual" semantics; the defect is the missing cleanup of the runtime objects, not unwanted auto-restart.

## Resolution

There is no in-cluster configuration that disables the orphan-on-guest-shutdown behavior — the fix has to land in the KubeVirt virt-controller code (CNV-71224). Until that fix is included in the deployed KubeVirt build, clean up the leftover `VirtualMachineInstance` after a guest-initiated shutdown so the `virt-launcher` pod can be garbage-collected and so the VM can be started again. Because the launcher pod has the VMI as its controller `ownerReference`, deleting the VMI is sufficient — Kubernetes garbage collection will then remove the pod automatically:

```bash
kubectl -n <vm-namespace> delete vmi <vm-name>
```

To start the same `runStrategy: Manual` VM again after cleanup, issue the start subresource (the VM's normal Manual lifecycle entry point; on this build the start endpoint accepts a PUT against the `subresources.kubevirt.io/v1` aggregated API):

```bash
# via virtctl when available:
virtctl start <vm-name> -n <vm-namespace>

# or directly against the aggregated API:
curl -sk -X PUT -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{}' \
  "https://<apiserver>/apis/subresources.kubevirt.io/v1/namespaces/<vm-namespace>/virtualmachines/<vm-name>/start"
```

When CNV-71224 is resolved in a future KubeVirt build (in upstream KubeVirt or in a later `v1.7.0-alauda.*` rebuild shipped with a newer ACP virtualization CSV), the VMI and virt-launcher pod will be removed automatically on guest-initiated shutdown and the manual `delete vmi` step will not be required.

## Diagnostic Steps

Confirm the KubeVirt build and the virt-controller image that actually owns this lifecycle. On ACP, KubeVirt lives in the `kubevirt` namespace, and the CSV name is `kubevirt-hyperconverged-operator.v4.3.*`:

```bash
kubectl get kubevirt -n kubevirt \
  -o jsonpath='{range .items[*]}{.metadata.name}{"  operatorVersion="}{.status.operatorVersion}{"  observed="}{.status.observedKubeVirtVersion}{"\n"}{end}'
kubectl get csv -n kubevirt | grep hyperconverged
kubectl get deployment -n kubevirt virt-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

Confirm the VM's effective run strategy. Under `.spec.runStrategy: Manual` the VM should only start in response to an explicit `start` subresource call, never on its own; this is what makes the post-shutdown orphan persist instead of being recycled by an auto-restart:

```bash
kubectl -n <vm-namespace> get vm <vm-name> \
  -o jsonpath='{"runStrategy="}{.spec.runStrategy}{"  status="}{.status.printableStatus}{"  ready="}{.status.ready}{"\n"}'
```

Inspect the symptom triad after the guest has been shut down from inside (for example by running `poweroff` in the guest OS or via the qemu-guest-agent). The VirtualMachine status, VMI phase, and virt-launcher pod status are the three diagnostic surfaces the article calls out:

```bash
kubectl -n <vm-namespace> get vm <vm-name>
kubectl -n <vm-namespace> get vmi <vm-name>
kubectl -n <vm-namespace> get pod -l kubevirt.io=virt-launcher
```

A reproduction shows the VM at `STATUS=Stopped READY=False`, the VMI still present at `PHASE=Succeeded` with `Ready=False(reason=PodTerminating)` in `.status.conditions`, and the launcher pod still present at `STATUS=Completed`. The `kubectl get events` stream for the namespace contains the matching `Normal Stopped The VirtualMachineInstance was shut down` and `Normal Deleted Signaled Deletion` entries from the VMI controller, despite the VMI object remaining.

Confirm that the launcher pod's persistence is a consequence of the VMI orphan (not an independent pod-GC issue) by inspecting its `ownerReferences` — the pod is owned by the VMI as `controller: true`, so it cannot be garbage-collected while the VMI exists:

```bash
kubectl -n <vm-namespace> get pod -l kubevirt.io=virt-launcher \
  -o jsonpath='{.items[0].metadata.ownerReferences}{"\n"}'
```

Confirm that the virt-controller is not attempting (and failing) some cleanup, which would point at a different problem. With CNV-71224, the controller's logs contain the `Stopped` / `Signaled Deletion` entries for the VMI but no subsequent `delete` / `garbage` / `restart` actions on that VMI — the absence of those lines is the observable signature on this build:

```bash
kubectl logs -n kubevirt deployment/virt-controller --tail=500 \
  | grep <vm-name>
```

## References

- Upstream defect tracker: CNV-71224 — Guest-initiated shutdown does not remove VMI and virt-launcher pod when runStrategy is set to Manual.

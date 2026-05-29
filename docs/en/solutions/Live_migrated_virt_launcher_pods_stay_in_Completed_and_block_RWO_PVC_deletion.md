---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Live-migrated virt-launcher pods stay in Completed and block RWO PVC deletion

## Issue

On Alauda Container Platform (Kubernetes `v1.34.5-1`, KubeVirt ModulePlugin `v1.7.0-alauda.2`, HCO operator `1.17.0`, virt-launcher image `registry.alauda.cn:60080/3rdparty/kubevirt/virt-launcher:v1.7.0-alauda.2`), after every successful live migration of a VirtualMachineInstance the source-node `virt-launcher-<vmi>-<suffix>` Pod is left in `STATUS=Completed` (Pod phase `Succeeded`) instead of being deleted; a fresh Pod on the migration target node takes over and runs the VMI. Repeated migrations of the same VMI therefore accumulate N Completed Pods alongside exactly one Running Pod in the VM's namespace, all sharing the same `virt-launcher-<vmi>-` prefix. The diagnostic pattern matches `kubectl get pods` showing many rows with `STATUS=Completed` and `READY=0/3` plus one row with `STATUS=Running` and `READY=3/3` (the `0/3` and `3/3` reflect that virt-launcher `v1.7.0-alauda.2` runs three containers per Pod — `compute`, `volumecontainerdisk`, and a sidecar; the relevant signal is "many Succeeded, one Running").

A secondary symptom appears for any VM that mounts a `ReadWriteOnce` PersistentVolumeClaim — most commonly the auto-provisioned vTPM backing PVC, but the behavior is generic: a PVC referenced by one of those leftover Completed Pods stays `STATUS=Terminating` after `kubectl delete pvc`, because the standard `kubernetes.io/pvc-protection` finalizer remains on `metadata.finalizers` until every Pod that mounts the PVC is gone.

## Root Cause

VirtualMachineInstanceMigration (`virtualmachineinstancemigrations.kubevirt.io/v1`, abbreviated VMIM in the UI; the upstream kind name is `VirtualMachineInstanceMigration`, not `VirtualMachineMigrationInstance`) is a per-migration object that tracks one VMI's move from a source host to a target host. The migration's progress is mirrored on `virtualmachineinstance.status.migrationState`, which carries `sourceNode`, `sourcePod`, `targetNode`, `targetPod`, `migrationUid`, and `completed` fields — the controller therefore distinguishes the source-side Pod from the target-side Pod throughout the migration. When migration completes successfully, libvirt is torn down on the source virt-launcher Pod and its `compute` / `volumecontainerdisk` containers exit cleanly with `exitCode=0` `reason=Completed`; KubeVirt does not delete the Pod object.

The VMIM objects themselves are garbage-collected: virt-controller retains only the most recent five Succeeded/Failed VMIMs per VMI. On a verification run that executed nine sequential `VirtualMachineInstanceMigration` resources against the same VMI, exactly five VMIM objects survived (the five most recent by `creationTimestamp`); the first four were deleted automatically. This retention threshold is hard-coded in the upstream virt-controller — `spec.configuration.migrations` on the cluster's `kubevirt` resource exposes `allowAutoConverge`, `allowPostCopy`, `completionTimeoutPerGiB`, `parallelMigrationsPerCluster`, `progressTimeout`, and `parallelOutboundMigrationsPerNode`, but no retention or completed-Pod-GC field, so the threshold is not tunable from the HyperConverged CR. The same is true for the launcher-Pod cleanup itself: `virt-controller`'s container args expose `--launcher-image`, `--exporter-image`, `--port`, and `-v`, with no `--completed-pod-gc` or equivalent flag.

The Completed Pods are tied to the VMI's lifecycle, not the VMIM's. Stopping the VM (which triggers VMI deletion, either via `virtctl stop` or via `kubectl patch vm <name> --type=merge -p '{"spec":{"runStrategy":"Halted"}}'`) cascades into deletion of every `virt-launcher-<vmi>-<suffix>` Pod: in the same verification run, the namespace went from ten Pods (nine Completed + one Running) to zero immediately after the VMI was removed, and the five surviving VMIMs were also cleaned up by owner-reference cascade.

The Terminating-PVC symptom is core Kubernetes behavior, not KubeVirt-specific. `pvc.metadata.finalizers` is declared as "must be empty before the object is deleted from the registry" — `kubectl explain pvc.metadata.finalizers` confirms the shape — and the `kubernetes.io/pvc-protection` finalizer is added automatically by `kube-controller-manager` to any PVC referenced by a Pod. Reproducing the mechanism with an ordinary `topolvm-hdd` RWO PVC mounted by a long-running Pod yielded `STATUS=Terminating` immediately after `kubectl delete pvc --wait=false`, with `metadata.deletionTimestamp` set and `metadata.finalizers=["kubernetes.io/pvc-protection"]` still present until the holding Pod was removed. The vTPM case in the original report is just the most visible instance of this rule: a vTPM-enabled VM auto-provisions an RWO PVC, and the leftover Completed launcher Pods still reference it, so the PVC waits on `pvc-protection` exactly like any other RWO PVC with a live referrer.

## Resolution

The accumulated Completed `virt-launcher-<vmi>-<suffix>` Pods are inert — their containers have already exited with `exitCode=0` and consume no CPU or memory beyond the Pod object's apiserver/etcd footprint — so leaving them in place until the VM is next stopped is a valid operating posture; the cleanest deletion path is to let the VMI teardown handle them in one shot.

When a faster reclaim is desired (most often to unblock a Terminating RWO PVC referenced by one of the Completed launcher Pods), delete the Completed Pods directly. The remaining Running virt-launcher Pod is unaffected and the VM keeps running; a verification deletion of one Completed launcher Pod left the VMI's currently-running launcher Pod `Running 3/3` throughout. Scope the delete to the Pods that are not running the VMI by selecting on `status.phase=Succeeded` so the Running launcher is never matched:

```bash
# list Completed virt-launcher Pods for one VM
kubectl get pods -n <vm-namespace> \
  --field-selector=status.phase=Succeeded \
  -l kubevirt.io/vm=<vm-name>

# delete them
kubectl delete pods -n <vm-namespace> \
  --field-selector=status.phase=Succeeded \
  -l kubevirt.io/vm=<vm-name>
```

For ongoing housekeeping, schedule the same delete as a Kubernetes `CronJob` (`batch/v1`, registered on this platform) running in the VM's namespace. The Pod field selector `status.phase=Succeeded` is the same primitive Kubernetes uses for any "finished pod" cleanup and is honored by the apiserver here (server-side dry-run of such a CronJob is accepted, and the field selector returns the expected list of Succeeded Pods cluster-wide). The job's ServiceAccount needs `get` / `list` / `delete` on `pods` in its namespace:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cleanup-completed-virt-launcher
  namespace: <vm-namespace>
spec:
  schedule: "*/30 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: launcher-cleanup
          restartPolicy: OnFailure
          containers:
            - name: kubectl
              image: <registry>/kubectl:<tag>
              command:
                - /bin/sh
                - -c
                - >
                  kubectl get pods -n <vm-namespace>
                  --field-selector=status.phase=Succeeded
                  -l kubevirt.io/vm
                  -o name | xargs -r kubectl delete -n <vm-namespace>
```

Use the `-l kubevirt.io/vm` label selector (every virt-launcher Pod carries it, stamped on by virt-controller) to restrict deletion to KubeVirt-owned Pods and avoid sweeping up unrelated Succeeded Pods such as one-shot Jobs.

For a Terminating RWO PVC that is held only by a Completed virt-launcher Pod, deleting that launcher Pod removes the last referrer, `kube-controller-manager` strips the `kubernetes.io/pvc-protection` finalizer, and the PVC's deletion completes without further intervention.

## Diagnostic Steps

Confirm the symptom against one VM. The expected shape is many Completed Pods (`READY=0/3`) plus exactly one Running Pod (`READY=3/3`), all prefixed `virt-launcher-<vmi>-`:

```bash
kubectl get pods -n <vm-namespace> -l kubevirt.io/vm=<vm-name> -o wide
```

Cross-reference Completed Pods against the migration history. On this build, `virtualmachineinstancemigrations.kubevirt.io` retains only the last five VMIMs per VMI, so the count of Completed virt-launcher Pods will typically exceed the count of surviving VMIMs after the sixth migration onward; this is expected, not a leak:

```bash
kubectl get virtualmachineinstancemigration -n <vm-namespace> \
  --sort-by=.metadata.creationTimestamp
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath="{.status.migrationState}{'\n'}"
```

The `migrationState` field is the structural marker for the source/target split — its `sourcePod` and `targetPod` names map directly to the Completed and Running Pods listed above.

For the Terminating-PVC case, list the Pods currently mounting the PVC; any Pod (Running or Completed) still referencing it will hold the `kubernetes.io/pvc-protection` finalizer in place:

```bash
kubectl get pvc <pvc-name> -n <vm-namespace> \
  -o jsonpath="{.metadata.deletionTimestamp} finalizers={.metadata.finalizers}{'\n'}"

kubectl get pods -n <vm-namespace> \
  -o jsonpath='{range .items[?(@.spec.volumes[*].persistentVolumeClaim.claimName=="<pvc-name>")]}{.metadata.name}{"\t"}{.status.phase}{"\n"}{end}'
```

Once the referrer Pods are deleted (manually or via the CronJob above), the PVC's `metadata.finalizers` array empties and the apiserver removes the object.

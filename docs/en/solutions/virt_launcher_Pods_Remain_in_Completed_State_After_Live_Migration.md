---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# virt-launcher Pods Remain in Completed State After Live Migration
## Overview

After several successive live migrations of a VirtualMachine, the cluster accumulates multiple `virt-launcher-<vm>-<hash>` pods in `Completed` state alongside the single `Running` pod that currently hosts the VM:

```text
virt-launcher-fedora-skilled-bonobo-dljkv   0/1  Completed  0  12m
virt-launcher-fedora-skilled-bonobo-k6t92   1/1  Running    0  11s
virt-launcher-fedora-skilled-bonobo-lx2th   0/1  Completed  0  54s
virt-launcher-fedora-skilled-bonobo-qdkmk   0/1  Completed  0  84s
virt-launcher-fedora-skilled-bonobo-qk5qt   0/1  Completed  0  33s
```

This is the expected behaviour of the current KubeVirt implementation — not a failure mode — but it can look alarming on a busy VM page and has one real operational consequence around vTPM PVCs.

## Root Cause

Each live migration spins up a **target** `virt-launcher` pod before the source hands off the running VM. Once the handoff completes, the source pod terminates gracefully and enters `Completed`. KubeVirt intentionally does **not** garbage-collect the source pod: operators may need the source's logs to diagnose a migration that later turns out to have degraded the workload, and the Completed pod holds a reference to any PVCs the source had mounted.

KubeVirt does garbage-collect the `VirtualMachineInstanceMigration` objects (keeping only the most recent few), and the Completed pods are all torn down automatically when the VMI itself is deleted (VM stop). A VM that migrates N times during its lifetime will therefore retain N-1 Completed pods until it is stopped.

The one side-effect worth acting on is **vTPM**. A vTPM persistent-state PVC is declared `ReadWriteOnce` because the vTPM state must be owned by a single live QEMU process at a time. While a Completed source pod still exists, it still holds a `VolumeAttachment` reference, and the PVC cannot finalise a `Terminating` state. This is visible as a PVC that appears stuck deleting.

## Resolution

Decide between leaving the pods alone (recommended for steady-state clusters) and automating a cleanup.

1. **Leave them be for short-lived VMs.** A VM that is destined to be stopped anyway will cleanse itself when stopped; no action is needed.

2. **Schedule a cleanup CronJob for long-lived VMs** that migrate frequently (HPA-driven workloads, GPU partners with heavy NUMA rebalancing). Keep the Job RBAC narrow — only the verbs needed to delete pods in the VM namespaces:

   ```yaml
   apiVersion: batch/v1
   kind: CronJob
   metadata:
     name: virt-launcher-completed-gc
     namespace: virt-launcher-gc
   spec:
     schedule: "17 */6 * * *"     # every 6 hours at :17
     concurrencyPolicy: Forbid
     successfulJobsHistoryLimit: 1
     jobTemplate:
       spec:
         backoffLimit: 0
         ttlSecondsAfterFinished: 600
         template:
           spec:
             serviceAccountName: virt-launcher-gc
             restartPolicy: Never
             containers:
               - name: gc
                 image: bitnami/kubectl:1.33
                 command:
                   - /bin/sh
                   - -ec
                   - |
                     kubectl get pod -A \
                       -l kubevirt.io=virt-launcher \
                       --field-selector status.phase=Succeeded \
                       -o json \
                     | jq -r '.items[]
                         | select((now - ((.status.containerStatuses[]?.state.terminated.finishedAt // .metadata.creationTimestamp) | fromdateiso8601)) > 3600)
                         | "\(.metadata.namespace) \(.metadata.name)"' \
                     | while read ns name; do
                         echo "deleting $ns/$name"
                         kubectl -n "$ns" delete pod "$name" --ignore-not-found
                       done
   ```

   The filter above only deletes pods that have been in `Succeeded` for more than an hour, which leaves a grace window for investigating a recently-migrated VM.

3. **Unstick a Terminating vTPM PVC** by deleting the Completed source pod that still references it. Confirm the running pod is healthy first:

   ```bash
   NS=<vm-ns>; VM=<vm-name>
   kubectl -n "$NS" get pod -l kubevirt.io=virt-launcher,vm.kubevirt.io/name="$VM" -o wide
   kubectl -n "$NS" get pvc | grep -i tpm
   kubectl -n "$NS" delete pod <stale-completed-pod>
   ```

   If the PVC still refuses to finalise, inspect `kubectl -n <ns> get volumeattachment` for stale attachments and follow up on the CSI driver side.

4. **Scope the cleanup carefully.** The filter must match *only* Completed `virt-launcher` pods. A broader `--field-selector status.phase=Succeeded` applied across all namespaces will also delete Job pods and other Succeeded workloads that the cluster is still using as audit references.

## Diagnostic Steps

Count Completed virt-launcher pods per VM:

```bash
kubectl get pod -A -l kubevirt.io=virt-launcher \
  --field-selector status.phase=Succeeded \
  -o json \
| jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.labels["vm.kubevirt.io/name"])"' \
| sort | uniq -c | sort -rn | head
```

Identify Completed pods older than an hour (cleanup candidates):

```bash
kubectl get pod -A -l kubevirt.io=virt-launcher \
  --field-selector status.phase=Succeeded \
  -o json \
| jq -r '.items[]
    | select((now - (.metadata.creationTimestamp | fromdateiso8601)) > 3600)
    | "\(.metadata.namespace)\t\(.metadata.name)"'
```

Confirm a stuck PVC is being held by a Completed source pod, not by the Running one:

```bash
NS=<vm-ns>; PVC=<pvc>
kubectl -n "$NS" describe pvc "$PVC" | grep -i used-by -A5
```

If the `Used By` line lists more than one pod, the extras are the Completed source pods; remove them in order from oldest to newest. If `Used By` lists only the currently-Running pod and the PVC still fails to finalise, the issue is not the Completed-pod behaviour described here — investigate the CSI driver's detach path.

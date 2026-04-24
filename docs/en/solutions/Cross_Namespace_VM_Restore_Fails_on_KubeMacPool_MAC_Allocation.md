---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Velero-driven restore that targets a different namespace than the original
virtual machine fails the moment the KubeVirt object is recreated. The
admission webhook from KubeMacPool blocks the request:

```text
error restoring: admission webhook "mutatevirtualmachines.kubemacpool.io"
denied the request: Failed to create virtual machine allocation error:
Failed to allocate mac to the vm object: failed to allocate requested mac
address  groupResource=virtualmachines.kubevirt.io
logSource="/workspace/pkg/restore/restore.go:1652"
namespace=harshtest  original name=lalala  restore=adp/restore-...
```

The backup itself completes; only the cross-namespace restore is rejected.
A same-namespace restore (or a restore into a fresh cluster where the
source VM is gone) usually works without this hit.

## Root Cause

KubeMacPool keeps a cluster-wide allocation table that maps every VM to a
MAC address inside the configured pool range. When a Velero restore replays
a `VirtualMachine` object into a *new* namespace, it carries the original
spec — including the literal MAC string baked into
`spec.template.spec.domain.devices.interfaces[*].macAddress`.

KubeMacPool's mutating admission webhook
(`mutatevirtualmachines.kubemacpool.io`) sees the requested address as
already belonging to the source VM (which is still alive in the original
namespace) and rejects the new claim. The conflict is logical, not
physical: the pool will not hand the same MAC to two distinct VM objects,
even when the operator wants exactly that for migration purposes.

## Resolution

The platform-preferred path on ACP is to use the backup and virtualization
surfaces together. Under `configure/backup`, schedule the VM and its
PVCs through a Velero-backed BackupController; under `virtualization`,
restore through the VM lifecycle UI that already understands KubeMacPool's
opt-out annotations and applies them on the target namespace
automatically. Whenever the platform restore flow is available, prefer it
over hand-driving Velero CRs.

When the operator is running Velero directly (early bring-up, an
out-of-band backup tool, or a one-off cross-namespace clone), short-circuit
the webhook on the destination namespace before the restore and put the
guard back when the restore finishes:

1. **Tell KubeMacPool to ignore the destination namespace** so it stops
   policing the inbound VM allocation:

   ```bash
   kubectl label namespace <destination-ns> \
     mutatevirtualmachines.kubemacpool.io=ignore
   ```

2. **Run the restore** through Velero or `kubectl apply` on the rendered
   `Restore` object. With the label in place the webhook is bypassed and
   the VM is admitted with its original MAC.

   ```bash
   kubectl apply -f restore.yaml
   ```

3. **Re-arm the webhook** on the destination namespace as soon as the
   restored VM reports `Ready`:

   ```bash
   kubectl label namespace <destination-ns> \
     mutatevirtualmachines.kubemacpool.io-
   ```

4. **Decide what happens to the source VM.** Two live VMs cannot share a
   MAC on the same broadcast domain. If the restore is meant to *move*
   the workload, delete the original VM (`kubectl -n <source-ns> delete vm
   <name>`) before the restored VM is started; KubeMacPool will then free
   the entry on the next reconcile. If the goal is a clone, edit the
   restored VM and clear `spec.template.spec.domain.devices.interfaces[*]
   .macAddress` so KubeMacPool allocates a fresh MAC on first boot.

## Diagnostic Steps

Inspect the Velero pod to confirm KubeMacPool is the rejecter (a generic
"restore failed" log line is unhelpful — look for the webhook name):

```bash
kubectl -n <velero-ns> logs deploy/velero | grep mutatevirtualmachines
```

List existing MAC reservations to spot the conflict:

```bash
kubectl get virtualmachines -A \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"\t"}{.spec.template.spec.domain.devices.interfaces[*].macAddress}{"\n"}{end}'
```

Confirm the destination namespace carries the bypass label during restore
and not afterwards:

```bash
kubectl get ns <destination-ns> --show-labels
```

If the webhook is still rejecting after the label is applied, the
KubeMacPool deployment may have a stale cache; restart it and try the
restore again:

```bash
kubectl -n kubemacpool-system rollout restart deployment/kubemacpool-mac-controller-manager
```

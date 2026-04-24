---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A VirtualMachine configured with `spec.runStrategy: Manual` is shut down from **inside the guest OS** (a `shutdown -h now`, a Windows Start-menu shutdown, or a power-button event from the guest). The `VirtualMachine` object correctly transitions to `Stopped`, but the companion `VirtualMachineInstance` and the `virt-launcher` pod are **not** cleaned up — they linger in `Succeeded` / `Completed` state indefinitely, holding node resources (memory allocations, disk attachments) and occupying pod slots:

```text
$ kubectl get vm
NAME             STATUS     READY
vm-1-example     Stopped    False

$ kubectl get vmi
NAME             PHASE
vm-1-example     Succeeded     # <-- should have disappeared

$ kubectl get pod -l kubevirt.io/domain=vm-1-example
NAME                            STATUS
virt-launcher-vm-1-...-jtx45    Completed     # <-- same
```

External shutdown (`virtctl stop`, deleting the VMI) does clean everything up. The issue is specifically with the **guest-initiated** path combined with `runStrategy: Manual`.

## Root Cause

A VM's lifecycle in KubeVirt is coordinated by the controller watching the `runStrategy`:

- `Always` / `RerunOnFailure`: the controller keeps a VMI alive; after guest shutdown, it reaps the `Succeeded` VMI and launches a new one (or stops, depending on the strategy).
- `Halted`: the controller keeps the VMI torn down; any attempt to start it is reverted.
- **`Manual`**: the controller leaves the decision to operator actions (`virtctl start/stop`). It does **not** reap a `Succeeded` VMI on its own, because doing so would conflict with the "only the operator decides" contract implicit in `Manual`.

The bug is in the reconciliation of `Manual`: when the guest shuts itself down, the VMI transitions to `Succeeded` through kubelet's normal pod-phase reporting, but neither the VM controller nor the VMI controller deletes the VMI object. The `VirtualMachine`'s `status.ready: False` and `STATUS: Stopped` reflects that the guest is no longer running, but the underlying VMI / virt-launcher sits around — no one has the authority (or the code path) to remove it.

Engineering has a fix tracked in KubeVirt; until it lands, the VMI can be deleted manually to release the resources, or the `runStrategy` can be changed to one that does reap automatically.

## Resolution

### Workaround 1 — delete the VMI manually after each guest shutdown

After any in-guest shutdown of a `runStrategy: Manual` VM, the operator (or a tool on their behalf) must delete the stale VMI:

```bash
kubectl -n <ns> delete vmi <vm-name>
```

Deleting the VMI also reaps the `virt-launcher` pod. The `VirtualMachine` object's status stays `Stopped`, which is correct.

Subsequent `virtctl start <vm>` creates a fresh VMI without interference.

### Workaround 2 — use a different runStrategy

If the operational model does not require `Manual`-level control, switch to one of the auto-reaping strategies:

- `RerunOnFailure` — the VM restarts only after a **failure** exit, not after a clean shutdown. A clean guest shutdown leaves the VM `Stopped`, and the controller cleans up the VMI as part of the transition.

  ```yaml
  spec:
    runStrategy: RerunOnFailure
  ```

- `Always` — the VM always has a running VMI; an in-guest shutdown triggers a fresh restart. Not appropriate if the workload expects "stay down until operator starts me".

- `Halted` — the VM is forcibly kept off until an operator action changes the strategy back. Not usually what `Manual` users want, but viable if "stay down" is the normal state.

Pick the strategy that matches the intended VM lifecycle. `Manual` is the most permissive but carries this cleanup gap.

### Workaround 3 — script the cleanup

If the organisation needs `runStrategy: Manual` semantics but does not want operators to hand-delete VMIs every time a guest shuts down, a small controller / CronJob can do the job:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: vmi-succeeded-reaper
  namespace: cluster-virt
spec:
  schedule: "*/5 * * * *"
  successfulJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: vmi-reaper
          restartPolicy: OnFailure
          containers:
            - name: reap
              image: bitnami/kubectl:latest
              command: ["sh","-c"]
              args:
                - |
                  # Delete any VMI whose phase is Succeeded and whose parent
                  # VM has runStrategy=Manual with status.ready=false.
                  kubectl get vmi -A -o json | \
                    jq -r '.items[]
                           | select(.status.phase=="Succeeded")
                           | "\(.metadata.namespace) \(.metadata.name)"' | \
                  while read -r ns name; do
                    rs=$(kubectl -n "$ns" get vm "$name" \
                           -o jsonpath='{.spec.runStrategy}' 2>/dev/null || true)
                    if [ "$rs" = "Manual" ]; then
                      echo "Deleting stale VMI $ns/$name"
                      kubectl -n "$ns" delete vmi "$name" --wait=false
                    fi
                  done
```

Give the `vmi-reaper` ServiceAccount the RBAC needed for the listed operations, then schedule. Five minutes is a reasonable cadence — frequent enough to release resources before a second VM lifecycle collision, infrequent enough that the job does not add load.

### Stop using this workaround once the fix lands

Track the KubeVirt / VM-operator release notes and, once a version with the fix is available, upgrade and remove the CronJob / reaper. The upgraded controller will reap automatically.

## Diagnostic Steps

Confirm the symptom:

```bash
NS=<vm-ns>; VM=<vm-name>
kubectl -n "$NS" get vm "$VM" \
  -o jsonpath='{.spec.runStrategy}{"\t"}{.status.ready}{"\t"}{.status.printableStatus}{"\n"}'
# Manual	false	Stopped

kubectl -n "$NS" get vmi "$VM" -o jsonpath='{.status.phase}{"\n"}'
# Succeeded      <-- leaked

kubectl -n "$NS" get pod -l kubevirt.io/domain="$VM" \
  -o jsonpath='{.items[*].status.phase}{"\n"}'
# Completed      <-- same
```

`Stopped` on the VM plus `Succeeded`/`Completed` on the VMI/pod plus `runStrategy: Manual` is this bug.

Check for guest shutdown events in the VMI's conditions to distinguish from an infrastructure-side failure:

```bash
kubectl -n "$NS" get vmi "$VM" -o json | \
  jq '.status.conditions[] | {type, status, reason, message}'
```

A condition reasons of `GuestPowerRequestReceived` or similar (depending on the agent's reporting) confirms the shutdown originated from inside the guest. Infrastructure-initiated shutdowns (node failure, live-migration failure) produce different reasons and are not this note.

After applying the workaround (manual delete or CronJob reaper), re-check:

```bash
kubectl -n "$NS" get vmi "$VM" 2>&1 | grep -c "not found"
# 1 = the VMI is gone
```

And confirm the VM can be restarted cleanly:

```bash
virtctl -n "$NS" start "$VM"
kubectl -n "$NS" get vmi "$VM" -w
```

A fresh VMI reaches `Running` as expected. Without the workaround, the start command would have to contend with the stale VMI left over from the last shutdown.

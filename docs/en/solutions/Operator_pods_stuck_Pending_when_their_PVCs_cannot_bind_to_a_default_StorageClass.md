---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500303
---

# Operator pods stuck Pending when their PVCs cannot bind to a default StorageClass

## Issue

An operator-driven deployment whose components require persistent storage can fail to come up when the PersistentVolumeClaims those components create never bind. A PersistentVolumeClaim that does not set `spec.storageClassName` falls back to the cluster's default StorageClass for dynamic provisioning, so the claim depends on a StorageClass being marked default in the cluster (standard Kubernetes dynamic-provisioning semantics, present unchanged on Alauda Container Platform Kubernetes v1.34.5). When such a claim requests the default class but no StorageClass is marked default, the claim stays in the `Pending` phase and is never bound. A Pod that mounts a PersistentVolumeClaim stuck in `Pending` cannot have its containers created and remains in the `Pending` phase until the claim binds.

## Root Cause

The `status.phase` of a PersistentVolumeClaim is one of `Bound`, `Lost`, or `Pending`; `Pending` means the claim has not yet been bound to a volume. A claim that omits `spec.storageClassName` is routed to whichever StorageClass carries the default marker, and with no default present there is no StorageClass to provision against, leaving the claim in `Pending` indefinitely. Because the consuming Pod's containers are only created once its claims bind, the Pod's own `status.phase` stays `Pending` — accepted by the scheduler but with containers not yet created — for as long as the claim is unbound.

## Resolution

Ensure exactly one StorageClass in the cluster is marked default. On Alauda Container Platform a default StorageClass `topolvm-hdd` ships out of the box (provisioner `topolvm.cybozu.com`, binding mode `WaitForFirstConsumer`), so a claim that omits `spec.storageClassName` has a default to bind against and the condition described here does not arise on a default cluster. Where no StorageClass carries the default marker, mark one by setting the annotation `storageclass.kubernetes.io/is-default-class` to `"true"` on it:

```bash
kubectl patch storageclass <name> \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

Once a default StorageClass exists, a PVC that omits `spec.storageClassName` binds against it under standard Kubernetes dynamic-provisioning behavior, leaving the `Pending` state behind. As their claims bind, the operator's previously-Pending Pods can have their containers created and proceed past `Pending`.

## Diagnostic Steps

List the StorageClasses to confirm whether one is marked default. The class carrying the `storageclass.kubernetes.io/is-default-class` annotation is shown with a `(default)` suffix next to its name:

```bash
kubectl get storageclass
```

```text
NAME   PROVISIONER          RECLAIMPOLICY   VOLUMEBINDINGMODE     ALLOWVOLUMEEXPANSION   AGE
topolvm-hdd (default)   topolvm.cybozu.com   Delete          WaitForFirstConsumer   true                   14d
```

If no entry shows `(default)`, no StorageClass is marked default, and a claim that omits `spec.storageClassName` has nothing to bind against. Inspect a stuck claim to confirm it is the unbound storage that is holding the Pod back; describing it surfaces the claim's `status.conditions`, where the reason it has not bound is reported, and the `status.phase` shows `Pending` rather than `Bound`:

```bash
kubectl describe pvc <name> -n <namespace>
```

A claim reporting `Pending` with a missing-default-StorageClass reason confirms the diagnosis; once a default StorageClass exists, a PVC that omits `storageClassName` binds against it under standard Kubernetes behavior and the consuming Pod can start.

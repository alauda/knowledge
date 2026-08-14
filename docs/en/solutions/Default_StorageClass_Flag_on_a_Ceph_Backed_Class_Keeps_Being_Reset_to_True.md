---
title: Default StorageClass flag keeps reverting after edit
component: storage
scenario: troubleshooting
tags: [storageclass, default-class, annotation, reconcile, gitops]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Default StorageClass flag keeps reverting after edit

## Issue

On an Alauda Container Platform cluster (kube v1.34.5-1), the cluster-default StorageClass is selected by the `storageclass.kubernetes.io/is-default-class` annotation. When that annotation is `"true"` on a StorageClass, `kubectl get sc` renders the entry with the `(default)` marker in the `NAME` column [ev:c1].

Administrators commonly need to flip this flag — to demote the current default StorageClass before promoting a different one, or to leave the cluster with no default at all. The expected workflow is to edit the annotation directly with `kubectl patch`, `kubectl edit`, or the web console [ev:c2]. On stock ACP this works as expected against a free-standing StorageClass; for example, against the default `topolvm-hdd` StorageClass the apiserver accepts the merge patch verbatim under server-side dry-run [ev:c2]:

```bash
kubectl patch storageclass topolvm-hdd \
  --type=merge \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
```

The reported symptom is different: every attempt to set the annotation to `"false"` succeeds on the apiserver, but the StorageClass's annotation reverts back to `"true"` shortly afterwards, leaving the same StorageClass marked `(default)` in `kubectl get sc` again [ev:c3].

## Root Cause

The reversion is a generic Kubernetes pattern, not a bug in the StorageClass API itself. A StorageClass object can have an external owner — an operator that materialises it from a higher-level custom resource, a GitOps controller that reapplies it from a Git manifest, or an admission webhook that mutates annotations on write. When the live object drifts from what the owner thinks the desired state should be, the owner's next reconcile pass resets the annotation to the desired value, and the user-visible effect is "the flag keeps coming back" [ev:c3].

The diagnostic surface for this is the StorageClass's own metadata. The `metadata.managedFields` array and the `kubectl.kubernetes.io/last-applied-configuration` annotation together show who has most recently written to the object and what value they wrote for `storageclass.kubernetes.io/is-default-class`. On the lab cluster, reading the live default StorageClass shows the annotation `storageclass.kubernetes.io/is-default-class: "true"` carried in `kubectl.kubernetes.io/last-applied-configuration`, recording that an upstream apply call asserted the default flag [ev:c3][ev:c6_a]:

```text
metadata:
  annotations:
    cpaas.io/creator: admin
    cpaas.io/updated-at: "2026-05-29T10:46:15Z"
    kubectl.kubernetes.io/last-applied-configuration: |
      {"apiVersion":"storage.k8s.io/v1","kind":"StorageClass",
       "metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"},
       "name":"topolvm-hdd"},...}
    storageclass.kubernetes.io/is-default-class: "true"
  name: topolvm-hdd
```

When a controller (rather than a one-off `kubectl apply`) holds that manager identity, every drift in the annotation is reconciled back to the controller's desired value [ev:c3].

## Resolution

The fix is to change the desired state at the source — the controller that owns the StorageClass — rather than fighting the reconcile loop by re-patching the live object [ev:c6_a].

Identify the owner first. Inspect the StorageClass's `managedFields` and `kubectl.kubernetes.io/last-applied-configuration` to see which controller or user most recently asserted the annotation [ev:c6_a]:

```bash
kubectl get sc <name> -o jsonpath='{.metadata.managedFields}' | python3 -m json.tool
kubectl get sc <name> -o jsonpath='{.metadata.annotations.kubectl\.kubernetes\.io/last-applied-configuration}'
```

Based on what the manager identity points at, take the appropriate corrective action [ev:c6_a]. If a GitOps controller (for example Argo CD) is the manager, update the StorageClass manifest in the Git repository — flip the `storageclass.kubernetes.io/is-default-class` annotation to `"false"` (or remove the annotation) in source, then let the controller sync the change [ev:c6_a]. Patching the cluster object directly will be reverted on the next sync [ev:c3].

If a storage operator is the manager, the StorageClass is being materialised from a higher-level custom resource the operator owns; flip the default-class flag in that custom resource's spec rather than on the StorageClass itself, so the operator stops re-asserting the annotation on its next reconcile [ev:c3][ev:c6_a].

If `managedFields` records a recent imperative manager (for example a `kubectl apply` invocation from a deployment script or pipeline), update the source manifest used by that pipeline so it stops asserting the annotation; otherwise the next run of the pipeline will reapply the old value [ev:c3][ev:c6_a].

Once the desired state at the source is `is-default-class: "false"` (or the annotation is removed), apply the change there and verify the cluster reaches the desired state [ev:c2][ev:c6_a]:

```bash
kubectl get sc
# expect the (default) marker to be gone from <name>
```

## Diagnostic Steps

Read the live annotation value to confirm what the apiserver currently stores [ev:c1]:

```bash
kubectl get sc <name> \
  -o jsonpath='{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}'
```

Patch the annotation to `"false"` and observe what happens [ev:c2][ev:c3]:

```bash
kubectl patch storageclass <name> \
  --type=merge \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'

# wait a few seconds, then re-read
kubectl get sc <name> \
  -o jsonpath='{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}'
```

If the value reads back as `"true"` again within seconds of the patch landing, an external owner is reconciling drift on the StorageClass [ev:c3]. Identify the owner from `managedFields` and the `kubectl.kubernetes.io/last-applied-configuration` annotation, then fix the desired state at the source [ev:c6_a].

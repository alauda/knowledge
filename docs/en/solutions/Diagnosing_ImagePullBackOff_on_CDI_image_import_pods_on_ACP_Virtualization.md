---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500263
---

# Diagnosing ImagePullBackOff on CDI image-import pods on ACP Virtualization

## Issue

On Alauda Container Platform Virtualization, an image-import pod can become stuck in the `ImagePullBackOff` state and remain there in `kubectl get pods` long after it was created — observed on a node debug pod that stayed `ImagePullBackOff` for roughly 38 hours rather than being cleaned up. When a kubelet cannot successfully pull a pod's container or disk image, the pod does not proceed to `Running`; it stays in `ImagePullBackOff` while the kubelet retries the pull with exponential backoff, and the pod's phase remains `Pending` with the container's `waiting.reason` set to `ImagePullBackOff`. A pod whose image pull keeps failing is not garbage-collected on failure — it persists in the `ImagePullBackOff` state in pod listings rather than disappearing, so the stuck pod stays visible until the underlying pull problem is resolved.

The affected pods in this scenario are CDI image-import pods belonging to a `DataImportCron`, which periodically attempt to download OS base disk images (such as community Linux base images) from a source image registry. Two facts hold on the platform: the `dataimportcrons.cdi.kubevirt.io` CRD is present, and a `kubevirt-hyperconverged` HyperConverged instance exists in the `kubevirt` namespace.

## Root Cause

`ImagePullBackOff` arises when the image cannot be obtained — the source image registry is unreachable or unconfigured, or the pull is unauthorized or denied. An import pod whose `DataImportCron` source points at a registry that the node cannot reach therefore remains stuck in that state; in the observed case the pull failed with a `dial tcp ... i/o timeout` against the registry, the kubelet recorded a `BackOff` event with `Back-off pulling image`, and the pod never advanced past the pull. Because the kubelet keeps retrying the same unreachable target with backoff, the pod neither succeeds nor terminates.

## Resolution

First confirm the pod really is blocked on the image pull and identify the image it is trying to fetch. Import pods run in the namespace of the configured `DataImportCron`'s target DataSource/DataVolume — not necessarily `kubevirt` — so locate the failing pod across namespaces (or in the specific `DataImportCron` namespace) and inspect it; the `STATUS` column shows `ImagePullBackOff` and the container's `waiting.reason` matches, and the events on the pod carry the kubelet `BackOff` message naming the image being pulled. Import pods appear only where `DataImportCron` resources are actually configured, and since no common-boot-image set is delivered by default, a default install may list none.

```bash
kubectl get pods -A
kubectl describe pod -n <dataimportcron-namespace> <import-pod-name>
```

Resolving the condition means making the source image registry reachable and the pull authorized from the cluster nodes — for example by configuring network reachability or a registry mirror, and supplying valid pull credentials — so that the kubelet's next backoff retry can complete the pull and the import pod advances out of `ImagePullBackOff`. The stuck pod clears once the pull succeeds; it persists only while the pull keeps failing.

The set of OS base disk images that `DataImportCron` resources import is governed at the platform level. On this platform the `kubevirt-hyperconverged` HyperConverged instance in the `kubevirt` namespace (HyperConverged operator version 1.17.0, `hco.kubevirt.io/v1beta1`) carries a `spec.enableCommonBootImageImport` field that defaults to `true`, and its `dataImportCronTemplates` are shipped empty in both spec and status — no common-boot-image set is delivered by default — so the import pods present on a given cluster reflect the `DataImportCron` resources actually configured there.

Read the current value of the toggle from the HyperConverged instance:

```bash
kubectl get hyperconverged kubevirt-hyperconverged -n kubevirt \
  -o jsonpath='{.spec.enableCommonBootImageImport}'
```

Set the field to control whether the common boot-image import is enabled on the instance:

```bash
kubectl patch hyperconverged kubevirt-hyperconverged -n kubevirt --type=json \
  -p '[{"op":"replace","path":"/spec/enableCommonBootImageImport","value":false}]'
```

## Diagnostic Steps

Enumerate the `DataImportCron` resources to map an `ImagePullBackOff` import pod back to the cron that spawned it and the OS base disk image it targets; the CRD `dataimportcrons.cdi.kubevirt.io` is served on the platform.

```bash
kubectl get dataimportcrons.cdi.kubevirt.io -A
```

For a stuck pod, the kubelet's recorded events are the authoritative signal: a `Failed to pull` entry with a `dial tcp ... i/o timeout` points at an unreachable registry, while an unauthorized or denied pull points instead at missing or invalid credentials; either way the kubelet falls back to `ImagePullBackOff` and keeps retrying with backoff rather than failing the pod outright.

```bash
kubectl describe pod -n <dataimportcron-namespace> <import-pod-name>
```

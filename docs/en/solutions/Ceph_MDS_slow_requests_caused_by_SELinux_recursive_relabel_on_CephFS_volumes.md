---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500022
---

# Slow pod start from recursive SELinux relabeling of large persistent volumes

## Issue

On Alauda Container Platform (Kubernetes v1.34.5) a pod that mounts a persistent volume can take a long time to reach a running state when the volume holds a large number of files. When a pod requiring a volume is created, kubelet instructs the container runtime to relabel the volume with the pod's SELinux context on mount; "Recursive" relabeling means the container runtime relabels every file on all of the pod's volumes, and the upstream API description warns that this may be slow for large volumes [ev:c1]. The delay grows with the number of files in the persistent volume, so volumes containing many files are the most affected [ev:c5].

## Root Cause

The recursive relabel walks the entire volume tree rather than only the mount point: the container runtime relabels every file on all of the pod's Pod volumes [ev:c2]. Cost therefore scales with the size of the volume's file population, and the API description explicitly anchors "may be slow for large volumes" as the documented behavior [ev:c5]. The pod's SELinux context itself derives from the standard core/v1 `spec.securityContext.seLinuxOptions` field that requests the context applied to the pod's containers [ev:c1]. The deeper per-syscall mechanism (whether the runtime issues an explicit `setxattr` per file, batches via an `-o context` remount, or uses another primitive) is an implementation detail of the container runtime and is not asserted by the Kubernetes API description; this article therefore stays at the documented "relabels every file, slow for large volumes" granularity rather than naming the specific syscall.

## Resolution

The Kubernetes API offers a conditional alternative to recursive relabel: `seLinuxChangePolicy: MountOption` mounts eligible Pod volumes with the `-o context` mount option, avoiding the per-file relabel walk on the volumes that qualify; other volumes are always re-labelled recursively [ev:c6]. Whether this path is available on a given cluster depends on the CSI driver: a driver must advertise support by setting `spec.seLinuxMount: true` on its `CSIDriver` object, and the field defaults to `false`, so by default no driver participates [ev:c6].

Inspect whether the CSI driver backing the volume already announces `-o context` support:

```bash
kubectl get csidriver <driver-name> -o jsonpath='{.spec.seLinuxMount}'
```

When the command returns `true`, eligible volumes are mounted with the context applied as a mount option rather than relabeled file-by-file [ev:c6]. When it returns `false` (or the field is unset, which means the default `false`), the driver does not participate in MountOption and recursive relabel remains the behavior for those volumes [ev:c6]. On this verification cluster the only CSI driver present is `topolvm.cybozu.com`, which reports `seLinuxMount=false`, so MountOption is not an effective remedy for topolvm-backed volumes here — operators relying on topolvm should treat the recursive-relabel cost as the working behavior and reduce file counts on affected volumes rather than expect MountOption to apply [ev:c6].

## Diagnostic Steps

Confirm the pod requests an SELinux context by reading its `securityContext`; the context applied to the pod's containers is carried in the standard `spec.securityContext.seLinuxOptions` field [ev:c1].

```bash
kubectl get pod <pod-name> -o jsonpath='{.spec.securityContext.seLinuxOptions}'
```

Correlate slow pod start with volume size: the relabel-induced delay grows with the number of files in the persistent volume, so a volume known to hold many files is the expected culprit when start time is high [ev:c5]. Because the recursive policy relabels every file on the Pod's volumes, file count on the mounted volume is the load-bearing quantity rather than the volume's byte size [ev:c2].

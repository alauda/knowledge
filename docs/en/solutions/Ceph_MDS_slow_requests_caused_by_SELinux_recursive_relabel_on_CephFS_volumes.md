---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500022
---

# Ceph MDS slow requests caused by SELinux recursive relabel on CephFS volumes

## Issue

Pods that mount a CephFS PersistentVolume take a very long time to become Ready, and the MDS in the ACP Ceph storage stack records `slow request` warnings for `setxattr` on `security.selinux`. Representative entries from the MDS:

```text
[WRN] slow request 30.308475 seconds old, received at 2022-10-08 11:24:01.491429:
client_request(client.898845:3819 setxattr #0x10001d1111d security.selinux ...
caller_uid=0, caller_gid=0{}) currently submit entry: journal_and_reply
```

Meanwhile the MON pods escalate this to cluster-health warnings:

```text
log_channel(cluster) log [WRN]: Health check failed:
1 MDSs report slow requests (MDS_SLOW_REQUEST)
```

The affected PVC is a CephFS `ReadWriteMany` volume with a large number of small files.

## Root Cause

When kubelet mounts a volume into a pod, the container runtime is asked to relabel the entire volume tree to match the pod's SELinux context. For a CephFS subvolume that contains hundreds of thousands of files, this means an equivalent number of `setxattr(security.selinux, ...)` syscalls, each of which lands on the MDS as a metadata journal operation.

Because the MDS must journal every `setxattr` before reply, a recursive relabel saturates the MDS metadata IOPS and starves other clients. Long-running `setxattr` calls then trip the `slow request` threshold and, once enough pile up, the MON promotes them to `MDS_SLOW_REQUEST` cluster health warnings. The hotter the CephFS (many files, frequent mounts), the more visible the effect.

## Resolution

There are two levers. Prefer option 1; option 2 is a mitigation when the pod owner cannot tolerate any relabel cost at all.

1. **Match the pod security context to the volume so kubelet skips the recursive relabel.**

   Kubernetes honours the `SELinuxMountReadWriteOncePod` / `SELinuxChangePolicy` mechanism for CSI volumes that advertise `seLinuxMount: true`. When the volume is already labelled with a type that the pod's `seLinuxOptions` requests, kubelet mounts with the correct context and does not walk the tree. In the pod spec:

   ```yaml
   apiVersion: v1
   kind: Pod
   spec:
     securityContext:
       seLinuxOptions:
         level: "s0:c123,c456"
         type: container_file_t
     containers:
       - name: app
         image: myapp:latest
         volumeMounts:
           - name: data
             mountPath: /data
   ```

   Set a stable, explicit SELinux level/type on the pod (or its controller template) and ensure the CephFS subvolume is pre-labelled to the same type. After this, kubelet mounts the volume with `context=` and avoids the `setxattr` walk.

2. **Disable the recursive relabel for the affected pod by using `SELinuxRelabelPolicy: Recursive` opt-out patterns, or by mounting with `context=` at the CSI level.**

   For CephFS CSI, the relabel can be avoided per-PV by declaring `seLinuxMount: true` on the `CSIDriver` object and pinning a stable label on the pod. This is a cluster-wide property of the CSI driver; confirm before editing:

   ```bash
   kubectl get csidriver cephfs.csi.ceph.com -o yaml
   ```

   If the CSI driver already advertises `seLinuxMount: true` and the pod has `seLinuxOptions` set, the relabel will not happen on subsequent mounts. Validate this by watching MDS `setxattr` counts during a pod restart.

As a last resort for legacy workloads that cannot be given an explicit SELinux context, split the workload onto a smaller subvolume so the one-time relabel cost is bounded. Do not disable SELinux on the node OS — it compromises isolation for other tenants.

## Diagnostic Steps

Confirm the slow requests are SELinux `setxattr` and not another Ceph metadata problem:

```bash
kubectl logs -n <ceph-namespace> <mds-pod> | grep -E "slow request|setxattr #.*security.selinux"
```

Check the cluster-health escalation on the MONs:

```bash
kubectl logs -n <ceph-namespace> <mon-pod> | grep MDS_SLOW_REQUEST
```

Count the files in the problem subvolume from a pod that already has it mounted (an unaffected reader is fine):

```bash
kubectl exec -n <ns> <reader-pod> -- sh -c 'find /data -xdev | wc -l'
```

If that count is in the high hundreds of thousands, the recursive relabel is the likely trigger and the resolution steps above apply. Correlate the slow-request spikes with pod start times reported by the kubelet:

```bash
kubectl get events --sort-by=.lastTimestamp | grep -E "FailedMount|SlowMount|Started"
```

After applying the fix, restart one consumer pod and watch the MDS logs — the `setxattr` storm should not reappear.

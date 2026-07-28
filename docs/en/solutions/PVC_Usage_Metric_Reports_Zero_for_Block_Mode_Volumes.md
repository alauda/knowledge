---
title: PVC usage metric reports zero for Block-mode volumes backing virtualization workloads
component: virtualization
scenario: troubleshooting
tags: [pvc, kubevirt, csi, kubelet, topolvm, monitoring, fstrim, discard]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# PVC usage metric reports zero for Block-mode volumes backing virtualization workloads

## Issue

On Alauda Container Platform, a `PersistentVolumeClaim` whose `spec.volumeMode` is `Block` is presented to its consumer as a raw block device with no filesystem at the PVC level — for example a pod consuming the PVC via `volumeDevices` sees `/dev/xvda` (character class `b`, no mount table entry) rather than a mounted directory [ev:c1]. When such a PVC backs a KubeVirt VM disk, the platform's PVC-level utilization metrics report `0` even when data has been written into the volume, so storage can quietly fill up without any monitoring signal [ev:c4][ev:c5_a]. The kubelet's per-volume capacity / used / available numbers — the source the kubelet exports for `kubelet_volume_stats_used_bytes` and `kubelet_volume_stats_available_bytes` — flow from the CSI NodeService `NodeGetVolumeStats` RPC; the same shape is exposed by `/api/v1/nodes/<node>/proxy/stats/summary` [ev:c2].

A representative observation on a stock ACP cluster (kubernetes `v1.34.5`, default CSI driver `topolvm.cybozu.com`) with a `Filesystem`-mode PVC and a `Block`-mode PVC mounted into the same pod on the same StorageClass `topolvm-hdd` is:

```text
# Filesystem-mode PVC
{ "name": "fs", "capacityBytes": 57381888, "usedBytes": 10500096,
  "availableBytes": 45540352, "inodes": 16384, "inodesUsed": 12 }

# Block-mode PVC (10 MB previously written via dd to /dev/xvda)
{ "name": "blk", "capacityBytes": 67108864, "usedBytes": 0,
  "availableBytes": 0, "inodes": 0, "inodesFree": 0 }
```

## Root Cause

A `Block`-mode PVC exposes raw storage; there is no filesystem at the PVC level for the kubelet to read [ev:c1]. The CSI specification permits a driver to omit the `used` and `available` fields of the `NodeGetVolumeStats` response for volumes consumed as raw block devices [ev:c3]. ACP's default CSI driver `topolvm.cybozu.com` exercises that allowance — every Block-mode PVC it provisions therefore reports `usedBytes=0`, `availableBytes=0`, and `inodes=0` regardless of how much data the consumer has written; only `capacityBytes` is populated [ev:c4][ev:c2].

For a VM whose disk is backed by a Block-mode PVC, the kubelet never sees a filesystem, so platform monitoring cannot derive guest-filesystem utilization from PVC stats [ev:c5_a]. The only component with an accurate view of free / used bytes is the guest OS itself, which is the one running on top of the raw device [ev:c5_b].

## Resolution

Read guest-filesystem usage through the KubeVirt guest-agent surface rather than from PVC stats. The KubeVirt build shipped with ACP virtualization (`kubevirt-hyperconverged-operator.v4.3.6`, namespace `kubevirt`) exposes the upstream subresource API `subresources.kubevirt.io/v1` on each `VirtualMachineInstance`; the `filesystemlist`, `guestosinfo`, and `userlist` subresources are populated by the qemu-guest-agent running inside the VM and return per-mountpoint byte counts [ev:c5_b]:

```bash
kubectl get --raw \
  "/apis/subresources.kubevirt.io/v1/namespaces/<ns>/virtualmachineinstances/<vmi>/filesystemlist"
```

This is the authoritative path for "is the VM disk full?" on Block-mode PVCs, since the kubelet-side `usedBytes` will keep reading `0` [ev:c4].

To make freed guest-OS blocks actually return to the underlying storage, the discard (TRIM/UNMAP) path has to be plumbed end to end. The mechanism for filesystems is the kernel `discard` mount option, which the kernel applies to an `ext4` filesystem when the option appears on the mount line — confirmed live by remounting a `topolvm-hdd`-provisioned filesystem and observing `/proc/mounts` switch to `rw,relatime,discard` [ev:c6][ev:c8_a]. Declare this on the StorageClass or PV so dynamically provisioned filesystems pick it up automatically:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: topolvm-hdd
provisioner: topolvm.cybozu.com
mountOptions:
  - discard
```

The same mount-option mechanism only takes effect when the volume is consumed as a filesystem; a `Block`-mode PVC never enters the mount table on the host (the consumer sees a raw `/dev/<x>` device only), so `mountOptions: [discard]` is structurally inapplicable to Block PVCs [ev:c8_b].

For deleted blocks inside a VM filesystem to be reclaimed at the storage backend, the guest must issue TRIM/UNMAP — the guest filesystem decides what to discard, and the kernel forwards it down through the virtio block layer [ev:c6]. Schedule periodic `fstrim` inside the guest OS so the guest filesystem forwards the discards on its own:

```bash
# Inside the VM guest:
fstrim -v /var/log
```

The `fstrim` utility is a standard `util-linux` binary present in every Linux guest at `/sbin/fstrim` [ev:c7]. Note: running `fstrim` against the host-side mount of a `topolvm-hdd`-provisioned volume reports `FITRIM: Not supported`, since the default `topolvm-hdd` device class provisions plain (non-thin) logical volumes — the discard path that actually does work for VM disks on this stack is the guest-OS `fstrim` operating on the guest's filesystem, not host-side `fstrim` on the topolvm mount [ev:c7][ev:c6].

If finer-grained backend reclamation is required (for example to surface used capacity at the storage-array level), the additional surface has to come from the CSI driver itself; the upstream CSI spec leaves `NodeGetVolumeStats` reporting for raw block volumes to the driver implementation [ev:c3].

## Diagnostic Steps

Confirm the symptom against the kubelet stats summary endpoint (this is the same data that backs the `kubelet_volume_stats_*` series), and verify the PVC volume mode while doing so [ev:c2][ev:c4]:

```bash
# 1. PVC volume mode
kubectl get pvc <name> -n <ns> -o jsonpath='{.spec.volumeMode}'

# 2. Per-pod kubelet stats — locate the volume entry whose pvcRef matches
kubectl get --raw "/api/v1/nodes/<node>/proxy/stats/summary" \
  | jq '.pods[] | select(.podRef.namespace=="<ns>") | .volume[]
        | select(.pvcRef.name=="<pvc>")'
```

A Block-mode PVC will show `usedBytes: 0`, `availableBytes: 0`, `inodes: 0` while `capacityBytes` reflects the provisioned size [ev:c4]. The same query against a `Filesystem`-mode PVC on the same StorageClass returns the populated set of fields, which is what distinguishes "metric is broken" from "this PVC's CSI driver does not report block usage" [ev:c4][ev:c2].

Cross-check the in-guest view via the KubeVirt subresource API to confirm the VM is actually consuming space and that the lack of kubelet signal is a reporting gap rather than the disk being empty [ev:c5_b]:

```bash
kubectl get --raw \
  "/apis/subresources.kubevirt.io/v1/namespaces/<ns>/virtualmachineinstances/<vmi>/filesystemlist"
```

The CSI driver in use is visible from the StorageClass and from `kubectl get csidriver`; on stock ACP this is `topolvm.cybozu.com` with `StorageClass topolvm-hdd` set as default [ev:c3].

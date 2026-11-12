---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.x
  - 4.x
---

# Node capacity, pod limit or data disk after resizing or replacing node hardware on ACP

## Issue

After hardware work on a node, the platform does not reflect the change, or the node needs its data disk rebuilt:

- The node's CPU or memory was expanded, but the cluster still shows the old values. For example, a node expanded from 16C32G to 48C96G shows 48 cores on the host and 16 in the console; or `free -g` already shows the new memory, while the node details page shows `31.27 Gi` and the node list tooltip `63.27Gi` (Cause 1).
- Pods cannot be created because the node reached its Pod limit, or a large node (for example 1T of memory with 256 Pods at 50% memory use) should run more Pods. Is the limit a cluster or a node setting, and does an upgrade reset it? (Cause 2)
- A passthrough data disk that held `/var/lib/docker` and `/cpaas` was replaced online with a blank disk, and the node has to be recovered (Cause 3).

Related articles: *Shutting down or rebooting ACP nodes for maintenance* (cordon, drain, and node-by-node reboots), *Safely resizing CPU and memory on Alauda Container Platform nodes*, and *Changing the kubelet maxPods setting on immutable infrastructure nodes*.

## Root Cause

### Cause 1: The kubelet still reports the old capacity after a CPU or memory resize

The kubelet reports node capacity from what the OS exposes, and keeps reporting the old capacity until it is restarted. The OS itself may not expose hot-added resources: added CPUs can stay offline, and the kubelet only counts online CPUs. Memory hot-added to a VM (for example on a hyper-converged platform) can show in `free` while the node object keeps the old `Capacity` (for example `memory: 32792048Ki`, `Allocatable` `memory: 29842928Ki`) even after a kubelet restart; only a node reboot makes Kubernetes report the correct memory.

### Cause 2: maxPods in the node's kubelet configuration limits the Pod count

The Pod limit shown on the node details page (allocated and allocatable, for example `allocated: 224; allocatable: 256`) comes from `maxPods` in that node's `/var/lib/kubelet/config.yaml`, which is why it can differ between nodes and between similar clusters (for example 256 on some nodes and 210 on others):

- It is a **per-node** setting; the platform has no function to change it on all nodes of a cluster in bulk.
- It can be raised above 256, for example to 300 or 512. The node still fills up by resource requests: if Pods request large amounts of CPU or memory, the node is full before it reaches the new maximum.
- Upgrades normally do not touch this setting. If an upgrade does revert it, change it again by hand.

### Cause 3: The data disk behind /var/lib/docker and /cpaas was replaced with a blank disk

The node's runtime data (`/var/lib/docker`) and platform data (`/cpaas`) lived on two partitions of a passthrough disk. After an online replacement with a blank disk, the original data is gone and the mounts point at nothing. The new disk has to be partitioned, formatted, and mounted to the original plan with the runtime and kubelet stopped, after which images and Pod data are pulled and recreated.

The order matters for any disk change on a node. When a raw disk is added to a containerd node while kubelet and containerd were not stopped correctly and the containers on the node were not deleted, the platform registry's MinIO instances can fail to form a cluster, and restarted component Pods then stay pulling images. Stop kubelet, delete the containers on the node, and stop containerd before the disk change. Recovering the registry MinIO cluster after it has broken is not covered here.

## Resolution

### Cause 1: The kubelet still reports the old capacity after a CPU or memory resize

Restarting the kubelet is a required step after expanding a host's resources.

> **Warning:** Restarting the kubelet does not stop running containers, but the node can briefly report `NotReady`, and probes and status updates pause for a few seconds. No rollback is needed.

```bash
systemctl daemon-reload
systemctl restart kubelet.service
kubectl describe node <node-name> | grep -E -A7 '^(Capacity|Allocatable):'
```

If the value is still old, check what the OS sees:

```bash
lscpu | grep -iE '^CPU\(s\)|On-line|Off-line'
free -h
```

- **`Off-line CPU(s) list` is not empty** (for example 16 CPUs with 8-15 offline): bring the added CPUs online and restart the kubelet again, or reboot the node.

```bash
for c in /sys/devices/system/cpu/cpu[0-9]*/online; do [ "$(cat $c)" = 0 ] && echo 1 > $c; done
lscpu | grep -iE 'On-line|Off-line'
systemctl restart kubelet.service
```

- **Memory was hot-added and the node object still shows the old value after the kubelet restart**: reboot the node with the cordon, drain, and reboot procedure in *Shutting down or rebooting ACP nodes for maintenance*.

If the platform's monitoring view of the node fails with `dial tcp <addr>:11780: connect: connection refused` (HTTP 503 `ServiceUnavailable`), that is a separate problem: the load balancer's port forwarding for port 11780 to the cluster's Prometheus is misconfigured. Fix the load balancer rule; node capacity is not involved.

### Cause 2: maxPods in the node's kubelet configuration limits the Pod count

Raise `maxPods` in the kubelet configuration on each node that needs it. Add the key at the top level of the `KubeletConfiguration` if it is absent.

> **Warning:** A syntax error in `/var/lib/kubelet/config.yaml` stops the kubelet, and the node goes `NotReady`. Precondition: keep a backup copy, and make sure the Pod network has enough IP addresses for the higher Pod count. Roll back by restoring the copy and restarting the kubelet.

```bash
cp -a /var/lib/kubelet/config.yaml /var/lib/kubelet/config.yaml.bak
grep -n -i 'max' /var/lib/kubelet/config.yaml
vi /var/lib/kubelet/config.yaml        # set or add:  maxPods: <new-limit>
systemctl restart kubelet
kubectl describe node <node-name> | grep -iE -A6 'Capacity|Allocatable'
```

Expected, for `maxPods: 210`: `pods: 210` under both `Capacity` and `Allocatable`. When the other nodes cannot take the Pods because their TopoLVM space is nearly exhausted, raising the Pod limit on the nodes that still have space lets the Pods be placed.

On immutable-infrastructure nodes managed by Machine Configuration (for example HCS clusters), node files are reconciled by the platform and a direct edit is configuration drift; change `maxPods` there with *Changing the kubelet maxPods setting on immutable infrastructure nodes*.

### Cause 3: The data disk behind /var/lib/docker and /cpaas was replaced with a blank disk

Drain the node first (see *Shutting down or rebooting ACP nodes for maintenance*).

> **Warning:** Partitioning and formatting destroy everything on the target disk. Precondition: `lsblk -f` confirms the target is the new, empty disk (no filesystem, not mounted, expected size), not a disk in use, and the node is drained. Partitioning and formatting are irreversible.

1. Stop the runtime and the kubelet, and keep them from starting at boot:

```bash
systemctl stop kubelet docker
systemctl disable kubelet docker
```

2. If anything readable is still under `/var/lib/docker` or `/cpaas`, copy it elsewhere first. If the data is already lost, skip this and the copy-back later.

3. Unmount the old disk and clean up the old directories:

```bash
umount /var/lib/docker /cpaas 2>/dev/null || umount -l /var/lib/docker /cpaas
rm -rf /var/lib/docker/*        # only if anything is left on the root filesystem under the mount point
```

4. Partition and format the new disk to the original plan, with the same partition sizes and filesystem types as a healthy node (`lsblk -f` there). For Docker `overlay2` on XFS, the filesystem must be created with `ftype=1`:

```bash
lsblk -f
parted -s /dev/<new-disk> mklabel gpt
parted -s /dev/<new-disk> mkpart docker 0% <docker-size>
parted -s /dev/<new-disk> mkpart cpaas <docker-size> 100%
mkfs.xfs -n ftype=1 /dev/<new-disk-partition-1>
mkfs.xfs /dev/<new-disk-partition-2>
```

5. Point `/etc/fstab` at the new partitions by UUID, replacing the old entries, and mount them:

```bash
blkid /dev/<new-disk-partition-1> /dev/<new-disk-partition-2>
vi /etc/fstab        # UUID=<uuid-1> /var/lib/docker xfs defaults 0 0 ; UUID=<uuid-2> /cpaas xfs defaults 0 0
mount -a
findmnt /var/lib/docker; findmnt /cpaas
```

6. Copy back any backed-up data, then start and re-enable the services and uncordon the node:

```bash
systemctl enable --now docker
systemctl enable --now kubelet
kubectl uncordon <node-name>
```

The node then runs from the new data disk, and images and Pod data are pulled and recreated.

## Diagnostic Steps

1. Compare what the node object reports with what the host sees. A mismatch after a resize is Cause 1.

```bash
kubectl describe node <node-name> | grep -E -A7 '^(Capacity|Allocatable):'
lscpu | grep -iE '^CPU\(s\)|On-line|Off-line'
free -g
```

2. For Pods that cannot be created on a node, compare the running Pod count with `Allocatable: pods`, and read `maxPods`. A node at its Pod count is Cause 2.

```bash
kubectl get pods -A -o wide --field-selector spec.nodeName=<node-name> --no-headers | wc -l
kubectl describe node <node-name> | grep -iE -A6 'Allocatable'
grep -n -i 'maxPods' /var/lib/kubelet/config.yaml
```

3. After a disk replacement, check what is mounted where and compare with a healthy node. Missing or empty `/var/lib/docker` and `/cpaas` mounts are Cause 3.

```bash
lsblk -f
findmnt /var/lib/docker; findmnt /cpaas
grep -E 'docker|cpaas' /etc/fstab
```

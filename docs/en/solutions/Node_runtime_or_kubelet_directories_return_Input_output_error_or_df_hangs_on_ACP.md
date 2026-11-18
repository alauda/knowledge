---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.x
  - 4.x
---

# Node runtime or kubelet directories return Input/output error, or df hangs, on ACP

## Issue

Typical reports:

- All services scheduled to one node are abnormal, cannot be deleted, and cannot be exec'd into, and it comes back after the node is rebooted.
- `ls` under `/var/lib` prints `ls: cannot access 'containerd': Input/output error` (Chinese locale: `ls: 无法访问 'containerd': 输入/输出错误`), and the entry is listed as `d?????????`. The same can happen for `/cpaas`, which holds platform component data.
- The kubelet on one worker will not start: `failed to run Kubelet: unable to determine image API version: rpc error ... /var/lib/docker/image: input/output error`.
- After a storage failure the platform cannot select clusters or namespaces, and kube-apiserver on a master refuses connections on `6443`.
- The platform Grafana page returns `login grafana with unexpected response` (code 500) while some nodes are `NotReady` with disk problems.
- A container keeps failing with `Back-off restarting failed container`, although the same image works elsewhere.
- The platform suddenly raises many alerts, all about DaemonSets, and `df -h` on one node hangs.

These are faults in the host disks, below Kubernetes. Related article: [Node unstable from a GPU NVRM log flood, a faulty memory module, or a read-only cpuset cgroup on ACP](Node_unstable_from_a_GPU_NVRM_log_flood_a_faulty_memory_module_or_a_read-only_cpuset_cgroup_on_ACP.md) covers GPU, memory, and cgroup faults. Storage that stalls rather than fails is covered in [Node NotReady caused by network, storage or host-level faults on ACP](Node_NotReady_caused_by_network_storage_or_host_level_faults_on_ACP.md) and [Node NotReady with high load average and D-state processes on ACP](NotReady_Node_with_High_Load_and_Many_D_State_Processes.md).

## Root Cause

### Cause 1: I/O errors on the disk that holds the runtime, kubelet, or platform data

`ls /var/lib/containerd` (or `/var/lib/docker`, `/var/lib/kubelet`, `/cpaas`) returns `Input/output error`. The data disk under that directory is damaged and can no longer be read or written reliably; restarts and Pod evictions only move the symptom. Stopping containerd and cleaning up its processes helps for a while, but the fault returns.

Errors on the node:

```text
ls: cannot access 'containerd': Input/output error
d?????????  ? ? ? ? ?            containerd
FATA[0000] execing command in container: ... failed to load task: no running task found: task <container-id> not found: not found
Fail to write "stderr" log to log file "/var/log/pods/<pod-dir>/<container>/2.log" error="write ...: input/output error"
"command failed" err="failed to run Kubelet: unable to determine image API version: rpc error ... /var/lib/docker/image: input/output error"
FATA[0000] failed to try resolving symlinks in path "/var/log/pods/kube-system_kube-apiserver-<node>_<uid>/kube-apiserver/1.log": lstat /var/lib/containerd: input/output error
```

Kernel messages with them:

```text
VFS: Open an exclusive opened block device for write vdb [<pid> sgdisk].
blk_update_request: I/O error, dev sdb, sector <n>
sd 0:0:2:0: timing out command, waited 180s
XFS (dm-1): metadata I/O error in "xlog_iodone" ... error 5
XFS (dm-1): Log I/O Error Detected. Shutting down filesystem
xfs_imap_to_bp: xfs_trans_read_buf() returned error -5
```

Variants:

- **containerd data disk on a worker.** Every Pod on the node is abnormal, cannot be deleted, and `crictl exec` fails with `no running task found`. When `/var/log/pods` is a symlink into `/var/lib/containerd`, container log writes fail too. The kernel can repeat `VFS: Open an exclusive opened block device for write <disk> [<pid> sgdisk]` about every 10 seconds, meaning an `sgdisk` process keeps opening the in-use disk for writing; what starts it is not known. CNI teardown errors such as `dial unix /run/openvswitch/kube-ovn-daemon.sock: connect: connection refused` at the same time are side effects.
- **kubelet will not start on a Docker worker.** `systemctl status kubelet` shows `activating (auto-restart) (Result: exit-code)` with `status=1/FAILURE`. `mount | grep sdb` returns nothing because the disk is used through LVM; `lsblk` shows the `sdb` → `dm-*` → mount point chain.
- **`/var/lib/containerd` on a master.** kube-apiserver cannot run, `curl -k https://<apiserver>:6443` returns `Connection refused`, and the platform cannot select the cluster or its namespaces.
- **Nodes `NotReady` with faulty disks.** Platform Pods on them crash-loop, for example `kube-prometheus-grafana-*` in `cpaas-system`, which makes the Grafana page return `login grafana with unexpected response`.
- **Several directories on several nodes.** `df -h /var/lib/containerd` returns `Input/output error`, and `dmesg` shows command timeouts, `I/O error, dev sdc`, then `xfs_do_force_shutdown(0x2)`. An XFS filesystem in that state stays shut down until it is unmounted and mounted again, even after the disk is readable.
- **Formatted or broken data disks.** A custom container that mounts a file-server path keeps failing with `BackOff` because some nodes had a data disk formatted and another node had a broken disk.

### Cause 2: The root filesystem hangs

On the node, `df -h` hangs, and `strace df -h` shows it stuck on one mount point; `cd /; ls` hangs too. DaemonSet Pods on that node fail to start, so the platform raises a burst of DaemonSet alerts at once. The root disk mount is faulty and every process that touches it blocks; `df` can be stuck on a directory where no disk is actually mounted. A reboot restores the node.

## Resolution

### Cause 1: I/O errors on the disk that holds the runtime, kubelet, or platform data

1. Move workloads off the node with `kubectl cordon <node-name>` and `kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data`.
2. Give the disk errors (and any repeating `sgdisk` line with its process) to the IaaS or hardware owner to repair or replace the disk. Containers on the node cannot run normally until the disk is fixed. Stopping the runtime and cleaning up its processes is only temporary relief.
3. If the disk was replaced with an empty one, or `lsblk -f` shows a disk was formatted (its data is gone), rebuild the node data directories as in [Node capacity, pod limit or data disk after resizing or replacing node hardware on ACP](Node_capacity_pod_limit_or_data_disk_after_resizing_or_replacing_node_hardware_on_ACP.md).
4. If the same disks were repaired, cleaned, and re-added, remount the affected directories so a shut-down XFS filesystem comes back. The order below is general Linux and Kubernetes practice. containerd normally uses `KillMode=process`, so stopping it leaves `containerd-shim` processes and their containers running and still holding the mounts; stop the Pods while containerd still runs.

> **Warning:** `crictl stopp` stops every Pod sandbox on the node, including DaemonSet and static Pods; on a control-plane node that takes its kube-apiserver and etcd member offline until the kubelet starts again. Do it only when the infrastructure side confirms the disk is readable again (no new `I/O error` lines in `dmesg`), the node is drained, and, on a master, the other masters are healthy and etcd is backed up. If the mount fails, keep the services stopped and return the disk to its owner.

```bash
systemctl show containerd -p KillMode
systemctl stop kubelet
crictl stopp $(crictl pods -q)
systemctl stop containerd
ps -eo pid,cmd | grep -E 'containerd-shim' | grep -v grep   # must print nothing
umount /var/lib/containerd /cpaas
```

If `umount` reports the target is busy, find and stop what still uses it:

```bash
fuser -vm /var/lib/containerd /cpaas
lsof +f -- /var/lib/containerd
```

Then mount and start again:

```bash
mount -a
findmnt /var/lib/containerd; findmnt /cpaas
ls /var/lib/containerd > /dev/null && echo readable
systemctl start containerd kubelet
kubectl uncordon <node-name>
```

5. For a master whose `/var/lib/containerd` returns I/O errors, reboot it after the storage owner has repaired the underlying storage.

> **Warning:** Rebooting a control-plane node takes its kube-apiserver and etcd member offline until it is back. Do it only when `ls /var/lib/containerd` on that master returns `Input/output error`, the storage owner has confirmed the repair, and the other masters are healthy. A reboot cannot be undone.

```bash
systemctl reboot
# afterwards, from another master:
curl -k --max-time 5 https://<apiserver>:6443/healthz
kubectl -n kube-system get pods -l component=kube-apiserver -o wide
```

After the host-side repair, platform Pods such as Grafana return to normal on their own; check them with `kubectl -n cpaas-system get pods -o wide | grep <node-name>`.

### Cause 2: The root filesystem hangs

> **Warning:** A forced reboot kills every Pod on the node, and blocked filesystem writes may be lost. Do it only when `df` or `ls` on `/` hang and `strace` confirms the process is blocked on the filesystem. A reboot cannot be undone.

```bash
systemctl reboot -f        # use the IaaS console reset if the shell cannot run it
```

After the reboot, check for a leftover taint that keeps Pods `Pending` (for example one `alb` replica). Remove only a taint that is not one of the automatic `node.kubernetes.io/*` taints and is not part of your node-role design:

```bash
kubectl describe node <node-name> | grep -A3 Taints
kubectl taint nodes <node-name> <taint-key>:<effect>-
```

Have the IaaS owner check the root disk and its storage path so the hang does not recur.

## Diagnostic Steps

1. Disk errors and the device behind the data directories (Cause 1):

   ```bash
   dmesg -T | grep -iE 'I/O error|blk_update_request|Buffer I/O|EXT4-fs error|XFS .*error|sgdisk|exclusive opened' | tail -n 30
   findmnt -T /var/lib/containerd; findmnt -T /var/lib/docker; findmnt -T /var/lib/kubelet; findmnt -T /cpaas
   lsblk -f
   ls /var/lib/containerd > /dev/null && echo readable
   ls -ld /var/log/pods
   ```

   Expected on a healthy node: no I/O error lines and `readable`. `findmnt` and `lsblk` show the device even behind LVM or multipath. A symlinked `/var/log/pods` shares the same disk.

2. A repeating `sgdisk` line:

   ```bash
   dmesg -T | grep -c 'exclusive opened block device'
   ps -ef | grep [s]gdisk
   ```

   Record the process and give it to the IaaS owner with the disk errors.

3. On a master, an apiserver that refuses `6443` while `ls /var/lib/containerd` fails is the master variant of Cause 1:

   ```bash
   curl -k --max-time 5 https://<apiserver>:6443
   crictl ps -a | grep kube-apiserver
   ```

4. Root filesystem hang (Cause 2). Run each command with a timeout so the shell itself does not hang:

   ```bash
   timeout 10 df -h || echo "df hung"
   timeout 10 strace -f df -h 2>&1 | tail -n 5
   timeout 10 ls / > /dev/null || echo "ls / hung"
   ```

5. Many Pods on one node failing while the kernel log is clean points elsewhere: a hung runtime is covered in [Node NotReady on ACP with kubelet "PLEG is not healthy"](Node_NotReady_with_PLEG_is_not_healthy.md), and missing containerd directories in [Control-plane Pods do not start with mkdir /var/log/pods: file exists after containerd directories are lost on ACP](Control-plane_Pods_do_not_start_with_mkdir_var_log_pods_file_exists_after_containerd_directories_are_lost_on_ACP.md).

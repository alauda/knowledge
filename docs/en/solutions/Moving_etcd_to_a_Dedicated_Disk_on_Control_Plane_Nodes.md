---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

etcd on the control plane plateaus in write latency once cluster activity grows. Symptoms include `etcdserver: request timed out` warnings, elevated leader-election churn, and slow `kubectl apply` round-trips. Profiling points at `fdatasync` on the WAL, and the control plane nodes are using the same filesystem for etcd data and container runtime / OS logs. A dedicated, fast disk for `/var/lib/etcd` is the recommended fix, but the cluster is already deployed.

## Root Cause

etcd is very sensitive to storage latency. Its consensus protocol relies on synchronous journal writes, so every `fsync` on the WAL is on the critical path of every write the cluster performs. When `/var/lib/etcd` shares a disk with:

- container runtime image store and pod logs (noisy neighbour writes),
- journald / node OS activity,
- any workload using `emptyDir` on the same volume,

the resulting IO contention shows up as long p99 `backend_commit_duration_seconds` and leader changes during load spikes. Moving `/var/lib/etcd` to a dedicated, low-latency disk (ideally NVMe) isolates these writes and restores predictable performance.

On immutable-OS nodes, provisioning this additional disk is a platform-configure change, not an ad-hoc `mount` — the node reconciler must know about the mount so it survives reboots and image upgrades.

## Resolution

Plan the rollout as a **control-plane-only, one-node-at-a-time** operation. etcd must keep quorum while one member is migrated; doing two at once will break the cluster.

1. **Pre-flight hardware checks.** Confirm the target disk meets etcd's latency budget before touching production. A commonly used benchmark is `fio` with 8KiB sequential writes and `fdatasync`; the P99 fsync should be comfortably below 10 ms, ideally under 2 ms:

   ```bash
   kubectl debug node/<control-plane> -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host fio --name=etcd-writelat \
        --rw=write --ioengine=sync --fdatasync=1 --bs=8k \
        --size=512m --numjobs=1 --runtime=60 --filename=/mnt/target-disk/test \
        --group_reporting
   ```

2. **Prepare the disk via the platform's node-configuration surface.** Under `configure/clusters/nodes` add a disk declaration for the control-plane pool that:

   - partitions / formats the new device with `xfs` (recommended) or `ext4`,
   - creates a systemd mount unit for `/var/lib/etcd` with `x-systemd.requires=<device>`,
   - applies SELinux label `container_var_lib_t` so the etcd container can read/write.

   Let ACP's node reconciler roll this change onto **one** control-plane node. Do not skip this step by editing the node manually — direct edits are reverted on the next reconcile on an immutable OS.

3. **Drain and migrate the etcd member.** On the target node:

   ```bash
   NODE=<control-plane-1>
   kubectl cordon "$NODE"
   # Stop the etcd static pod by moving the manifest out of the kubelet's
   # static-pod directory. The exact path matches the platform's kubelet
   # configuration.
   kubectl debug node/$NODE -it --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host sh -c '
        mkdir -p /etc/kubernetes/manifests.staged
        mv /etc/kubernetes/manifests/etcd*.yaml /etc/kubernetes/manifests.staged/'
   ```

   Copy existing data onto the new disk **before** the mount hides the old path:

   ```bash
   kubectl debug node/$NODE -it --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host sh -c '
        rsync -aHAX /var/lib/etcd/ /mnt/new-etcd/
        mount /mnt/new-etcd /var/lib/etcd
        ls /var/lib/etcd/'
   ```

   Return the manifest to its original path so the kubelet restarts etcd on the new mount:

   ```bash
   kubectl debug node/$NODE -it --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host sh -c '
        mv /etc/kubernetes/manifests.staged/etcd*.yaml /etc/kubernetes/manifests/'
   kubectl uncordon "$NODE"
   ```

4. **Verify quorum before the next node.** Wait for the etcd cluster to report all members healthy and for the Kubernetes control plane to settle:

   ```bash
   kubectl -n kube-system get pod -l component=etcd -o wide
   kubectl get cs   # or equivalent health endpoint
   ```

   Only then start the same procedure on the next control-plane node. Proceed in strict serial order.

5. **Back out plan.** If a member fails to rejoin within ~10 minutes, restore the original manifest (without the new mount) and investigate; never simultaneously restore multiple members to their old disks.

## Diagnostic Steps

Confirm etcd is currently running on a shared filesystem:

```bash
for n in $(kubectl get node -l node-role.kubernetes.io/control-plane -o name); do
  kubectl debug "$n" -it \
    --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
    -- chroot /host sh -c 'df -h /var/lib/etcd && mount | grep /var/lib/etcd'
done
```

Baseline etcd write latency before and after migration:

```bash
kubectl -n kube-system exec etcd-<host> -- \
  etcdctl --endpoints=https://127.0.0.1:2379 \
          --cert=/etc/kubernetes/pki/etcd/server.crt \
          --key=/etc/kubernetes/pki/etcd/server.key \
          --cacert=/etc/kubernetes/pki/etcd/ca.crt \
          endpoint status -w table
```

Watch the WAL fsync histogram in Prometheus — `etcd_disk_wal_fsync_duration_seconds` should have its p99 drop substantially after the dedicated disk takes over.

Expected migration window per node is approximately the time needed to copy the etcd data directory (usually seconds to a few minutes for clusters up to a few GB). If the copy stretches beyond the kubelet's static-pod grace period, temporarily scale `--etcd-election-timeout` on the remaining members or perform the migration during low-traffic hours.

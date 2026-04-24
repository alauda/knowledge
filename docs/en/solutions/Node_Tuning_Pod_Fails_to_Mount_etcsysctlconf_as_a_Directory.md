---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After migrating sysctl management away from per-node configuration objects (which previously declared `/etc/sysctl.conf` through the platform's node-configuration surface) toward the cluster node-tuning operator, the Tuned DaemonSet pod on at least one node refuses to start. The container runtime emits an event of the form:

```text
Error: container create failed:
  rootfs_linux.go: mounting "/var/lib/kubelet/pods/<id>/volume-subpaths/etc/tuned/4"
  to rootfs ".../merged" at ".../merged/etc/sysctl.conf"
  caused "not a directory"
```

The kubelet is trying to bind-mount the tuned-managed `sysctl.conf` file into the container at `/etc/sysctl.conf`, but the host path is a directory, not a regular file. The mount source-vs-target type mismatch fails outright, the pod is stuck in `CreateContainerError`, and node-level sysctl reconciliation stops on that host.

## Root Cause

When the previous node-configuration mechanism (the platform-managed MachineConfig-equivalent) wrote sysctl entries to the node, it created `/etc/sysctl.conf` as a directory containing drop-in fragments — that's how the **Immutable Infrastructure** layer expresses overlay files when several sources contribute to the same path. Removing the configuration objects releases ownership of the path, but the directory itself stays on disk. There is no reconcile that walks back and converts directories into empty files.

The cluster node-tuning operator, by contrast, hands the Tuned DaemonSet a single regular file mounted via `subPath` at `/etc/sysctl.conf`. The container runtime requires the mount source and the mount target to be the same type (file→file, directory→directory). A file mount onto an existing directory is rejected at `runc`'s rootfs setup stage, hence the `not a directory` error.

## Resolution

1. **Confirm the underlying node configuration objects have been deleted.** Anything that still claims ownership of `/etc/sysctl.conf` will recreate the directory after each cleanup attempt.

   ```bash
   kubectl get machineconfigs.machineconfiguration.k8s.io
   kubectl get machineconfigs.machineconfiguration.k8s.io -o yaml \
     | grep -B2 sysctl.conf
   ```

   If any object still references the path, remove it through the platform's node-configuration surface (`configure/clusters/nodes`) and wait for the rollout to drain and reboot the affected nodes before proceeding.

2. **Identify the affected node and inspect the path.** A `d` as the first character of `ls -ld` confirms the diagnosis:

   ```bash
   NODE=<affected-node>
   kubectl debug node/$NODE -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host /bin/sh -c 'ls -ld /etc/sysctl.conf | head -c 1'
   ```

   Output `d` → continue with the fix. Output `-` → the host file is already a regular file, and the mount error has another cause; check container runtime status and the Tuned pod's previous logs.

3. **Replace the directory with an empty regular file.** The cluster node-tuning operator will overwrite the contents on the next reconcile; the only requirement is that the path exists and is a file.

   ```bash
   kubectl debug node/$NODE -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host /bin/sh -c '
       rm -rf /etc/sysctl.conf &&
       touch /etc/sysctl.conf &&
       chmod 644 /etc/sysctl.conf
     '
   ```

4. **Recreate the Tuned pod on that node.** The pod is part of a DaemonSet, so deleting it triggers an immediate replacement:

   ```bash
   kubectl -n cluster-node-tuning-operator get pods \
     --field-selector spec.nodeName=$NODE -l app=tuned
   kubectl -n cluster-node-tuning-operator delete pod <tuned-pod-on-that-node>
   ```

   The new pod should reach `Running` within a minute. Once it is healthy, the operator's profile reconcile will populate `/etc/sysctl.conf` with the active sysctl set.

5. **Sweep every node in the pool.** This pattern affects every node that previously carried the directory layout. Loop over all nodes in the role, run steps 2–4 against each that returns `d`, and gate on the Tuned pod going `Ready` before moving to the next host. A small for-loop avoids missing one and explaining the same outage twice.

## Diagnostic Steps

Find Tuned pods that are not yet running:

```bash
kubectl -n cluster-node-tuning-operator get pods -l app=tuned -o wide \
  | awk '$3 != "Running"'
kubectl -n cluster-node-tuning-operator describe pod <pending-pod> \
  | sed -n '/Events:/,$p'
```

The `not a directory` string in the events confirms the mount-type mismatch. After the fix, the events should switch to `Created` / `Started` and the pod's previous-state log should be empty:

```bash
kubectl -n cluster-node-tuning-operator logs <tuned-pod> --previous \
  || echo "no previous instance — clean restart"
```

Verify the file replaced the directory and the operator has populated it:

```bash
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host /bin/sh -c 'ls -ld /etc/sysctl.conf; head -n 5 /etc/sysctl.conf'
```

`-rw-r--r--` and a non-empty body mean the operator owns the file end-to-end.

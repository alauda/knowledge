---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A pod (frequently a DaemonSet pod such as `node-exporter`) on a single node refuses to start. The pod sits in `CreateContainerError`, and the namespace event log carries an entry similar to:

```text
Warning  Failed  pod/node-exporter-xxxxx
  Error: error creating read-write layer with ID
  "<container-id>":
  Stat /var/lib/containers/storage/overlay/<layer-sha>:
  no such file or directory
```

The same DaemonSet runs cleanly on every other node in the cluster. Re-pulling the image manually does not help; the pod is recreated, fails the same way, and crash-loops. Restarting the kubelet does not help either, because the kubelet correctly believes the image is "present" — the runtime metadata still references the layer that has gone missing on disk.

## Root Cause

The container runtime (CRI-O on the affected node) keeps its image layers under `/var/lib/containers/storage/overlay/`. Each image is a tree of overlay layers; the runtime's metadata index points at one directory per layer, and creating a container builds a fresh read-write layer on top of the image's existing layers.

If a single image layer directory is removed or the metadata index is desynchronised from the on-disk state — typically because of an unclean shutdown, a disk-pressure eviction in the middle of an image pull, an aborted GC pass, or a manual cleanup that strayed too deep — the metadata still references the layer but the directory is no longer there. `Stat` then returns `ENOENT`, which the runtime surfaces as the `error creating read-write layer` message.

The corruption is local to the affected node. The image itself is intact in the registry; the runtime's view of it on this one host is what is broken.

## Resolution

Two paths, depending on whether the runtime is healthy enough to clean itself up.

### 1. Soft repair: prune unused images

If `crictl` still works on the node, ask the runtime to drop unused images and re-fetch what it needs. This recovers from the common case where an evicted image has stale metadata.

1. Find the node hosting the failing pod:

   ```bash
   POD=node-exporter-xxxxx
   NS=monitoring
   NODE=$(kubectl -n $NS get pod $POD -o jsonpath='{.spec.nodeName}')
   echo "$NODE"
   ```

2. Open a debug session on the node and prune the runtime's image cache:

   ```bash
   kubectl debug node/$NODE -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host bash
   # inside the chroot:
   crictl rmi --prune
   ```

3. Trigger a pod recreate so the runtime re-pulls the missing image:

   ```bash
   kubectl -n $NS delete pod $POD
   ```

4. Watch the new pod come up; the daemonset controller will replace it on the same node:

   ```bash
   kubectl -n $NS get pods -o wide -w | grep $NODE
   ```

If the runtime cannot enumerate or remove the bad image (`crictl` errors out, or the prune itself complains about the missing layer), proceed to the hard repair.

### 2. Hard repair: drain the node and wipe container storage

This is destructive — every image cached on the node is dropped and re-pulled from the registry on the way back up. Drain the node first so workloads do not stall on missing images during recovery.

1. Drain the affected node. `--ignore-daemonsets` lets the platform's per-node services keep running while the rest of the workloads move; `--delete-emptydir-data` accepts the loss of any in-pod scratch.

   ```bash
   kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data
   ```

2. Stop the kubelet and the container runtime, then reboot. **Do this through the platform's node surface** (`configure/clusters/nodes` or the Immutable Infrastructure extension) rather than `ssh` + `systemctl` so the action is captured in the audit log and the platform's reconciler does not fight the change. The equivalent host-side commands look like:

   ```bash
   # for reference only — drive these through the node-config surface
   systemctl disable --now kubelet
   systemctl disable --now crio
   systemctl reboot
   ```

3. After reboot, wipe the runtime's image storage. `crio wipe -f` is the runtime-aware reset; the bare `rm -rf` removes everything else under the storage root.

   ```bash
   rm -rf /var/lib/containers/*
   crio wipe -f
   systemctl enable --now crio
   systemctl enable --now kubelet
   ```

4. Bring the node back into scheduling:

   ```bash
   kubectl uncordon $NODE
   ```

The runtime starts with empty storage; on the next pod schedule each image is re-pulled fresh from the registry. The original `Stat … no such file or directory` does not recur because the metadata and the on-disk state are now in sync (both empty, then both populated by fresh pulls).

### Prevent recurrence

If the same node experiences the corruption more than once, the underlying disk is the suspect, not the runtime. Check:

- the disk's SMART health (`smartctl -a /dev/<device>`);
- whether the partition holding `/var/lib/containers` is at or near capacity (image GC stalls when the disk is too full);
- the platform's own node-disk-pressure events for the node;
- the journald log around the time of the original failure for unclean shutdown markers.

A node that corrupts its image store regularly is rarely worth keeping; replace the disk or the node.

## Diagnostic Steps

1. **Confirm the symptom is the layer-missing message and not a generic image pull error**:

   ```bash
   kubectl -n $NS describe pod $POD | grep -A2 -E 'Failed|Stat /var/lib/containers'
   ```

   The string `Stat /var/lib/containers/storage/overlay/...: no such file or directory` is the marker for this issue. `ImagePullBackOff` or `ErrImagePull` is a *different* problem — the registry is unreachable, not the local store.

2. **Verify the missing layer is genuinely gone**, not just unreadable:

   ```bash
   kubectl debug node/$NODE -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host ls -ld /var/lib/containers/storage/overlay/<layer-sha> 2>&1
   ```

   `No such file or directory` confirms the layer is missing; a stat that succeeds but returns zero bytes is a different (still recoverable) problem.

3. **Check the runtime's view of the image**:

   ```bash
   kubectl debug node/$NODE -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host crictl images | grep <image-name>
   ```

   If the image is listed but pulling fails, `crictl rmi --prune` is enough; if `crictl` itself errors, the runtime metadata is too damaged for the soft repair and the hard repair is required.

4. **Inspect free space on the storage path**:

   ```bash
   kubectl debug node/$NODE -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host df -h /var/lib/containers
   ```

   A near-full filesystem is a frequent precondition for the corruption — image GC stalls and a subsequent pull leaves the metadata half-written.

5. **Cross-check across nodes** to see whether the issue is node-local or cluster-wide. A second node throwing the same error within the same hour suggests a shared storage backend or a bad image in the registry, not local disk corruption:

   ```bash
   kubectl get events -A --sort-by=.lastTimestamp \
     | grep -E 'creating read-write layer|Stat /var/lib/containers'
   ```

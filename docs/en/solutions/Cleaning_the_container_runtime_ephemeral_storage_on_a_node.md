---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Cleaning the container runtime ephemeral storage on a node
## Issue

A node hits a state where the container runtime cannot create new container sandboxes for any newly scheduled pod. Symptoms cluster around the runtime's overlay storage on `/var/lib/containers/storage/`:

- Sandbox creation fails with `failed to mount container … error recreating the missing symlinks: error reading name of symlink for X: open /var/lib/containers/storage/overlay/X/link: no such file or directory`.
- Container creation fails with `can't stat lower layer … because it does not exist. Going through storage to recreate the missing symlinks.`
- Storage cleanup fails with `Failed to remove storage directory: unlinkat /var/lib/containers/storage/overlay-containers/<id>/userdata/shm: device or resource busy`.
- The runtime is repeatedly killed by `SIGABRT` and the kubelet restarts in a loop.
- Image pulls fail at the layer-commit step with `Stat /var/lib/containers/storage/overlay/<digest>: no such file or directory`.

The remediation below wipes the runtime's ephemeral state on the affected node so that the runtime and the kubelet can come back up clean. **Do not use this as a generic remediation for slow pod startup.** In particular, errors of the form `Error reserving ctr name <name> for id <id>: name is reserved` indicate a different bottleneck, and recreating every pod will make those worse, not better.

## Resolution

The procedure has two flavours: an in-place wipe that requires no reboot (faster, but only effective when the runtime is healthy enough to be commanded to clear itself), and a reboot-based wipe (broader, used when the in-place attempt fails or the runtime cannot enumerate its pods). Pick the in-place path first; fall back to the reboot path on failure.

### Without a node reboot

1. Cordon and drain the node:

   ```bash
   kubectl cordon <node>
   kubectl drain <node> \
     --ignore-daemonsets --delete-emptydir-data --disable-eviction --force
   ```

2. Open a node-level shell on the target node — this is a host-level operation, so a debug pod with `--profile=sysadmin` is appropriate:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> -- bash
   # ACP cluster PSA rejects chroot /host; the debug pod has the host
   # filesystem bind-mounted at /host — read host paths as /host/<path>.
   ```

3. Stop the kubelet so the runtime stops getting new sandbox requests:

   ```bash
   systemctl stop kubelet.service
   ```

4. Ask the runtime to remove every pod sandbox, but keep the **host-network** pods (typically the cluster's CNI components) until last so that pod networking is not torn down for the others mid-loop. Adapt the command to the runtime in use:

   - On a CRI-O node:

     ```bash
     for pod in $(crictl pods -q); do
       if [[ "$(crictl inspectp "$pod" \
                 | jq -r .status.linux.namespaces.options.network)" != "NODE" ]]; then
         crictl rmp -f "$pod"
       fi
     done
     crictl rmp -fa
     ```

   - On a containerd node, the same logic with `crictl` is portable because `crictl` talks the CRI API regardless of runtime.

5. Continue with step 4 of the reboot path below (wipe `/var/lib/containers/`, restart the runtime).

### With a node reboot

1. Cordon and drain as in the in-place path. Confirm that you can reach the node (SSH or the platform's node-shell mechanism) **before** disabling the kubelet — the kubelet is what publishes the node's readiness, and once it is disabled there is no way to retry remotely if the host is unreachable.

2. Disable the kubelet so it does not start the runtime back up after reboot:

   ```bash
   systemctl disable kubelet.service
   ```

   The runtime is started as a kubelet dependency on most platforms, so disabling the kubelet also keeps the runtime down across reboot.

3. Reboot the node. Try a soft reboot first:

   ```bash
   systemctl reboot
   ```

   If the host does not return cleanly, use the platform's hard-reset mechanism.

4. After the node returns, before re-enabling the kubelet, wipe the runtime's storage and clear its on-disk state:

   ```bash
   systemctl stop crio.service          # or:  systemctl stop containerd.service
   rm -rvf /var/lib/containers/*
   crio wipe -f                          # CRI-O only; containerd has no equivalent
   systemctl start crio.service          # or:  systemctl start containerd.service
   ```

   If `rm -rvf` returns `Device or resource busy` on `/var/lib/containers/storage/overlay`, the runtime is still holding mounts. Stop it explicitly first, then retry.

5. Re-enable and start the kubelet:

   ```bash
   systemctl enable --now kubelet.service
   ```

6. Wait a few minutes, then confirm from a control-plane host that the node has returned to `Ready`:

   ```bash
   kubectl get node <node>
   ```

7. Uncordon the node so that the scheduler may place pods on it again:

   ```bash
   kubectl uncordon <node>
   ```

## Diagnostic Steps

1. From a control-plane host, identify the node that is failing to admit pods and confirm the symptom is runtime-side rather than scheduler-side:

   ```bash
   kubectl get pod <stuck-pod> -o wide
   kubectl describe pod <stuck-pod> | sed -n '/Events:/,$p'
   ```

   Look for `FailedCreatePodSandBox`, `RunContainerError`, or `ImagePullBackOff` events that name the same node.

2. On the affected node, capture the runtime's logs over the symptomatic window before wiping storage:

   ```bash
   journalctl -u crio.service --since "10 minutes ago"   # or containerd.service
   journalctl -u kubelet.service --since "10 minutes ago"
   ```

3. Inspect the overlay state to confirm the wipe is the right tool. A directory with **no** subdirectories under `overlay/` while the runtime reports many active containers is the canonical mismatch the procedure resolves:

   ```bash
   ls /var/lib/containers/storage/overlay/ | wc -l
   crictl ps -a | wc -l
   ```

4. If the runtime is being killed by `SIGABRT`, capture the backtrace from `journalctl` for the runtime unit before the wipe — once `/var/lib/containers/` is removed the symptom disappears, but the backtrace is the artifact that an upstream bug report needs.

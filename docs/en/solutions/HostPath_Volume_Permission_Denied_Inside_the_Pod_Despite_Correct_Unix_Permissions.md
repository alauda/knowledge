---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# HostPath Volume: Permission Denied Inside the Pod Despite Correct Unix Permissions
## Issue

A pod with a `hostPath` volume cannot list or access files inside the mounted directory. `ls`, `cat`, and `stat` all report `Permission denied`:

```bash
kubectl exec -it <pod> -- ls /mnt/host-data
ls: can't open '/mnt/host-data': Permission denied
```

Ordinary troubleshooting turns up nothing: the directory's Unix mode on the node looks generous (`drwxr-xr-x`, or even `0777`), the user inside the container maps to a UID with expected access, and other pods scheduled on the same node were working against the same directory yesterday. The problem is specifically that this pod, now, cannot read it — and the error is `Permission denied` rather than the `No such file or directory` or `Read-only file system` that indicate different failure modes.

## Root Cause

SELinux enforces a second layer of access control on top of the Unix `mode`/UID/GID triple. In an ACP cluster (and on every SELinux-enabled node), every file carries an SELinux context of the form `user:role:type:range`. Containers run under a specific type — `container_t` — and can only read/write files whose type is `container_file_t` (or other types explicitly permitted by the SELinux policy).

The context also carries a **Multi-Category Security (MCS)** range. For containers, MCS is used to isolate pods from each other: each pod is assigned a unique category pair (for example `c123,c456`), and the kubelet labels the pod's filesystem at mount time so the pod can only access files whose MCS range matches (`s0:c123,c456`) or is plain `s0` (no category restriction, universally readable).

When a `hostPath` directory on the node carries an MCS-qualified label — for example `system_u:object_r:container_file_t:s0:c123,c456` — only a container running with the matching category pair can read it. Any other pod, regardless of UID or Unix permissions, gets `Permission denied` because SELinux blocks the access at the kernel level before the filesystem even sees the request.

MCS labels on node-side directories are commonly introduced when:

- A previous pod that mounted the directory had its labels applied recursively (SELinux `chcon` or a relabel-on-mount) and was not cleaned up.
- An init container or a preceding tenant explicitly set `securityContext.seLinuxOptions` on its pod, narrowing the directory's label.
- A backup/restore tool or manual intervention copied files into the directory preserving their MCS range.

The fix is to either remove the MCS range from the directory (making it accessible to any container) or match the pod's category pair to the directory's.

## Precondition: SELinux Must Be Enforcing

This entire diagnostic only applies when the node OS has SELinux in enforcing mode. ACP supports both SELinux-enforcing distributions (CentOS Stream, AlmaLinux, Rocky Linux, Kylin V10) and non-SELinux distributions (Ubuntu, which uses AppArmor). On a non-SELinux node the symptom is the same `Permission denied`, but the cause is different — drop directly to the AppArmor / capabilities troubleshooting path.

Verify SELinux is in effect:

```bash
NODE=<node-name>
# Read the host's SELinux mode through a debug pod's /host mount
# (chroot /host is rejected by ACP's cluster-level PSA).
kubectl debug node/$NODE --image=<image-with-shell> -- sh -c '
  test -e /host/sys/fs/selinux/enforce && cat /host/sys/fs/selinux/enforce || echo "SELinux not present"
'
```

`1` means enforcing — proceed below. `0` means permissive — the kernel will not enforce MCS, so the symptom has a different cause. `SELinux not present` (Ubuntu / Debian nodes) means the article does not apply.

## Resolution

Prefer the general approach — drop the MCS range — unless the directory really should only be accessible to one pod.

### Remove the MCS label from the hostPath directory

On the node where the pod is scheduled, reset the directory's SELinux context to the generic `container_file_t:s0`. ACP's PSA rejects `chroot /host`, so run `chcon` against the directory through the debug pod's `/host` mount:

```bash
kubectl debug node/<node> --image=<image-with-policycoreutils> -- \
  chcon \
    -u system_u \
    -r object_r \
    -t container_file_t \
    -l s0 \
    /host/path/to/hostpath-directory
```

The `-l s0` flag replaces whatever MCS range was on the directory with a plain `s0` (no category restriction). The image must contain `chcon` (any CentOS/Fedora/AlmaLinux/Rocky-derived image ships it via `coreutils`); a `busybox` minimal image does not. Confirm by reading the label back:

```bash
kubectl debug node/<node> --image=<image-with-policycoreutils> -- \
  ls -Zd /host/path/to/hostpath-directory
# system_u:object_r:container_file_t:s0 /host/path/to/hostpath-directory
```

Re-run the pod (delete it and let the controller recreate, or `kubectl exec` into a fresh shell). The `ls` that previously failed now succeeds.

If the directory has subdirectories/files that inherited the narrow MCS, apply recursively:

```bash
kubectl debug node/<node> --image=<image-with-policycoreutils> -- \
  chcon -R -t container_file_t -l s0 /host/path/to/hostpath-directory
```

Recursion is safe for a pure data directory; think twice before recursing through a mixed directory that contains files the SELinux policy expects to be typed differently (for example `/var/log/*` partitions or `/etc/*` fragments).

### Match the pod's SELinux range to the directory

If the directory **should** be restricted to a specific pod (it holds secrets that only that pod should read), invert the fix: keep the MCS label on the directory and force the pod's `securityContext` to use the same MCS pair:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: authorized-reader
spec:
  securityContext:
    seLinuxOptions:
      type:  container_file_t
      level: s0:c123,c456            # match the directory's MCS range
  containers:
    - name: reader
      image: busybox
      command: ["sleep","3600"]
      volumeMounts:
        - name: host-data
          mountPath: /mnt/host-data
  volumes:
    - name: host-data
      hostPath:
        path: /path/to/hostpath-directory
        type: Directory
```

The pod now runs under `s0:c123,c456` and SELinux permits the read. Every other pod on the cluster keeps getting `Permission denied` on that directory — which was the point.

### Prefer a proper PersistentVolume over `hostPath`

HostPath volumes have several well-known gotchas beyond SELinux (node affinity, pod rescheduling losing data, shared-node privilege concerns). If the directory holds durable data, a PersistentVolume backed by a real CSI driver is the better long-term answer — the CSI driver handles SELinux labeling at mount time correctly by default, and the pod does not need to know about node-level context.

For ephemeral scratch space that is legitimately local to the node, keep HostPath but treat the SELinux fix above as a standard step in the directory's provisioning, not as a troubleshooting surprise.

## Diagnostic Steps

Reproduce the permission denied from inside the pod to confirm it is a read-time failure:

```bash
kubectl exec -it <pod> -- sh -c 'ls -la /mnt/host-data; stat /mnt/host-data'
```

`ls: can't open … : Permission denied` with no visible entries is the SELinux-blocked signature. If you can list but not read individual files, the permission block is at the file level — the same logic applies but recursively.

Inspect the pod's `hostPath` source path and the node it landed on:

```bash
kubectl get pod <pod> -o jsonpath='{.spec.nodeName}{"\n"}'
kubectl get pod <pod> -o json \
  | jq -r '.spec.volumes[] | select(.hostPath != null) | "\(.name) -> \(.hostPath.path)"'
```

Read the SELinux context of the directory as the node sees it (read through `/host`, no chroot — ACP's PSA blocks chroot):

```bash
kubectl debug node/<nodeName> --image=<image-with-shell> -- \
  ls -Zd /host<hostpath-source>
```

Any `:cXYZ,cNNN` tail on the context string confirms the MCS label, and that is what the `chcon` above removes.

If the `ls -Zd` output shows `container_file_t` without an MCS suffix and the pod still cannot read, the problem is elsewhere — double-check the SELinux audit log (`journalctl _COMM=audit` on the node, or `audit2why` against the denial record) to see the exact block reason. Possible culprits include a different SELinux type than `container_file_t`, an AppArmor profile on a non-SELinux node, or a more conventional Unix permission issue that was not ruled out at the start.

---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.1"
  - "4.2"
  - "4.3"
---

# Control-plane Pods do not start with mkdir /var/log/pods: file exists after containerd directories are lost on ACP

## Issue

Platform access is abnormal and a cluster shows an abnormal status. On a master, kubelet and containerd are both `active (running)`, but `crictl ps -a` prints nothing at all: no container exists on the node. The kubelet log repeats:

- `"Error getting node" err="node \"<node>\" not found"` and `failed to list *v1.CSIDriver`
- `"Failed to create log directory for pod" err="mkdir /var/log/pods: file exists"` for `kube-system/etcd` and `kube-system/kube-controller-manager`
- `"CreatePodSandbox for pod failed" err="mkdir /var/log/pods: file exists"` and `"Error syncing pod, skipping" err="failed to \"CreatePodSandbox\" ..."`

Related articles: "etcd and kube-apiserver do not start on a master after runc or containerd is replaced on ACP" covers masters whose runtime binaries were replaced.

## Root Cause

### Cause 1: /var/lib/containerd lost its pods and io.containerd.grpc.v1.cri directories

Under `/var/lib/containerd` on the master, the `pods` and `io.containerd.grpc.v1.cri` directories are missing. Without them the static control-plane Pods cannot create their sandboxes, and nothing runs on the node. How the directories are lost is not known.

`mkdir` returns `file exists` when the path already exists as something other than a directory, for example a symbolic link whose target has disappeared. On a node where `/var/log/pods` is a link into `/var/lib/containerd`, losing that target produces exactly this error.

Stopping kubelet and containerd, creating the two directories by hand, and starting both services again lets the containers start; the cluster status returns to Normal.

## Resolution

### Cause 1: /var/lib/containerd lost its pods and io.containerd.grpc.v1.cri directories

Apply only when `crictl ps -a` is empty, kubelet logs `mkdir /var/log/pods: file exists` for the static Pods, and `ls` confirms that the two directories are missing. Compare with a healthy master of the same cluster first:

```bash
systemctl is-active kubelet containerd
sudo crictl ps -a
sudo ls -la /var/lib/containerd
ls -ld /var/log/pods
readlink -f /var/log/pods || true
```

On the healthy master, note the owner and mode of the same entries:

```bash
sudo stat -c '%U:%G %a %n' /var/lib/containerd/pods /var/lib/containerd/io.containerd.grpc.v1.cri
ls -ld /var/log/pods
```

> **Warning:** Stopping kubelet and containerd stops container management on this master until both are started again. Do it only when this cause is confirmed: no containers in `crictl ps -a`, the two directories missing, and the `mkdir /var/log/pods: file exists` error. Creating empty directories does not restore any container data that was in them; kubelet recreates the static Pods from their manifests. Rollback: start containerd and kubelet, and `sudo rmdir` a directory you created by mistake while it is still empty.

```bash
sudo systemctl stop kubelet containerd
sudo mkdir -p /var/lib/containerd/pods /var/lib/containerd/io.containerd.grpc.v1.cri
# set owner and mode to the values stat printed on the healthy master, for example:
sudo chown <owner>:<group> /var/lib/containerd/pods /var/lib/containerd/io.containerd.grpc.v1.cri
sudo chmod <mode> /var/lib/containerd/pods /var/lib/containerd/io.containerd.grpc.v1.cri
sudo systemctl start containerd
sudo systemctl start kubelet
sudo crictl ps -a
```

The etcd, kube-apiserver, and kube-controller-manager containers should appear in `crictl ps -a` within a few minutes, and the cluster status should return to Normal.

## Diagnostic Steps

```bash
systemctl is-active kubelet containerd
sudo crictl ps -a
sudo journalctl -u kubelet --since "30 min ago" | grep -E 'mkdir /var/log/pods|CreatePodSandbox' | tail -20
sudo ls -la /var/lib/containerd
ls -ld /var/log/pods; readlink -f /var/log/pods || true
```

- kubelet and containerd running, `crictl ps -a` empty, `mkdir /var/log/pods: file exists`, and `/var/lib/containerd/pods` missing: this cause.
- Containers exist but etcd exits with `StartError`, or kubelet logs `Failed to delete cgroup paths`: the runtime binaries were replaced; see the related article.
- `/var/log/pods` is a link whose target exists and the directories are present: this cause does not apply.

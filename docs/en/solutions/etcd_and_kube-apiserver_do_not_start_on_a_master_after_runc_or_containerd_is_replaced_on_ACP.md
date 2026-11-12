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

# etcd and kube-apiserver do not start on a master after runc or containerd is replaced on ACP

## Issue

After a kernel upgrade, or after Docker (`docker-ce`) was installed on a master, the static Pods `etcd-<node-name>` and `kube-apiserver-<node-name>` in `kube-system` stay in `CrashLoopBackOff` or never start, and every Pod on that node fails to start. Typical signs:

- kubelet repeats `Failed to delete cgroup paths`.
- `crictl ps -a | grep etcd` shows etcd `Exited` with `"reason": "StartError"` and `"exitCode": 128`, and `crictl logs` prints nothing because the container never started.
- containerd logs a `shim-run-v2` error, and etcd and kube-apiserver stay down even after `/usr/bin` was recopied from a healthy node.
- Copying `containerd` and `runc` into `/usr/bin` and restarting kubelet does not help while an older `runc` under `/usr/local/bin` is still the one found first on `PATH`.
- The command line stops working after Docker was installed, and after Docker is uninstalled the scheduler still does not start.
- calico-node restarts with a port conflict, and two calico containers cannot be deleted.

Related articles: "Control-plane Pods do not start with mkdir /var/log/pods: file exists after containerd directories are lost on ACP" covers a master where kubelet and containerd run but no container exists. "Container runtime conflicts on ACP nodes: Docker, podman, docker-runc, and overwritten runtime binaries" covers the same overwrite on worker nodes.

## Root Cause

### Cause 1: /usr/local/bin/runc is an old build after a kernel upgrade

After a kernel upgrade (for example on Kylin), etcd and kube-apiserver on the upgraded master enter `CrashLoopBackOff` and kubelet cannot create the sandbox. `which -a runc` lists `/usr/local/bin/runc` before `/usr/bin/runc`. The first binary is `runc 1.0.0-rc3`, a build shipped with the OS image, which does not match the new kernel's IPC namespace handling, so sandbox creation fails. The working binary is the platform's `runc` under `/usr/bin` (for example `1.1.12`). Recopying `/usr/bin` and restarting kubelet and containerd does not help until `/usr/local/bin/runc` is moved aside and the runtime is restarted.

### Cause 2: Installing docker-ce replaced runc and containerd

`yum install docker-ce` replaced the `runc` and `containerd` binaries. After a reboot no Pod starts, and kubelet repeats `Failed to delete cgroup paths` from `pod_container_manager_linux.go:210`. On a containerd cluster the overwrite can show up only after a reboot: `crictl inspect` of the etcd container shows `"state": "CONTAINER_EXITED"`, `"exitCode": 128`, `"reason": "StartError"`, and:

```text
failed to create containerd task: failed to create shim task: OCI runtime create failed: container_linux.go:311: creating new parent process caused "container_linux.go:1572: running lstat on namespace path \"/proc/<pid>/ns/ipc\" caused \"lstat /proc/<pid>/ns/ipc: no such file or directory\"": unknown
```

`systemctl status docker` shows `docker.service` `active (running)` on the master. If several masters are affected (for example one failed and a second was rebooted), etcd loses quorum. Restoring an etcd backup does not help; restoring the overwritten binaries from a healthy node brings etcd back and the nodes to `Ready`.

Restoring the binaries without removing Docker is enough for etcd and kube-apiserver, which use the host network, but a running `dockerd` on a platform node is not supported: it rewrites `docker0`, iptables, NAT, and `FORWARD` rules, which breaks Pod-network traffic on the node (for example Pods that cannot reach the `kubernetes` Service on `443`) while host-network static Pods keep working.

### Cause 3: /usr/local/bin still has Docker runtime binaries

Docker installed on the containerd node left `runc`, `containerd`, or `containerd-shim*` copies in `/usr/local/bin`, which are found first on `PATH`. containerd logs a `shim-run-v2` error, and etcd and kube-apiserver stay down after `/usr/bin` was recopied. After `systemctl stop kubelet` and `systemctl stop containerd`, many `/usr/bin/containerd-shim-runc-v2 -namespace k8s.io -id ...` processes can remain. Moving the leftovers aside, copying the containerd binaries again, and restarting containerd and kubelet is the recovery; a reboot may also be needed.

### Cause 4: After Docker is uninstalled the scheduler stays down until a reboot

The cluster is abnormal, `kubectl` cannot run, and Docker is installed on a node. After the Docker package is uninstalled the scheduler still cannot start; rebooting that node brings the scheduler and the cluster back. A reboot alone is enough only when the Docker packages did not own the platform runtime files.

## Resolution

Before any step: if the API server still answers, cordon and drain the node (`kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`). When etcd or kube-apiserver on this master is down and `kubectl` does not answer, skip the drain and work from a console session. Static Pods are not evicted by a drain either way.

### Cause 1: /usr/local/bin/runc is an old build after a kernel upgrade

Apply only when etcd and kube-apiserver are in `CrashLoopBackOff` after a kernel upgrade, `/usr/local/bin/runc --version` prints `1.0.0-rc3` (or another build older than the healthy node's), and `/usr/bin/runc` matches the healthy node:

```bash
which -a runc
/usr/local/bin/runc --version
/usr/bin/runc --version
```

> **Warning:** Moving `/usr/local/bin/runc` changes which runc creates the next sandbox. New containers wait until containerd is restarted. Rollback: `sudo mv /usr/local/bin/runc.old /usr/local/bin/runc` and restart containerd again. Keep the old file.

```bash
sudo mv /usr/local/bin/runc /usr/local/bin/runc.old
hash -r
command -v runc
runc --version
sudo systemctl restart containerd
sudo systemctl restart kubelet
```

`runc --version` must now match `/usr/bin/runc`. etcd and kube-apiserver should leave `CrashLoopBackOff` without a manifest edit and without deleting `/var/lib/etcd`.

### Cause 2: Installing docker-ce replaced runc and containerd

Compare the node with a healthy master of the same cluster:

```bash
which -a runc containerd
runc --version
containerd --version
ls -l "$(command -v runc)" "$(command -v containerd)"
rpm -q docker-ce || true
rpm -qf "$(command -v runc)" "$(command -v containerd)"
```

If `rpm -qf` shows that a Docker package (for example `docker-ce` or `containerd.io`) owns `runc` or `containerd` and you also intend to remove Docker, remove it before the copy: removing the package deletes the files it owns, including freshly restored ones.

Copy `runc` and `containerd` from the healthy node to `/var/tmp/runc.from-healthy` and `/var/tmp/containerd.from-healthy` on this node. If the healthy node's `ls -l` shows other differences, also copy `ctd-decoder`, `containerd-shim-runc-v2`, `ctr`, `containerd-shim`, `crictl`, `containerd-shim-runc-v1`, `critest`, `containerd-stress`, `kubelet`, and `kubectl` into `/usr/bin`.

> **Warning:** Replacing `runc` and `containerd` and restarting containerd stops new container creation on this node until the units are back. Running containers survive the stop only when the containerd unit has `KillMode=process` (check `systemctl show containerd -p KillMode`); with `control-group` or `mixed`, stopping containerd stops every container on the node, including static Pods that are still up. Apply only when the cgroup-path log or the `StartError` is confirmed and the healthy-node binaries differ. Stop kubelet and containerd before the copy; overwriting a running `containerd` fails with `Text file busy`. Match owner and mode to the healthy node. Rollback: stop kubelet and containerd, copy `/var/tmp/runc.before-restore` and `/var/tmp/containerd.before-restore` back, and start containerd and kubelet. This does not touch etcd data.

```bash
RUNC="$(command -v runc)"; CONTAINERD="$(command -v containerd)"
sudo cp -a "$RUNC" /var/tmp/runc.before-restore
sudo cp -a "$CONTAINERD" /var/tmp/containerd.before-restore
sudo systemctl stop kubelet containerd
sudo cp -a /var/tmp/runc.from-healthy "$RUNC"
sudo cp -a /var/tmp/containerd.from-healthy "$CONTAINERD"
sudo systemctl start containerd
sudo systemctl start kubelet
```

If `which` on the healthy node and on this node disagree, restore onto the healthy node's path and move any extra copy under `/usr/local/bin` aside (Cause 3). Pods, including the static Pods, should start once kubelet can create cgroups again. If Pods on this node then cannot reach the `kubernetes` Service, stop and remove Docker, or take the node out of the cluster if Docker must stay.

### Cause 3: /usr/local/bin still has Docker runtime binaries

Apply only when the runtime is containerd, Docker was installed on the node, containerd logs `shim-run-v2`, and `/usr/local/bin` holds `runc`, `containerd`, or `containerd-shim` files that a healthy node does not have:

```bash
rpm -qa | grep docker || true
ls -l /usr/local/bin | grep -E 'runc|containerd|shim' || true
which -a runc containerd
ps -ef | grep '[c]ontainerd-shim-runc-v2' | wc -l
```

> **Warning:** Moving the `/usr/local/bin` binaries changes which shim the next container uses. Move them only when they are confirmed Docker leftovers and `/usr/bin` already matches a healthy node. New containers wait until containerd and kubelet are restarted. Rollback: `sudo mv /var/tmp/usr-local-bin-docker/<name> /usr/local/bin/<name>` for each moved file.

```bash
sudo mkdir -p /var/tmp/usr-local-bin-docker
for f in runc containerd containerd-shim containerd-shim-runc-v1 containerd-shim-runc-v2; do
  if [ -e "/usr/local/bin/$f" ]; then sudo mv "/usr/local/bin/$f" /var/tmp/usr-local-bin-docker/; fi
done
hash -r
sudo systemctl restart containerd
sudo systemctl restart kubelet
```

Copy the healthy `/usr/bin` set again if `which` still disagrees with the healthy node. Leave `/usr/local/bin` without a `runc` unless a unit, script, or containerd setting calls that path by full name; in that case copy `/usr/bin/runc` there instead. etcd and kube-apiserver should start without deleting the WAL.

If calico-node then restarts with a port conflict and `crictl ps -a | grep calico` shows two containers that cannot be deleted, stop kubelet, reboot the host, delete the stale calico container, and start kubelet.

> **Warning:** Stopping kubelet and rebooting stops Pods on this node until the host is back and kubelet is started. Only when the duplicate calico containers remain after the binary restore and calico-node is in a port conflict. Rollback of the kubelet stop before the reboot: `sudo systemctl start kubelet`.

```bash
sudo systemctl stop kubelet
sudo shutdown -r now
# after the host is back
sudo crictl ps -a | grep calico
sudo crictl rm <stale-calico-id>
sudo systemctl start kubelet
```

### Cause 4: After Docker is uninstalled the scheduler stays down until a reboot

List the Docker packages and check whether they own the platform runtime files:

```bash
rpm -qa | grep docker || true
rpm -qf /usr/bin/containerd /usr/bin/runc
```

If a Docker package (for example `containerd.io` or `docker-ce`) owns them, removing it deletes those files; restore them from a healthy node (Cause 2) before the reboot.

> **Warning:** Removing Docker and rebooting stops containers on this node until the host is back. Only when Docker was installed on a containerd node and the cluster command line is already dead. Reinstalling Docker is not a rollback, because Docker caused the fault. If etcd is still down after the reboot and `/usr/local/bin` holds runtime binaries, use Cause 3.

Remove the listed Docker packages with the package manager, then reboot:

```bash
sudo shutdown -r now
```

After the reboot, `kubectl get pods -n kube-system -l component=kube-scheduler` should show the scheduler Running.

## Diagnostic Steps

```bash
which -a runc containerd
runc --version
containerd --version
sudo journalctl -u kubelet --since "1 hour ago" | grep -F "Failed to delete cgroup paths" || true
systemctl is-active docker 2>/dev/null || true
sudo crictl ps -a | grep etcd
sudo crictl inspect <etcd-container-id> | grep -E '"reason"|"exitCode"|"message"'
kubectl -n kube-system get pods -l 'component in (etcd,kube-apiserver)' -o wide
```

- `/usr/local/bin/runc` is `1.0.0-rc3` (or older than the healthy node's) after a kernel upgrade, static Pods in `CrashLoopBackOff`: Cause 1.
- `Failed to delete cgroup paths`, or etcd `StartError` / `lstat /proc/<pid>/ns/ipc: no such file or directory` with `docker.service` running on a containerd node: Cause 2. `rpm -q docker-ce` returning a package supports it.
- `shim-run-v2` and Docker leftovers in `/usr/local/bin`: Cause 3.
- Docker installed, command line dead, scheduler down after the uninstall: Cause 4.
- `walpb: crc mismatch` with binaries that match a healthy node: a corrupt etcd member, not a binary restore.

A node that never had Docker installed and whose `which -a runc` lists only `/usr/bin/runc` at the healthy version is not covered here.

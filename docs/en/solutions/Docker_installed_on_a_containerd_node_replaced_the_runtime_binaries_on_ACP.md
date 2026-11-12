---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.x
  - 4.x
---

# Docker installed on a containerd node replaced the runtime binaries on ACP

## Issue

Docker was installed (for example with `yum install`) on a node whose platform runtime is containerd, and the node became abnormal:

- A Pod sandbox cannot be created, and a job stays `0/1 ContainerCreating` on one node with:

```text
Warning  FailedCreatePodSandbox  kubelet  Failed to create pod sandbox: rpc error: code = Unimplemented desc = failed to create containerd task: failed to start shim: start failed: unsupported shim version (3): not implemented
```

- containerd fails to recognize the shim, and the node now has several `runc` and `containerd` versions.
- `runc -v` on one node reports a different version from its healthy neighbors, and `systemctl status docker` shows `dockerd` running on a containerd node.
- The node cannot be drained.

The first check is whether a `docker` package is installed on a node whose `CONTAINER-RUNTIME` is `containerd://`. If it is, remove the package before anything else.

## Root Cause

### Cause 1: The Docker packages overwrote or duplicated the platform runtime binaries

Installing Docker pulls in its own `containerd`, `runc`, and shims. They can overwrite or duplicate the binaries the platform installed in `/usr/bin`, and then containers fail, containerd is abnormal or fails to recognize the shim, or Pods fail with the shim version mismatch above. Typical evidence:

- `runc -v` reports `runc version 1.3.4` and `containerd -v` reports `containerd containerd.io v2.2.2` (`containerd.io` is the name of Docker's containerd package), while `systemctl status docker` shows `docker.service` `active (running)` with `/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock`. That flag makes `dockerd` connect as a client to the containerd listening on the platform socket instead of starting its own.
- On Kylin V10, Docker installed from the OS repository (`docker-engine 1:18.09.0-261.p06.04.ky10`, `docker-proxy`, `docker-runc 1.0.0.rc3-223.p01.ky10`) brings its own `containerd` 1.2.0 and `docker-runc`, and `runc -v` reports `runc version 1.0.0-rc3`.

Removing the Docker packages, and restoring the binaries from a healthy node if the versions still differ, recovers the node. In some cases restoring the binaries alone does not clear the shim mismatch, and the node has to be kept cordoned and rebooted.

**Files and directories involved** when Docker is installed on a containerd node:

- the runtime binaries in `/usr/bin` (`containerd`, `containerd-shim`, `containerd-shim-runc-v1`, `containerd-shim-runc-v2`, `ctr`, `ctd-decoder`, `crictl`, `critest`, `containerd-stress`, `runc`, and in some installs `kubelet` and `kubectl`), only when the Docker packages ship their own copies;
- the `docker.service` and `docker.socket` units, and a `dockerd` process that uses `/run/containerd/containerd.sock`;
- the containerd unit file and `/etc/containerd/config.toml`, which must still be present after the Docker packages are removed;
- `/var/lib/docker` (or the `data-root` in `/etc/docker/daemon.json`), Docker's data directory, which stays on the node after `yum remove`.

### Cause 2: Docker was installed, but containerd kept working

The node became abnormal after `yum install` of Docker, but containerd kept running normally and its binaries were not replaced. Stopping Docker, uninstalling it with `yum`, and deleting `/var/lib/docker` by hand (`yum` does not remove it) brings the node back. No binary restore is needed.

## Resolution

### Cause 1: The Docker packages overwrote or duplicated the platform runtime binaries

Remove the Docker package first (step 1), then check `runc -v`. Restore binaries (step 2) only if the versions still differ from a healthy node.

**Step 1: remove the Docker package.** Before removing anything, check which package owns the runtime files the node uses, save the containerd configuration and unit, and list what Docker holds:

```bash
rpm -qf $(which -a runc containerd)
rpm -qf /etc/containerd/config.toml
systemctl show -p FragmentPath containerd
mkdir -p /var/tmp/before-docker-removal
cp -a /etc/containerd/config.toml "$(systemctl show -p FragmentPath containerd | cut -d= -f2)" /var/tmp/before-docker-removal/
docker ps -a
grep -s data-root /etc/docker/daemon.json || true
```

If `docker-ce`, `containerd.io`, `runc`, or another package that the removal would take owns the `runc`, `containerd`, unit, or configuration the node uses, those files go with it; restore them with step 2 afterwards. Containers listed by `docker ps -a` were started by whoever installed Docker, not by the platform (platform Pods run under containerd); agree with their owner before removing them.

> **Warning:** Uninstalling Docker stops every container that runs under `dockerd`. Precondition: `kubectl get node <node-name> -o wide` shows `containerd://` in `CONTAINER-RUNTIME`, and a `docker` package is installed. Review the dependency list the package manager prints before confirming, and stop if it includes packages the platform installed. Package removal is reversible only by reinstalling the packages.

```bash
systemctl stop docker docker.socket 2>/dev/null
systemctl disable docker docker.socket 2>/dev/null
yum list installed | grep docker
runc -v
yum remove docker
runc -v          # must now match a healthy node of the cluster
```

On Kylin V10, `yum remove docker` also removes its dependencies (`containerd-1.2.0-213.p04.ky10`, `docker-proxy`, `docker-runc`), after which `runc -v` reports the platform's `runc version 1.1.14` and the node recovers. Package names differ between systems; on Debian or Ubuntu, list them with `dpkg -l | grep -iE 'docker|containerd'` and remove with `apt-get remove`.

Make sure the removal did not delete the containerd unit file or `/etc/containerd/config.toml`. If either is missing, copy it back from `/var/tmp/before-docker-removal/` or from a healthy node, run `systemctl daemon-reload`, and restart containerd. Then check that containerd is running and the binaries exist; if not, continue with step 2:

```bash
systemctl is-active containerd
ls -l /usr/bin/containerd /usr/bin/runc
```

Delete the Docker data directory as in Cause 2.

**Step 2: restore the binaries, only if `runc -v` or `containerd -v` still differs from a healthy node.** This step stops the runtime, so move workloads off first.

> **Warning:** `kubectl drain --delete-emptydir-data` evicts every non-DaemonSet Pod from the node and permanently deletes their `emptyDir` data. Precondition: step 1 is finished and the versions still differ from a healthy node of the same cluster. Rollback: `kubectl uncordon <node-name>` once the node is healthy; deleted `emptyDir` data does not return.

```bash
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
```

If the node cannot be drained, at least cordon it so new Pods (such as a failing job) are scheduled to other nodes.

> **Warning:** Stopping kubelet and containerd to overwrite the runtime binaries does not stop containers already running under `containerd-shim` with the default `KillMode=process` (check `systemctl show containerd -p KillMode`), but no container can be created, started, or stopped, and no image pulled, on the node until both are started again. Precondition: the node is drained, and a healthy node of the same cluster, OS, and architecture is the source. Keep a copy of the replaced files to roll back.

```bash
systemctl stop kubelet
systemctl stop containerd
BINS="containerd containerd-shim containerd-shim-runc-v1 containerd-shim-runc-v2 ctr ctd-decoder crictl critest containerd-stress runc kubelet kubectl"
mkdir -p /root/runtime-bin-backup
for b in $BINS; do [ -e /usr/bin/$b ] && cp -a /usr/bin/$b /root/runtime-bin-backup/; done
for b in $BINS; do scp <healthy-node>:/usr/bin/$b /usr/bin/$b; done
systemctl daemon-reload
systemctl start containerd
systemctl start kubelet
runc -v; containerd -v; systemctl is-active docker
```

The versions must match the healthy node. If the shim mismatch persists after the binaries are restored, keep the node cordoned and reboot it, then uncordon it when it is `Ready`.

**Rolling containerd back by hand.** There is no supported manual containerd downgrade procedure. For a few nodes, the recommended path is to remove the node from the cluster and add it again. The binary replacement above is only a manual rollback: stop `kubelet` and `containerd`, disable them at boot, reboot, then back up and overwrite the listed `/usr/bin` binaries with copies that match the other nodes. On GPU nodes, check first whether the node cleanup used for remove-and-re-add also removes the GPU drivers.

### Cause 2: Docker was installed, but containerd kept working

Stop and uninstall Docker as in Cause 1, step 1. Then delete the Docker data directory, which `yum` leaves behind.

> **Warning:** Deleting `/var/lib/docker` permanently removes every image, container, volume, and build cache that the removed Docker created. Precondition: the node's `CONTAINER-RUNTIME` is `containerd://`, Docker has been stopped and uninstalled, and nobody needs the images or volumes Docker created (copy them out first if they do). On a cluster whose runtime is Docker, `/var/lib/docker` holds the platform's own runtime data; never delete it there. If `daemon.json` set another `data-root`, that path is Docker's data directory instead. If `findmnt` shows a separate mount there, find out what that disk is used for first. Confirm the containerd root is a different path. Irreversible.

```bash
systemctl is-active docker || true
findmnt -R /var/lib/docker
containerd config dump | grep -E '^root'
du -sh /var/lib/docker
rm -rf /var/lib/docker
```

Confirm the node afterwards; the checksums must still match a healthy node of the same cluster:

```bash
systemctl is-active containerd kubelet
sha256sum $(which -a runc containerd)
crictl ps | head -n 5
kubectl get node <node-name>
```

## Diagnostic Steps

1. Identify the runtime, then look for Docker packages and a running `dockerd` on a containerd node:

```bash
kubectl get node <node-name> -o wide          # CONTAINER-RUNTIME column
rpm -qa 2>/dev/null | grep -iE 'docker|containerd|runc|podman'; dpkg -l 2>/dev/null | grep -iE 'docker|containerd|runc'
systemctl status docker --no-pager 2>/dev/null | grep -E 'Active|dockerd'
```

2. Compare versions and binaries with a healthy node of the same cluster. `which -a` also shows copies elsewhere in `PATH` (for example `/usr/local/bin`) that are found before `/usr/bin`:

```bash
which -a runc containerd
containerd --version; runc --version
ls -l /usr/bin/containerd* /usr/bin/runc /usr/local/bin/containerd* /usr/local/bin/runc 2>/dev/null
sha256sum /usr/bin/containerd /usr/bin/containerd-shim-runc-v2 /usr/bin/runc
# run the same sha256sum on the healthy node and compare
```

Different versions or checksums are Cause 1. Matching binaries with containerd running are Cause 2.

3. Check whether containerd is healthy and whether Docker left data behind:

```bash
systemctl is-active containerd; crictl ps | head -n 5
ls -ld /var/lib/docker && du -sh /var/lib/docker
ls -l /etc/containerd/config.toml; systemctl cat containerd | head
```

4. Look for the sandbox error that names the shim version:

```bash
kubectl get events -A --field-selector reason=FailedCreatePodSandbox | grep -i 'shim version'
```

On a control-plane node, the same overwrite can make etcd or kube-apiserver crash-loop; that recovery is not covered here.

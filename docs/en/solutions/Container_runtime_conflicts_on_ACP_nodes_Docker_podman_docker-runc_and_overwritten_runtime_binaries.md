---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
---

# Container runtime conflicts on ACP nodes: Docker, podman, docker-runc, and overwritten runtime binaries

## Issue

A node that is being added, or that is already in the cluster, has a container runtime that no longer matches what the platform installed. Typical reports:

- Docker was installed on a node (by hand or by mistake) and the node became abnormal; containerd disappeared from the node.
- After a reboot the node never becomes Ready, or Pods fail with `FailedCreatePodSandBox`.
- calico does not start after a kernel and NIC driver upgrade.
- The CRI version changed by itself after a reboot.
- A deployment or node add fails because of conflicting packages or reports a `runc` error.
- On a cluster created by TKE, a new node stays at `EnsureNodeReady` with cgroup errors in the network plugin events.

The platform installs its own containerd (or Docker with `cri-docker` on Docker clusters), `runc`, `crictl`, `kubelet`, and `kubectl` in `/usr/bin` and expects exactly those versions. Installing Docker or podman from the OS repositories, an OS upgrade, or packages preinstalled in the machine image replace or remove them. The files involved on a containerd node are `containerd`, `containerd-shim`, `containerd-shim-runc-v1`, `containerd-shim-runc-v2`, `ctr`, `ctd-decoder`, `crictl`, `critest`, `containerd-stress`, `runc`, `kubelet`, and `kubectl` in `/usr/bin`, plus `/etc/containerd/config.toml` and the containerd unit file. Same-named copies in `/usr/local/bin` are found first on `PATH`.

## Root Cause

### Cause 1: Docker was installed on a containerd node

A `docker-ce` installation on a node whose cluster uses containerd has different effects; compare the node with a healthy one before choosing a step:

- Docker is installed and the node is abnormal, but containerd still runs and its binaries are identical to a healthy node.
- `yum install docker-ce` uninstalled containerd (for example on an ACP 4.0 node).
- After a reboot the node does not return to Ready: kubelet and the runtime services fail to start because `runc` and other binaries in `/usr/bin` are now the wrong versions.
- The OVN components on the node do not run (`ovs-ovn` produces no log), and Pods fail with `FailedCreatePodSandbox`.
- On a node whose overlay and underlay traffic share one NIC, deleting containers during the cleanup invalidated the `pr-bridge` bridge: the node lost its network and SSH and went `NotReady` until it was rebooted. Such a node can be recovered by removing it from the cluster, cleaning it up, and adding it again.

### Cause 2: An OS, kernel, or driver upgrade overwrote runc and containerd, and podman was installed

On an ACP 4.0 ARM node, calico does not start after the kernel and NIC driver are upgraded. The `runc` and `containerd` binaries in `/usr/bin` differ from those on a healthy node, and `podman` is installed. The OS packages involved on a Kylin node include `containers-common`, `containernetworking-plugins`, `docker-runc`, `podman`, and `container-selinux`.

### Cause 3: dockerd changed version after a reboot on a Docker-runtime cluster

The business cluster was not upgraded, but after a node reboot the CRI is a different version and `cri-docker` is broken: `dockerd` on the node no longer matches the version healthy nodes run (for example `20.10.27-2`). Other signs:

- Workers are `NotReady`, with node events alternating between `NodeReady` and `NodeNotReady`; no Calico Pod is failing.
- `kubectl get pod -A | grep upgra` lists `<pool-worker>-<node>-upgrade-cri` Pods in `kube-system` at `0/1`, `ContainerCreating` or `Pending`.
- The node's machine resource in `cpaas-system` on `global` has `cri.type: docker` and the Docker version in its spec, but `cri.version: Unknown` and `containerRuntimeVersion: docker://Unknown` in its status.

### Cause 4: Docker, docker-runc, or other conflicting packages were preinstalled before ACP installed Kubernetes

- A 4.2.2 deployment on Kylin Linux Advanced Server V10 fails until conflicting packages are removed from the node, for example `docker-runc`, `podman`, and `containernetworking-plugins`; a separate `/usr/local/bin/runc` reports `runc version 1.0.0-rc3`.
- A node add or cluster creation (for example on 4.3.1) reports a `runc` error because a `docker-runc` package from the machine image is installed. The check line is `/usr/bin服务: 服务项检查失败: /usr/local/bin/runc 不在/usr/bin下` ("service check failed: /usr/local/bin/runc is not under /usr/bin"); `rpm -qa | grep docker` returns `docker-runc-<version>` while `systemctl -a | grep docker` shows only `var-lib-docker.mount`.
- ACP cannot reuse a Docker already installed on the host. ACP deploys the runtime itself, and a Docker installed beforehand is not compatible with the platform deployment.

### Cause 5: A TKE-created cluster provisions new nodes with containerd while the cluster runs Docker

Adding a node to a TKE workload cluster stays at `EnsureNodeReady`. The node is `NotReady`, calico and kube-proxy do not start, and their events report a cgroup incompatibility. `global` and the workload cluster use Docker, but the new node gets containerd, because the cluster object on `global` carries the annotation `cpaas.io/container-runtime-version: containerd://1.6.28-4,docker://20.10.24-2`. Removing only `containerd://1.6.28-4` from that annotation does not help.

The new node shows `Container Runtime Version: containerd://1.6.28-4` and the event `InvalidDiskCapacity` (`invalid capacity 0 on image filesystem`), while every other node runs `docker://...`. `calico-node` stays `Init:0/5`, `kube-proxy` `ContainerCreating`, with repeated `FailedCreatePodSandbox`:

```text
Failed to create pod sandbox: rpc error: code = Unknown desc = failed to create containerd task: failed to create shim task: OCI runtime create failed: runc create failed: expected cgroupsPath to be of format "slice:prefix:name" for systemd cgroups, got "/kubepods/burstable/pod.../..." instead: unknown
```

## Resolution

### Cause 1: Docker was installed on a containerd node

Compare the node with a healthy node of the same OS, architecture, and platform version:

```bash
kubectl get node <node-name> -o wide          # CONTAINER-RUNTIME must be containerd://
rpm -qa | grep -i -E 'docker|containerd|runc|podman'
systemctl list-unit-files | grep -i -E 'docker|containerd'
systemctl is-active containerd docker
md5sum /usr/bin/runc /usr/bin/containerd /usr/bin/kubelet
rpm -qf /usr/bin/containerd /usr/bin/runc
```

**containerd still running and the checksums match a healthy node.** Stop and disable Docker, remove the Docker package with the OS package manager, and check that the removal did not delete the containerd unit file or `/etc/containerd/config.toml`. `runc -v` must then match a healthy node.

> **Warning:** Removing Docker stops every container that runs under `dockerd`. Review the dependency list the package manager prints before confirming, and stop if it includes packages the platform installed. Reinstalling the package is the only rollback.

```bash
sudo systemctl stop docker docker.socket
sudo systemctl disable docker docker.socket
sudo yum remove docker-ce docker-ce-cli
runc -v
ls -l /etc/containerd/config.toml; systemctl cat containerd | head
```

**Runtime binaries differ from a healthy node, or containerd is gone.** Restore them as follows.

> **Warning:** Overwriting the runtime binaries replaces the container runtime of the node. Stop kubelet and containerd first, because a busy file cannot be overwritten. With the default `KillMode=process`, running containers keep running under `containerd-shim`, but no container can be created, started, or stopped and no image pulled until both are started again. Apply only when the checksums differ from a healthy node of the same version and architecture; an amd64 binary does not run on an ARM node. Keep the replaced files in `/root/runtime-bin-backup` for rollback.

```bash
# on the affected node
sudo yum remove -y docker-ce docker-ce-cli
sudo systemctl stop kubelet
sudo systemctl stop containerd
sudo mkdir -p /root/runtime-bin-backup
for i in ctd-decoder containerd-shim-runc-v2 ctr containerd-shim crictl containerd-shim-runc-v1 critest containerd-stress runc containerd kubelet kubectl; do
  [ -e /usr/bin/$i ] && sudo cp -a /usr/bin/$i /root/runtime-bin-backup/
done
```

```bash
# on the healthy node
for i in ctd-decoder containerd-shim-runc-v2 ctr containerd-shim crictl containerd-shim-runc-v1 critest containerd-stress runc containerd kubelet kubectl
do
  scp -P <ssh-port> /usr/bin/$i root@<affected-node>:/usr/bin
done
```

If `scp` fails because containerd still holds the files, disable containerd on the affected node, reboot it, and copy again.

> **Warning:** With containerd disabled the node runs no Pods after the reboot, and the reboot drops every session on it. Do this only on the node being repaired, only when the copy fails on busy files, and from a console that does not depend on the node's network. Rollback: `sudo systemctl enable --now containerd`.

```bash
sudo systemctl disable containerd
sudo reboot
# after the copy from the healthy node succeeded
sudo systemctl enable --now containerd
```

```bash
sudo systemctl start containerd kubelet
systemctl is-active containerd kubelet
kubectl get node <node-name>
```

Optionally, the restore sequence can also remove the node's containers before the copy, between stopping kubelet and stopping containerd (`crictl` needs containerd running):

> **Warning:** Deleting every container on the node stops all its Pods, including the CNI agents. On a node whose overlay and underlay share one NIC, it invalidates `pr-bridge`, the node loses its network and SSH, and only a reboot brings it back. Run it only from a console that does not depend on the node's network, and only when overlay and underlay do not share a NIC on that node; otherwise skip it. It cannot be undone; the Pods are recreated after kubelet starts again.

```bash
sudo systemctl stop kubelet
sudo crictl ps -a -q | xargs -r sudo crictl rm -f
sudo systemctl stop containerd
```

If the node has lost its network (the shared-NIC `pr-bridge` case), reboot it from a console first. If the node cannot be repaired in place, remove it from the cluster, run the node cleanup script, and add it again.

### Cause 2: An OS, kernel, or driver upgrade overwrote runc and containerd, and podman was installed

Uninstall `podman`, then restore the binaries exactly as in Cause 1:

```bash
rpm -qa | grep -i podman
sudo yum remove -y podman
md5sum /usr/bin/runc /usr/bin/containerd
```

After the binaries are back, check that calico starts: `kubectl get pods -A -o wide | grep <node-name>`.

### Cause 3: dockerd changed version after a reboot on a Docker-runtime cluster

```bash
dockerd --version; docker version --format '{{.Server.Version}}'
# on the workload cluster
kubectl get pod -A | grep upgrade-cri
# on global: the machine resource of the node
kubectl get machine -n cpaas-system | grep <node-name>
kubectl get machine -n cpaas-system <machine-name> -o yaml | grep -n -E 'cri|containerRuntimeVersion'
```

`docker://Unknown` in the machine status while the spec names the Docker version matches this cause. Copy `docker` and `dockerd` from a healthy node and restart Docker.

> **Warning:** Restarting Docker restarts every container on the node. Apply only when the version differs from the healthy nodes. Keep the replaced binaries; rollback is copying them back and restarting Docker.

```bash
sudo systemctl stop kubelet docker
sudo mkdir -p /root/runtime-bin-backup
sudo cp -a /usr/bin/docker /usr/bin/dockerd /root/runtime-bin-backup/
# on the healthy node
scp /usr/bin/docker /usr/bin/dockerd root@<affected-node>:/usr/bin/
# on the affected node
sudo systemctl start docker kubelet
systemctl status cri-docker --no-pager
```

`cri-docker` recovers after Docker restarts.

### Cause 4: Docker, docker-runc, or other conflicting packages were preinstalled before ACP installed Kubernetes

Check the host before the add or the deployment, and remove what the platform did not install:

```bash
rpm -qa | grep -i docker
systemctl -a | grep -i docker
for x in docker docker-client docker-common docker-engine docker-proxy docker-runc podman-docker podman containernetworking-plugins apptainer containerd kubernetes kubernetes-master kubernetes-node kubernetes-client kubernetes-kubeadm; do
  rpm -qa | grep -F "$x"
done | sort -u
ls -l /usr/local/bin/runc 2>/dev/null && /usr/local/bin/runc -v
```

> **Warning:** Removing packages from the host cannot be undone by the platform. Do it only on a machine that is not yet in a cluster, and only for runtime packages (`docker-runc`, a preinstalled `docker-ce`, `podman`, `containernetworking-plugins`). Make sure no other service on the host depends on them.

```bash
sudo yum remove -y docker-runc podman containernetworking-plugins
```

For a preinstalled Docker, uninstall it, remove its leftovers, and let the platform deploy the runtime during the Kubernetes installation. After `docker-runc` is removed the `runc` error disappears; run the node add or the deployment again.

### Cause 5: A TKE-created cluster provisions new nodes with containerd while the cluster runs Docker

On `global`, read the runtime annotations of the cluster and compare with the runtime of its existing nodes:

```bash
kubectl get node -o wide   # on the workload cluster: CONTAINER-RUNTIME of the existing nodes
kubectl get cls <cluster-name> -o yaml | grep -n -E 'runtime|container-runtime'
```

> **Warning:** The runtime annotations decide which runtime every later node of that cluster gets. Change them only when the existing nodes run Docker and new nodes come up with containerd. Save the object first; rollback is restoring the saved annotations.

Set both runtime annotations to the Docker runtime that the existing nodes run (the `CONTAINER-RUNTIME` value above), then remove the new node, run `cleanup.sh` on it, and add it again:

```bash
kubectl get cls <cluster-name> -o yaml > /tmp/cls-backup.yaml
kubectl annotate cls <cluster-name> --overwrite \
  cpaas.io/container-runtime-version='docker://<docker-version>' \
  cpaas.io/container-runtime='docker://<docker-version>'
```

## Diagnostic Steps

On the affected node and on a healthy node of the same OS and version:

```bash
rpm -qa | grep -i -E 'docker|containerd|runc|podman' || dpkg -l | grep -i -E 'docker|containerd|runc|podman'
for b in runc containerd ctr crictl kubelet kubectl; do printf '%s ' "$b"; md5sum /usr/bin/$b | cut -d' ' -f1; done
which -a runc containerd
systemctl is-enabled containerd kubelet docker 2>/dev/null
journalctl -u containerd -u kubelet -n 50 --no-pager
```

- A Docker package on a containerd node: Cause 1. Whether containerd is still active and the checksums match decides which branch.
- `podman` installed and binaries changed after a kernel or driver upgrade: Cause 2.
- A Docker-runtime cluster whose node reports `docker://Unknown` after a reboot: Cause 3.
- A host that is not yet in a cluster with `docker-runc`, `podman`, or `containernetworking-plugins` installed, or a `runc` error on add: Cause 4.
- A new node on a Docker cluster that comes up with `containerd://` and the `cgroupsPath` error: Cause 5.

A node that is `NotReady` after a reboot only because the runtime and kubelet were not enabled at boot is simpler: start and enable them.

```bash
sudo systemctl enable --now docker kubelet
```

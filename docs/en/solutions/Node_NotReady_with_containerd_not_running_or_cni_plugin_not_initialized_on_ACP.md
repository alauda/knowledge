---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.x
  - 4.x
---

# Node NotReady with containerd not running or "cni plugin not initialized" on ACP

## Issue

Typical reports:

- After the cluster was restarted, some nodes stay `NotReady` and cannot be connected.
- In a newly deployed environment, some masters of a workload cluster are `NotReady`; `kubectl describe node` says the CNI is broken, but the OVN containers are Running:

  ```text
  Ready  False  KubeletNotReady  container runtime network not ready: NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized
  ```

- During an upgrade a node becomes `NotReady` and platform Pods on it (for example `zeus` in `cpaas-system`) fail to start, while `calico-node` is running and logs no errors. The kubelet log repeats:

  ```text
  "Container runtime network not ready" networkReady="NetworkReady=false reason:NetworkPluginNotReady message:docker: network plugin is not ready: cni config uninitialized"
  ```

- After a GPU node was rebooted, many Pods on it cannot start, and the containerd log shows the `loopback` CNI plugin crashing.

The kubelet is running and reports to the API server, but it reports the node as not ready because the container runtime is missing or has not loaded the CNI configuration. Memory, disk, and PID pressure conditions are normal, and the other nodes of the cluster are `Ready`.

If the runtime runs but hangs (`PLEG is not healthy`, `container runtime is down`), see [Node NotReady on ACP with kubelet "PLEG is not healthy"](Node_NotReady_with_PLEG_is_not_healthy.md). If the kubelet cannot reach the API server at all, see [Node NotReady caused by network, storage or host-level faults on ACP](Node_NotReady_caused_by_network_storage_or_host_level_faults_on_ACP.md). CoreDNS problems right after a node restart are covered in [CoreDNS fails after a node restart or lookups time out when a CoreDNS node is shut down on ACP](CoreDNS_fails_after_a_node_restart_or_lookups_time_out_when_a_CoreDNS_node_is_shut_down_on_ACP.md).

## Root Cause

### Cause 1: containerd did not start after a node or cluster restart

After a cluster or host restart, `systemctl status containerd` on the `NotReady` nodes shows the service `inactive (dead)` or `failed`, and `crictl ps` cannot connect to the runtime socket. Without containerd the kubelet cannot run any Pod, so the node cannot become `Ready`. Why containerd did not start is not known; starting it by hand recovers the node.

### Cause 2: `cni plugin not initialized` while the kube-ovn CNI Pod is Running

The node condition shows `NetworkPluginNotReady ... cni plugin not initialized`. At the same time `NetworkUnavailable` is `False` with reason `JoinSubnetGatewayReachable`; the `kube-ovn-cni-<suffix>` Pod in `kube-system` on that node has its `cni-server` container `Running` with 0 restarts and its init containers `install-cni` and `hostpath-init` completed; and containerd is running. This happened on two of three control-plane nodes of a newly deployed 4.2 workload cluster (Kubernetes `v1.33.6`). containerd had not picked up the CNI configuration that kube-ovn installs, although both looked healthy. Restarting containerd makes the nodes `Ready`; the underlying cause is not confirmed.

### Cause 3: A corrupted plugin binary in `/opt/cni/bin` (`portmap`, `loopback`)

A Pod network is set up by running every plugin in the CNI chain, so one damaged binary breaks it even when the main network plugin is healthy. Two forms:

- `network plugin is not ready: cni config uninitialized` on a Docker-runtime node with Calico during an upgrade. All Calico Pods are Running, the `calico-node` log on the node has no errors, and the Calico configuration file and binaries are present. Restarting `calico-node` and the kubelet does not help. The kubelet also logs `"Error syncing pod, skipping"` for `cpaas-system/zeus-*` Pods and `KillPodSandbox` failures with `networkPlugin cni failed to teardown pod ... network: cni config uninitialized`. `ls -l /opt/cni/bin/` shows `portmap` at 1572864 bytes on the affected node and about 3.6 MB on a healthy node, while the other binaries match.
- Pods cannot start after a reboot of a (GPU) node, and the kubelet and containerd logs show the `loopback` plugin binary crashing during Pod network setup. The `md5sum` of `/opt/cni/bin/loopback` differs from every healthy node.

How the binaries were damaged is not known: around an upgrade for `portmap`, around a reboot for `loopback`.

## Resolution

### Cause 1: containerd did not start after a node or cluster restart

```bash
systemctl start containerd
systemctl status containerd --no-pager | head -n 5
systemctl is-enabled containerd
kubectl get node <node-name>
```

The node should return to `Ready`. If `systemctl is-enabled containerd` does not print `enabled`, compare it with a healthy node of the same cluster and enable it the same way (`systemctl enable containerd`); otherwise the node stays `NotReady` again after the next reboot. If containerd fails to start, read `journalctl -u containerd -b --no-pager | tail -n 50` for the reason.

### Cause 2: `cni plugin not initialized` while the kube-ovn CNI Pod is Running

Restart containerd on each affected node, one node at a time.

> **Warning:** Restarting containerd briefly interrupts container operations on the node: for a few seconds no Pods are created, stopped, or probed. Running containers keep running in their shims. Do it only when the node condition shows `cni plugin not initialized` and the `kube-ovn-cni` Pod on that node is Running (step 2 of Diagnostic Steps). No rollback is needed.

```bash
systemctl restart containerd
systemctl status containerd --no-pager | head -n 5
kubectl get node <node-name>
kubectl describe node <node-name> | grep -E 'Ready|NetworkPluginNotReady'
```

If the condition stays, check that the CNI configuration and binaries exist on the node (step 3 of Diagnostic Steps) and compare them with a `Ready` node.

### Cause 3: A corrupted plugin binary in `/opt/cni/bin` (`portmap`, `loopback`)

Replace the damaged binary with the copy from a healthy node of the same cluster. The node returns to `Ready` (`portmap`), or the Pods start normally (`loopback`).

> **Warning:** A binary from a node with a different architecture or CNI version breaks Pod networking on this node. Do it only when the binary's size or checksum differs from healthy nodes (step 4 of Diagnostic Steps), and take the copy from a healthy node of the same cluster, OS, and architecture. Keep the old file to roll back.

```bash
cp -a /opt/cni/bin/portmap /root/portmap.corrupt.$(date +%s)
scp <healthy-node>:/opt/cni/bin/portmap /opt/cni/bin/portmap
chmod 755 /opt/cni/bin/portmap
md5sum /opt/cni/bin/portmap      # must match the healthy node
kubectl get node <node-name>
```

Use the same steps for `loopback` or any other binary that differs. Compare all binaries at once, because more than one can be damaged.

## Diagnostic Steps

1. Read the node condition and the runtime state:

   ```bash
   kubectl get nodes -o wide
   kubectl describe node <node-name> | sed -n '/Conditions:/,/Addresses:/p'
   systemctl status containerd kubelet --no-pager | grep -E '●|Active'
   journalctl -u kubelet --since "-30min" --no-pager | grep -iE 'NetworkPluginNotReady|cni|runtime' | tail -n 20
   ```

   `containerd` not active: Cause 1. `cni plugin not initialized` with containerd active: Cause 2. `cni config uninitialized` with a healthy Calico, or a plugin binary crashing: Cause 3.

2. Check the kube-ovn CNI Pod on the node:

   ```bash
   kubectl -n kube-system get pods -o wide --field-selector spec.nodeName=<node-name> | grep kube-ovn-cni
   crictl ps -a | grep -E 'cni-server|install-cni|hostpath-init'
   ```

   Expected for Cause 2: `cni-server` Running, `install-cni` and `hostpath-init` Exited (completed).

3. Check the CNI configuration and plugin binaries containerd loads, and what it reports about loading them:

   ```bash
   ls -l /etc/cni/net.d/ /opt/cni/bin/
   crictl info | grep -iE -A3 'lastCNILoadStatus|NetworkReady'
   journalctl -u containerd --since "-30min" --no-pager | grep -i cni | tail -n 20
   ```

   Compare the file lists with a `Ready` node of the same cluster.

4. Compare every CNI plugin binary with a healthy node (Cause 3). A size or checksum that differs is the damaged one:

   ```bash
   md5sum /opt/cni/bin/* > /tmp/cni-$(hostname).md5
   ssh <healthy-node> 'md5sum /opt/cni/bin/*' > /tmp/cni-healthy.md5
   diff /tmp/cni-healthy.md5 /tmp/cni-$(hostname).md5
   grep -o '"type": *"[a-z0-9-]*"' /etc/cni/net.d/*.conflist      # plugins in the chain
   journalctl -u kubelet --since "-30min" --no-pager | grep -E 'cni config uninitialized|loopback|portmap' | tail -n 10
   ```

   No `diff` output means the binaries match the healthy node.

5. Runtime binaries that were replaced or conflict (Docker on a containerd node, overwritten `runc`) are covered in [Container runtime conflicts on ACP nodes: Docker, podman, docker-runc, and overwritten runtime binaries](Container_runtime_conflicts_on_ACP_nodes_Docker_podman_docker-runc_and_overwritten_runtime_binaries.md).

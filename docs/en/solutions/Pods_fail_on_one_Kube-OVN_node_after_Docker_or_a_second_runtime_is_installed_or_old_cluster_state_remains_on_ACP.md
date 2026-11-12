---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12.x
  - 3.18.x
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# Pods fail on one Kube-OVN node after Docker or a second runtime is installed or old cluster state remains on ACP

Related articles: [kube-ovn-cni fails on one node after a NIC rename, clock skew or hostname change on ACP](kube-ovn-cni_fails_on_one_node_after_a_NIC_rename_clock_skew_or_hostname_change_on_ACP.md).

## Issue

Pods on one node of a Kube-OVN cluster cannot be created or cannot reach the API server, although the CNI looks healthy elsewhere. Typical reports:

- Pods on one node fail with `request ip return 500 configure nic failed no packets received from gateway` after someone installed Docker or a second containerd on the host.
- A platform component such as `zeus` panics because it times out connecting to the API server. From that node's Pods, `curl` to the `kubernetes` Service on `443` times out, while the API server node on `6443` answers:

  ```text
  curl: (28) Failed to connect to <kubernetes-service-ip> port 443 after 130856 ms: Couldn't connect to server
  curl: (28) Failed to connect to <kubernetes-service-ip> port 443 after 5002 ms: Timeout was reached
  ```

- On a newly added node, `kube-ovn-pinger` is in `CrashLoopBackOff` (`Exit Code: 1`, hundreds of restarts), other platform Pods crash-loop, and the kubelet log repeats `"Unable to authenticate the request due to an error" err="[invalid bearer token, invalid signature, no keys found]"`. It looks as if the Kube-OVN components cannot connect to the API server.
- The node reaches a destination under the host policy, but Pods on it cannot.

## Root Cause

### Cause 1: Docker or a second containerd replaced or disturbed the platform runtime

The event text looks like a Kube-OVN gateway failure (`no packets received from gateway`), but the runtime is what broke:

- Docker installed by hand overwrites containerd-related binaries. Pod sandboxes cannot be created until those binaries are restored. On a single-node ACP 4.0.2 cluster, an extra containerd installed on the node broke the runtime the same way; recreating `ovn0` and clearing the OVN database did not help, and replacing the runtime files did.
- When Docker is started next to the platform's containerd and left running, it rewrites `docker0`, iptables NAT and `FORWARD` rules, and Pod forwarding on that node breaks. Pods then reach the API server node on `6443` but not the `kubernetes` Service on `443`, and components such as `zeus` panic because they cannot create their metrics handler.

A platform node cannot keep a second runtime that rewrites its iptables.

### Cause 2: the node kept state from a deleted cluster, or already had a runtime or another vendor's CNI

- The machine was previously a node of a cluster that was removed, and the node cleanup was never run, so container services and iptables rules are still present. The node reaches destinations under the host policy, but Pods cannot.
- A newly added node already had containerd installed and another vendor's network plugin deployed. On it, `kube-ovn-pinger` (`pinger` container) is `CrashLoopBackOff` with `Exit Code: 1`, `zeus` and other platform Pods crash-loop, and the kubelet log repeats `invalid bearer token, invalid signature, no keys found`. The containerd log has `an error occurred when try to find sandbox: not found` and image pulls fail with `dial tcp <registry>:80: i/o timeout`. Such a node does not meet the platform's node software and directory requirements, which ask for conflicting packages to be removed and leftover runtime and kubelet directories to be deleted before the node is added. The exact failure mechanism on such a node was not determined.

## Resolution

### Cause 1: Docker or a second containerd replaced or disturbed the platform runtime

1. Confirm the signature from the `kube-ovn-pinger` Pod on that node, and check whether Docker is running:

   ```bash
   kubectl -n kube-system exec <kube-ovn-pinger-pod-on-this-node> -- curl -vk --connect-timeout 5 --max-time 10 https://<kubernetes-service-ip>:443/healthz
   kubectl -n kube-system exec <kube-ovn-pinger-pod-on-this-node> -- curl -k -m 5 https://<apiserver-node-ip>:6443/healthz
   systemctl is-active docker containerd
   ip link show docker0
   iptables -t nat -S | grep -i docker | head
   rpm -qf /usr/bin/containerd /usr/bin/runc
   ```

2. Restore the platform runtime. Keep this order: stop kubelet, containerd and Docker; uninstall the Docker packages; copy the platform binaries; start containerd and kubelet. Removing a Docker package deletes the files it owns, which can include `/usr/bin/containerd` and `/usr/bin/runc`, so uninstalling after the copy deletes the restored binaries again. A running `containerd` cannot be overwritten in place (`Text file busy`).

   The binaries to copy back from a healthy node of the same ACP version and architecture are `containerd`, `containerd-shim`, `containerd-shim-runc-v1`, `containerd-shim-runc-v2`, `containerd-stress`, `ctr`, `crictl`, `critest`, `runc`, `ctd-decoder`, `kubelet` and `kubectl`.

   > **Warning:** Stopping Docker and replacing `containerd` and `kubelet` stops every container that runs under `dockerd`, stops all container creation and probes on the node, and can leave it `NotReady`. Drain the node first if the API answers. Containers under the platform containerd keep running under `containerd-shim` only when the containerd unit has `KillMode=process` (check `systemctl show containerd -p KillMode`); with `control-group` or `mixed`, stopping containerd stops every Pod on the node. Work from a console, copy the current binaries aside first, and only copy from a node on the same ACP build and architecture. To roll back, restore the saved binaries and start the previous runtime.

   ```bash
   mkdir -p /root/runtime-before && cp -a /usr/bin/containerd* /usr/bin/ctr /usr/bin/runc /usr/bin/kubelet /root/runtime-before/ 2>/dev/null
   systemctl stop kubelet containerd
   systemctl disable --now docker docker.socket || true
   # uninstall the Docker packages reported by rpm -qf / rpm -qa | grep docker
   # copy the binaries listed above from the healthy node to the same paths
   which -a runc containerd
   systemctl start containerd
   systemctl start kubelet
   ```

3. If `which -a runc containerd` still lists a copy under `/usr/local/bin` after the restore, Pods keep failing until that leftover is moved aside.
4. When Docker must stay on the machine for other applications, take the node out of the cluster instead: cut its access to the API server and delete the Node object.

### Cause 2: the node kept state from a deleted cluster, or already had a runtime or another vendor's CNI

- **Node from a deleted cluster.** Run the platform's node cleanup script for a removed node: when a node is deleted from the cluster in the web UI, the dialog offers **Download Cleanup Script**; run it on the node after the deletion. Then add the node again if it should be part of the cluster, and retest from a Pod.

  > **Warning:** The cleanup removes CNI state and rules from the node and is not fully reversible. Do not run it on a node that is still a healthy member of the cluster. A broad `iptables -F` or `ip link delete` on OVS bridges is not a substitute: it blackholes the node. Save the rules first.

  ```bash
  iptables-save > /root/iptables.before-node-cleanup
  crictl ps
  systemctl list-units --type=service --all | grep -Ei 'docker|kubelet|containerd'
  ```

- **New node with a pre-installed runtime or another vendor's CNI.** Remove the node from the cluster, uninstall packages that conflict with the platform components, delete the directories listed in the node software and directory requirements, and add the node again.

  > **Warning:** The commands below destroy every container image, container, Pod log and kubelet client certificate on the host, and they are irreversible. Only on a node that has already been removed from the cluster (`kubectl get node <node-name>` returns `NotFound`), with its runtime stopped, and only when the `invalid bearer token` or pre-installed runtime signature is confirmed. Do not run them on a member node.

  ```bash
  kubectl get node <node-name>
  systemctl stop kubelet containerd docker 2>/dev/null || true
  rm -rf /var/lib/docker /var/lib/nerdctl /opt/nerdctl/ /var/lib/containerd /var/log/pods /var/lib/kubelet/pki
  ```

## Diagnostic Steps

```bash
kubectl -n kube-system get pod -o wide | grep -E 'kube-ovn-cni|ovs-ovn|kube-ovn-pinger' | grep <node-name>
kubectl -n kube-system describe pod <failing-pod> | grep -A3 FailedCreatePodSandBox
crictl version
systemctl is-active containerd kubelet docker || true
journalctl -u kubelet --since '-30m' | grep -E 'invalid bearer token|Unable to authenticate' | tail -5
journalctl -u containerd --since '-30m' | grep -E 'find sandbox|i/o timeout' | tail -5
```

- `docker` active on a containerd node, or runtime binaries that changed after a Docker install, is Cause 1. On that node, a Pod reaching the API server node on `6443` but not the `kubernetes` Service on `443` points to the same cause.
- `invalid bearer token` in the kubelet log of a new node that already had containerd or another vendor's CNI, or a node that came from a deleted cluster, is Cause 2.
- If `kube-ovn-cni` itself fails with `failed to parse config` or `failed to initialize config` for an old NIC name, see the related article.

---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2,4.3'
id: KB260400013
---

# Upgrade a Kube-OVN Cluster from IPv4 to Dual Stack (IPv4/IPv6)

## Issue

This document describes how to upgrade a Kubernetes cluster that uses Kube-OVN as the CNI plugin from IPv4-only mode to dual-stack IPv4/IPv6 mode.

## Environment

- Alauda Container Platform cluster using Kube-OVN as the CNI plugin.
- IPv6 is supported on the cluster node operating system and is not disabled in the kernel.
- The cluster node NICs are configured with real IPv6 addresses, and IPv6 routing is reachable between nodes.

## Prerequisites

| Item | Requirement |
|------|------|
| ACP version | 4.2, 4.3 |
| CNI plugin | Kube-OVN |
| Node kernel | IPv6 is enabled (`net.ipv6.conf.all.disable_ipv6 = 0`) and forwarding is enabled (`net.ipv6.conf.all.forwarding = 1`) |
| Node NIC | A real IPv6 address is configured (GUA, for example `2004::/64`) and a default route is configured |

## Resolution

:::warning
During the upgrade, all pods that use container networking must be restarted to obtain dual-stack IP addresses again. Plan a maintenance window in advance and notify the relevant application teams.
At the same time, the parameter changes to components such as `kube-ovn-controller` and `kube-ovn-cni` in this document create `resourcePatch` entries. These `resourcePatch` entries may be removed during a cluster upgrade, which can cause the dual-stack arguments configured here to be lost. Pay special attention to this during upgrades, and re-check and re-apply the relevant arguments after the upgrade if needed.
:::

### Step 1: Update the kube-apiserver configuration on all master nodes

`kube-apiserver` runs as a static pod. The configuration file path is:

```
/etc/kubernetes/manifests/kube-apiserver.yaml
```

Update `--service-cluster-ip-range` to dual-stack format:

```yaml
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### Step 2: Update the kube-controller-manager configuration on all master nodes

The configuration file path is:

```
/etc/kubernetes/manifests/kube-controller-manager.yaml
```

Update the following two parameters to dual-stack format:

```yaml
- --cluster-cidr=10.3.0.0/16,fd00:10:3::/112
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### Step 3: Update the kubelet `--node-ip` parameter on all nodes

In bare-metal dual-stack environments, kubelet must be explicitly configured with dual-stack node addresses. Otherwise, `Node.status.addresses` usually reports only the IPv4 `InternalIP`, which can affect Kube-OVN routing behavior that depends on node addresses.

A common configuration file path is:

```bash
/var/lib/kubelet/kubeadm-flags.env
```

Change the single-stack configuration:

```bash
--node-ip=<IPv4>
```

To dual-stack:

```bash
--node-ip=<IPv4>,<IPv6>
```

Example:

```bash
--node-ip=192.168.134.191,2001:db8::191
```

:::warning
`<IPv6>` must use the IPv6 address already configured on the node NIC as described in the prerequisites. Do not use an address from the Kube-OVN `join` network.
:::

After the change, restart kubelet:

```bash
systemctl daemon-reload
systemctl restart kubelet
```

:::warning
For self-managed clusters, upgrading kubelet usually does not overwrite the existing `--node-ip` configuration in `/var/lib/kubelet/kubeadm-flags.env`.

For MicroOS clusters, this configuration is lost after a cluster upgrade, so do not treat this file change as a persistent configuration method. Do not rely on `/var/lib/kubelet/kubeadm-flags.env` remaining unchanged after upgrades. After the upgrade, re-check whether kubelet still uses `--node-ip=<IPv4>,<IPv6>` and whether `Node.status.addresses` is still dual-stack. If the configuration is missing, re-apply it and restart kubelet.
:::

### Step 4: Update the `kube-system/kube-ovn-controller` arguments

Edit the Deployment:

```bash
kubectl edit deploy kube-ovn-controller -n kube-system
```

Update the following arguments to dual-stack format:

```yaml
- --node-switch-cidr=100.64.0.0/16,fd00:100:64::/112
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
- --default-cidr=10.3.0.0/16,fd00:10:3::/112
```

### Step 5: Verify that the node annotations have been updated to dual stack

Run:

```bash
kubectl get node <node-name> -o yaml
```

Confirm that the following annotations are updated to dual-stack format:

```yaml
ovn.kubernetes.io/cidr: 100.64.0.0/16,fd00:100:64::/112
ovn.kubernetes.io/gateway: 100.64.0.1,fd00:100:64::1
```

### Step 6: Update the `kube-system/kube-ovn-cni` arguments

Edit the DaemonSet:

```bash
kubectl edit ds kube-ovn-cni -n kube-system
```

Update the following argument to dual-stack format:

```yaml
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### Step 7: Verify the node IPv6 route

Run the following command on the node:

```bash
ip -6 r
```

You should see an IPv6 route similar to:

```text
fd00:10:3::/112 dev ovn0 proto static src 2004::192:168:134:191 metric 1024 pref medium
fd00:100:64::/112 dev ovn0 proto kernel metric 256 pref medium
```

One route is for the Pod CIDR, and the other is for the Join CIDR.

### Step 8: Restart all pods that use container networking

Run the following script to delete all pods that use container networking and have `restartPolicy=Always`:

```bash
#!/usr/bin/env bash
for ns in $(kubectl get ns --no-headers -o custom-columns=NAME:.metadata.name); do
  for pod in $(kubectl get pod --no-headers -n "$ns" --field-selector spec.restartPolicy=Always -o custom-columns=NAME:.metadata.name,HOST:spec.hostNetwork | awk '{if ($2!="true") print $1}'); do
    kubectl delete pod "$pod" -n "$ns" --ignore-not-found --wait=false
  done
done
```

### Step 9: Verify that dual-stack IPs have been allocated

Run:

```bash
kubectl get ips
```

You should see both IPv4 and IPv6 addresses allocated to the pod, for example:

```text
kube-ovn-pinger-vq896.kube-system   10.3.0.16   fd00:10:3::10   9a:3f:b1:71:58:5f   192.168.141.125   ovn-default
```

To further verify IPv6 connectivity, you can use `kube-ovn-pinger` to run `ping6` to the IPv6 address of a pod that uses container networking in the same cluster, for example:

```bash
kubectl exec -it -n kube-system kube-ovn-pinger-6fbx6 -- ping6 fd00:10:3::17
```

Expected output is similar to:

```text
Defaulted container "pinger" out of: pinger, hostpath-init (init)
PING fd00:10:3::17 (fd00:10:3::17): 56 data bytes
64 bytes from fd00:10:3::17: icmp_seq=0 ttl=64 time=2.989 ms
```

## Additional Information

### CIDR planning reference

| Purpose | IPv4 | IPv6 |
|------|------|------|
| Pod CIDR | `10.3.0.0/16` | `fd00:10:3::/112` |
| Service CIDR | `10.4.0.0/16` | `fd00:10:4::/112` |
| Join CIDR | `100.64.0.0/16` | `fd00:100:64::/112` |

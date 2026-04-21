---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.5,4.3.1,4.4.0'
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
| ACP version | ≥ 4.2.5, or ≥ 4.3.1, or ≥ 4.4.0 |
| CNI plugin | Kube-OVN |
| Node kernel | IPv6 is enabled (`net.ipv6.conf.all.disable_ipv6 = 0`) and forwarding is enabled (`net.ipv6.conf.all.forwarding = 1`) |
| Node NIC | A real IPv6 address is configured (GUA, for example `2004::/64`) and a default route is configured |

## Resolution

:::warning
During the upgrade, all container network pods must be restarted to obtain dual-stack IP addresses again. Plan a maintenance window in advance and notify the relevant application teams.
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

For MicroOS clusters, this configuration is lost after a cluster upgrade. Do not treat this file change as a persistent configuration method.
:::

### Step 4: Update the Kube-OVN moduleInfo configuration

#### 4.1 Find the target cluster moduleInfo

Run the following command on the Global cluster node to find the Kube-OVN moduleInfo for the target cluster:

```bash
kubectl get moduleInfo -A | grep {cluster-name} | grep kube-ovn
```

Example output:

```
business-1-2bcc878187dd9f0bb1c2b144032eae99   business-1   kube-ovn   kube-ovn   Processing   v4.2.28   ...
```

#### 4.2 Edit moduleInfo and update the dual-stack parameters

```bash
kubectl edit moduleInfo {moduleInfo-name}
```

Update the following five parameters for dual-stack:

```yaml
spec:
  config:
    components:
      dual_stack:
        JOIN_CIDR: 100.64.0.0/16,fd00:100:64::/112
        POD_CIDR: 10.3.0.0/16,fd00:10:3::/112
        POD_GATEWAY: ""
        SVC_CIDR: 10.4.0.0/16,fd00:10:4::/112
      networking:
        NET_STACK: dual_stack
```

:::tip
Set `POD_GATEWAY` to an empty string in dual-stack mode. Kube-OVN allocates the gateway automatically.
:::

### Step 5: Wait for the Kube-OVN core components to restart

Wait until all Kube-OVN core components in the member cluster restart successfully:

- `kube-ovn-controller`
- `kube-ovn-cni`
- `ovn-central`
- `ovs-ovn`

### Step 6: Verify dual-stack functionality

After the components are in `Running` state, restart all container network pods so that they can obtain dual-stack IP addresses again, and then run the following commands:

```bash
# Check whether the node reports both IPv4 and IPv6 InternalIP addresses
kubectl get node <node-name> -o yaml

# Check whether the pod has dual-stack IPs assigned
kubectl get pod <pod-name> -o jsonpath='{.status.podIPs}'
```

Expected output example:

```json
[{"ip":"10.3.x.x"},{"ip":"fd00:10:3::x"}]
```

## Additional Information

### CIDR planning reference

| Purpose | IPv4 | IPv6 |
|------|------|------|
| Pod CIDR | `10.3.0.0/16` | `fd00:10:3::/112` |
| Service CIDR | `10.4.0.0/16` | `fd00:10:4::/112` |
| Join CIDR | `100.64.0.0/16` | `fd00:100:64::/112` |

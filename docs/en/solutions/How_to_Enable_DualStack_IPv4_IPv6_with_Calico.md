---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.5,4.3.1,4.4.0'
---

# Upgrade a Calico Cluster from IPv4 to Dual Stack (IPv4/IPv6)

## Issue

This document describes how to upgrade a Kubernetes cluster that uses Calico as the CNI plugin from IPv4-only mode to dual-stack IPv4/IPv6 mode.

## Environment

- Alauda Container Platform cluster using Calico as the CNI plugin.
- Special requirement for Calico dual-stack: unlike Kube-OVN, Calico requires real IPv6 addresses on the node NICs and IPv6 routing to be reachable between nodes before dual-stack networking can work correctly.

## Prerequisites

| Item | Requirement |
|------|------|
| ACP version | ≥ 4.2.5, or ≥ 4.3.1, or ≥ 4.4.0 |
| CNI plugin | Calico |
| Node kernel | IPv6 is enabled (`net.ipv6.conf.all.disable_ipv6 = 0`) and forwarding is enabled (`net.ipv6.conf.all.forwarding = 1`) |
| Node NIC | A real IPv6 address is configured (GUA, for example `2004::/64`) |
| Inter-node network | IPv6 routing is reachable between nodes and nodes can ping each other over IPv6 |

## Resolution

:::warning
During the upgrade, all pods that use container networking must be restarted to obtain dual-stack IP addresses again. Plan a maintenance window in advance and notify the relevant application teams.
:::

### Step 1: Update the kube-apiserver configuration on all master nodes

`kube-apiserver` runs as a static pod. The configuration file path is:

```text
/etc/kubernetes/manifests/kube-apiserver.yaml
```

Update `--service-cluster-ip-range` to dual-stack format:

```yaml
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### Step 2: Update the kube-controller-manager configuration on all master nodes

The configuration file path is:

```text
/etc/kubernetes/manifests/kube-controller-manager.yaml
```

Update the following two parameters to dual-stack format:

```yaml
- --cluster-cidr=10.3.0.0/16,fd00:10:3::/112
- --service-cluster-ip-range=10.4.0.0/16,fd00:10:4::/112
```

### Step 3: Update the Calico moduleInfo configuration

#### 3.1 Find the target cluster moduleInfo

Run the following command on the Global cluster node to find the Calico moduleInfo for the target cluster:

```bash
kubectl get moduleInfo -A | grep {cluster-name} | grep calico
```

Example output:

```text
calico-ccc75e628c532d4f3ecd341c27ee1ae4       region1      calico                 calico                 Running      v4.2.17   v4.2.17   v4.2.17
```

In this output, the first `NAME` column is the value to use for `{moduleInfo-name}`.

#### 3.2 Edit moduleInfo and update the dual-stack parameters

```bash
kubectl edit moduleInfo {moduleInfo-name} -n {namespace}
```

Update the following parameters for dual-stack:

```yaml
spec:
  config:
    components:
      networking:
        NET_STACK: dual
      dual_stack:
        v4PodCIDR: 10.3.0.0/16
        v6PodCIDR: fd00:10:3::/112
```

### Step 4: Wait for the Calico core components to restart

Wait until all Calico core components restart successfully:

- `calico-node`
- `calico-kube-controllers`

### Step 5: Verify dual-stack functionality

After the components are in `Running` state, restart all pods that use container networking so that they can obtain dual-stack IP addresses again, and then run the following command:

```bash
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

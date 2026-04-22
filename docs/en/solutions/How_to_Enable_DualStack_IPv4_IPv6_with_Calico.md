---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2,4.3'
id: KB260400012
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
| ACP version | 4.2, 4.3 |
| CNI plugin | Calico |
| Node kernel | IPv6 is enabled (`net.ipv6.conf.all.disable_ipv6 = 0`) and forwarding is enabled (`net.ipv6.conf.all.forwarding = 1`) |
| Node NIC | A real IPv6 address is configured (GUA, for example `2004::/64`) |
| Inter-node network | IPv6 routing is reachable between nodes and nodes can ping each other over IPv6 |

## Resolution

:::warning
During the upgrade, all pods that use container networking must be restarted to obtain dual-stack IP addresses again. Plan a maintenance window in advance and notify the relevant application teams.
At the same time, the parameter changes to components such as `calico-node` in this document create `resourcePatch` entries. These `resourcePatch` entries may be removed during a cluster upgrade, which can cause the dual-stack arguments configured here to be lost. Pay special attention to this during upgrades, and re-check and re-apply the relevant arguments after the upgrade if needed.
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

### Step 3: Update the `calico-config` ConfigMap

Run:

```bash
kubectl edit configmap calico-config -n kube-system
```

Set the `assign_ipv6` parameter to `true`.

### Step 4: Update the `calico-node` DaemonSet configuration

Run:

```bash
kubectl edit daemonset calico-node -n kube-system
```

Add the following environment variables under `env`:

```yaml
- name: IP6
  value: "autodetect"
- name: CALICO_IPV6POOL_CIDR
  value: "fd00:10:3::/112"
- name: IP6_AUTODETECTION_METHOD
  value: "first-found"
- name: FELIX_IPV6SUPPORT
  value: "true"
```

The value of `CALICO_IPV6POOL_CIDR` defines the CIDR range from which IPv6 addresses are allocated.

### Step 5: Confirm that Calico automatically creates the default IPv6 IPPool

After the above changes are applied, Calico automatically creates a default IPv6 IPPool using the CIDR range configured in `CALICO_IPV6POOL_CIDR`.

Run:

```bash
kubectl get ippool -A
```

Expected output is similar to:

```text
NAME                  AGE
default-ipv4-ippool   5d4h
default-ipv6-ippool   2m34s
```

Confirm that `default-ipv6-ippool` has been created.

### Step 6: Update the default subnet to a dual-stack subnet

After the cluster is upgraded to dual stack, the existing default subnet `default-ipv4-ippool` remains single stack and does not yet map to the dual-stack IPPool. This does not affect the new IPv6 IPPool itself, but it affects correct querying of the custom resources `Subnet` and `IPs`.

If you want to update the default subnet, run:

```bash
kubectl edit subnet default-ipv4-ippool
```

Update the subnet configuration to dual-stack format, for example:

```yaml
cidrBlock: 10.3.0.0/16,fd00:10:3::/112
protocol: Dual
```

### Step 7: Delete the pods that require CNI-assigned addresses

Run the following script to delete all pods that use container networking and have `restartPolicy=Always`:

```bash
#!/usr/bin/env bash
for ns in $(kubectl get ns --no-headers -o custom-columns=NAME:.metadata.name); do
  for pod in $(kubectl get pod --no-headers -n "$ns" --field-selector spec.restartPolicy=Always -o custom-columns=NAME:.metadata.name,HOST:spec.hostNetwork | awk '{if ($2!="true") print $1}'); do
    kubectl delete pod "$pod" -n "$ns" --ignore-not-found --wait=false
  done
done
```

After the pods restart, they will be assigned both IPv4 and IPv6 addresses.

Run `kubectl get ips -A` and confirm that the newly created IP entries contain both IPv4 and IPv6 addresses.

To further verify IPv6 connectivity, select two IPv6 addresses of pods that use container networking in the same cluster from the `kubectl get ips -A` output, and run `ping6` between them.

## Additional Information

### CIDR planning reference

| Purpose | IPv4 | IPv6 |
|------|------|------|
| Pod CIDR | `10.3.0.0/16` | `fd00:10:3::/112` |
| Service CIDR | `10.4.0.0/16` | `fd00:10:4::/112` |

---
kind:
  - Solution
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18
id: KB260600001
sourceSHA: pending
---

# How to Migrate CNI from Calico to Kube-OVN on ACP

## Scenario

The cluster currently uses Calico as the CNI plugin and needs to be migrated to Kube-OVN.

:::warning
This document only applies to business clusters. CNI migration on the Global cluster is not supported.
:::

:::warning
This document applies to ACP 3.18.
:::

## Prerequisites

Before you begin, make sure the following conditions are met:

1. **Cluster version**: ACP 3.18, with cluster lifecycle managed by `ait/tke`.
2. **Kube-OVN artifacts are available**: Chart and images have been pushed to the on-site registry and are pullable by target cluster nodes:
   - chart: `acp/chart-cpaas-kube-ovn` (use the actual version from on-site ProductBase/artifacts)
   - image: `acp/kube-ovn` (use the actual on-site version)
   - The registry secret used by sentry is valid
3. **Maintenance window scheduled**: CNI migration causes cluster network interruption. Existing Pods will not automatically migrate networking. Make sure the operation is performed within an acceptable maintenance window.

## Impact

| Item | Description |
|------|-------------|
| Network interruption | Cluster networking will be disrupted during migration. Existing Pods will lose connectivity. |
| Node reboots | Step 6 requires rebooting nodes one by one to clean up Calico residuals. |

:::danger
This operation is irreversible. Make sure you have fully assessed the risks and operate within a maintenance window.
:::

## Solution

### Step 1: Record Current Network Configuration

**Operate on the business cluster**

Before making any changes, record the network parameters from the current Subnet. These will be needed when configuring Kube-OVN in Step 4:

```bash
# Record gateway, excludeIps, cidrBlock from the default subnet
kubectl get subnet default-ipv4-ippool -o jsonpath='{.spec.gateway}{"\n"}'
kubectl get subnet default-ipv4-ippool -o jsonpath='{.spec.excludeIps}{"\n"}'
kubectl get subnet default-ipv4-ippool -o jsonpath='{.spec.cidrBlock}{"\n"}'
```

Save the output. You will need:
- `gateway` → `<GW>` in Step 4
- `excludeIps` → `<EXCLUDE_IPS>` in Step 4
- `cidrBlock` → for confirming the Pod CIDR range

### Step 2: Clean Up Raven and Subnet Resources

**Operate on the business cluster**

Remove Raven components and subnet/IPS resources to avoid conflicts with Kube-OVN:

```bash
# Delete Raven
kubectl -n kube-system delete svc raven
kubectl -n kube-system delete deploy raven
kubectl delete clusterrolebinding raven
kubectl delete clusterrole system:raven
kubectl -n kube-system delete sa raven

# Delete subnets (remove finalizers first)
for name in $(kubectl get subnet -o jsonpath='{.items[*].metadata.name}'); do
    kubectl patch subnet $name -p '{"metadata":{"finalizers":[]}}' --type=merge
    kubectl delete subnet $name
done

# Delete IPs
kubectl delete ips --all
```

### Step 3: Label Nodes

**Operate on the business cluster**

Label the control plane node with the OVN master label. Kube-OVN's central component will be scheduled to this node:

```bash
# Replace <control-plane-node> with the actual control plane node name
kubectl label node <control-plane-node> kube-ovn/role=master --overwrite
```

:::warning
This step is required. Without the `kube-ovn/role=master` label, the OVN central component will fail to schedule.
:::

### Step 4: Modify Cluster CR to Trigger CNI Migration

**Operate on the Global cluster**

Annotate the Cluster to declare the switch to Kube-OVN. Parameter details:

| Parameter | Description | Source |
|-----------|-------------|--------|
| `join-cidr` | Kube-OVN join subnet CIDR | Recommended: `100.64.0.0/16`. Ensure it does not conflict with existing networks. |
| `gateway` | Default Pod gateway | Subnet `spec.gateway` recorded in Step 1 |
| `exclude-ips` | Subnet excluded addresses | Subnet `spec.excludeIps` recorded in Step 1 |

```bash
# Replace <CLS> with the target cluster name, <GW> and <EXCLUDE_IPS> with actual values
kubectl annotate cls <CLS> \
  cpaas.io/network-type=kube-ovn \
  kube-ovn.cpaas.io/join-cidr=100.64.0.0/16 \
  kube-ovn.cpaas.io/transmit-type=overlay \
  kube-ovn.cpaas.io/gateway=<GW> \
  kube-ovn.cpaas.io/exclude-ips=<EXCLUDE_IPS> \
  --overwrite
```

After modifying the Cluster, annotate the ClusterModule with a timestamp to trigger the migration:

```bash
kubectl annotate clustermodule <CLS> \
  cni-switch.alauda.io/requested-at="$(date +%Y-%m-%dT%H:%M:%S%z)" \
  --overwrite
```

### Step 5: Verify Kube-OVN Components Are Ready

**Operate on the business cluster**

Check the Kube-OVN installation progress and confirm all Pods are running:

```bash
kubectl get pod -n kube-system | grep ovn
```

The following components should all be in `Running` state:

| Component | Description | Expected Replicas |
|-----------|-------------|-------------------|
| `kube-ovn-cni` | One per node | Number of nodes |
| `ovs-ovn` | One per node | Number of nodes |
| `ovn-central` | Control plane | ≥1 |
| `kube-ovn-controller` | Network controller | ≥1 |

:::warning
Do not proceed to the next step until all components are Running. If any Pod is abnormal, troubleshoot with `kubectl describe pod <pod-name> -n kube-system`.
:::

### Step 6: Uninstall Calico and Clean Up Nodes

**Operate on the business cluster**

After Kube-OVN is ready, clean up all Calico resources.

**6.1 Delete Calico CRDs and their instances**

```bash
kubectl get crd -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | while read crd; do
  if ! echo $crd | grep '.crd.projectcalico.org$' >/dev/null; then
    continue
  fi
  for name in $(kubectl get $crd -o jsonpath='{.items[*].metadata.name}'); do
    kubectl delete $crd $name
  done
  kubectl delete crd $crd
done
```

**6.2 Clean up Raven-related resourcePatches**

After deleting Raven components in Step 2, the associated resourcePatch resources will still remain and need to be cleaned up:

```bash
# View Raven-related resourcePatches
kubectl get resourcePatch | grep raven

# Delete all Raven-related resourcePatches
for name in $(kubectl get resourcePatch --no-headers | grep raven | awk '{print $1}'); do
  kubectl delete resourcePatch "$name"
done
```

**6.3 Clean up residual files and reboot nodes one by one**

:::warning
Nodes must be processed one at a time. Wait for the current node to recover after reboot and confirm its status before proceeding to the next. Operating on multiple nodes simultaneously may cause the cluster to become unavailable.
:::

Run on **each node**:

```bash
# Clean up CNI configuration residuals
rm -f /etc/cni/net.d/10-calico.conflist /etc/cni/net.d/calico-kubeconfig
rm -f /opt/cni/bin/calico /opt/cni/bin/calico-ipam

# Clean up Calico data directories
rm -rf /var/lib/calico /var/run/calico /var/log/calico

# Reboot the node (after reboot, cali* virtual NICs, tunl0 tunnel, iptables/ipset rules will be automatically removed)
reboot
```

After the node reboots, confirm it is in `Ready` state before proceeding to the next node:

```bash
kubectl get node <node-name>
```

### Step 7: Final Verification

**Operate on the business cluster**

```bash
kubectl get apprelease -n cpaas-system | grep cni-
```

Expected output:

```
cni-kube-ovn   Synced   Ready    chart synced   94m      95m
```

Only `cni-kube-ovn` should remain; there should be no `cni-calico`.

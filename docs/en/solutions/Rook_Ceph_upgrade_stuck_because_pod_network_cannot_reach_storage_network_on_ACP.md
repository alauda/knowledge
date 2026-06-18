---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.3.1
---

# Rook-Ceph upgrade leaves CephCluster Progressing because the pod network cannot reach the storage network

## Issue

During an Alauda Container Platform upgrade from 4.2.4 to 4.3.1, Alauda Build of Rook-Ceph is upgraded from Reef 18.2.7 to Squid 19.2.3. During the upgrade, the OSD rollout can stall and the `CephCluster` remains in `Progressing` for an extended period.

In the affected environment, Rook-Ceph components had been customized before the upgrade: `rook-ceph-operator`, CSI provisioner components, or related Rook-Ceph pods were changed to run with `hostNetwork` so they could bypass a pod-network-to-storage-network connectivity gap. After the upgrade, the manual changes in the OLM CSV and component ConfigMaps are overwritten by the new default configuration. The affected components restart on the regular pod network, can no longer reach the Ceph storage network, and block the Rook-Ceph upgrade.

## Environment

- Alauda Container Platform: 4.2.4 upgraded to 4.3.1
- Rook-Ceph: Reef 18.2.7 upgraded to Squid 19.2.3
- Namespace: `rook-ceph`
- Applicable scenario: the pod network cannot reach the Ceph storage network, and the environment previously relied on manual `hostNetwork` changes for Rook-Ceph component connectivity

## Root Cause

The upgrade does not create the network failure by itself. The underlying problem is that the cluster does not satisfy a required network condition: pods on the regular pod network cannot reach the Ceph storage network. Before the upgrade, the environment depended on manual customization that moved selected Rook-Ceph control-plane or CSI components onto the host network.

During an upgrade, OLM renders and manages operator-related Deployments from the new CSV. Manual parameters in component ConfigMaps can also be replaced by defaults or by a later reconcile. For this reason, direct edits to a CSV or ConfigMap are not durable upgrade configuration. When those edits are reverted, Rook-Ceph components return to the regular pod network, lose access to the Ceph network, and the OSD upgrade and `CephCluster` reconciliation stall.

## Diagnostic Steps

Check whether the `CephCluster` remains in an upgrading or `Progressing` state:

```bash
kubectl -n rook-ceph get cephcluster
kubectl -n rook-ceph describe cephcluster
```

Check whether the Rook-Ceph operator, tools, CSI provisioner, or related pods were recreated, and whether their Deployments are running on the regular pod network:

```bash
kubectl -n rook-ceph get pod -o wide
kubectl -n rook-ceph get deploy -o jsonpath='{range .items[*]}{.metadata.name}{" hostNetwork="}{.spec.template.spec.hostNetwork}{"\n"}{end}'
```

Inspect the CSV to confirm whether the `hostNetwork` settings for `rook-ceph-operator`, `rook-ceph-tools`, or CSI-related Deployments have been reverted:

```bash
kubectl get csv -A | grep rook-ceph
kubectl -n rook-ceph get csv <rook-ceph-csv-name> -o yaml
```

Check whether `rook-ceph-operator-config` still contains the pre-upgrade parameter that forced host networking:

```bash
kubectl -n rook-ceph get configmap rook-ceph-operator-config -o yaml
```

Verify connectivity from the regular pod network to the Ceph storage network. The following commands show the method only; replace `<storage-network-ip>` with a reachable Ceph MON, OSD, or other address on the storage network:

```bash
kubectl -n rook-ceph run network-check --rm -it --restart=Never \
  --image=busybox:1.36 -- sh

ping <storage-network-ip>
nc -vz <ceph-mon-ip> 3300
nc -vz <ceph-mon-ip> 6789
```

If a regular pod cannot reach the storage network while a host-network pod can, the primary risk behind the stalled upgrade is missing network connectivity rather than the Rook-Ceph version itself.

## Resolution

The long-term fix is to make the Ceph storage network reachable from the pod network. Rook-Ceph operator, CSI provisioner, tools, and other components that need Ceph access must be able to reach the storage network while running on the regular pod network.

Confirm the following items according to the site's network model:

- The Pod CIDR or CNI egress addresses can route to the Ceph public network and any required cluster network.
- Ceph MON ports `3300` and `6789`, and the required OSD port range, are allowed by network ACLs, firewalls, and security groups from the pod network or CNI SNAT addresses.
- If NetworkPolicy is used, egress from the relevant pods in the `rook-ceph` namespace to the Ceph storage network is allowed.
- If the CNI SNATs pod-to-external traffic, the storage network allows the translated source addresses.

After fixing the network path, recheck connectivity from a regular pod to the Ceph MON and OSD addresses, then verify that Rook-Ceph reconciliation resumes:

```bash
kubectl -n rook-ceph get cephcluster
kubectl -n rook-ceph get pod -o wide
kubectl -n rook-ceph logs deploy/rook-ceph-operator --tail=200
```

The upgrade blockage is resolved when `CephCluster` returns to `Ready`, the OSD pods complete their rolling upgrade, and newly created PVCs can bind and mount normally.

## Temporary Recovery

If production service must be restored before the network path is fixed, temporarily restore the pre-upgrade `hostNetwork` customization so the Rook-Ceph components can reach the storage network through the node network. This is only an emergency workaround. It is not a final fix, because manual CSV and ConfigMap edits can be overwritten again during a later upgrade or reconcile.

First identify the current Rook-Ceph CSV:

```bash
kubectl get csv -A | grep rook-ceph
```

Edit the Rook-Ceph CSV in the `rook-ceph` namespace. In the Deployment templates for `rook-ceph-operator`, `rook-ceph-tools`, or the CSI provisioner components that the site has confirmed require storage-network access, restore:

```yaml
hostNetwork: true
```

Then inspect or restore the temporary parameter in `rook-ceph-operator-config`:

```bash
kubectl -n rook-ceph edit configmap rook-ceph-operator-config
```

Example value:

```yaml
data:
  ROOK_ENFORCE_HOST_NETWORK: "true"
```

After the change, watch the affected pods restart and confirm that `CephCluster` continues progressing:

```bash
kubectl -n rook-ceph get pod -w
kubectl -n rook-ceph get cephcluster -w
```

After emergency recovery, schedule the network fix and remove the dependency on manual `hostNetwork` customization before the next upgrade.

## Pre-upgrade Prevention

Before upgrading Rook-Ceph, check whether the environment depends on manual customization:

```bash
kubectl -n rook-ceph get deploy -o yaml | grep -n "hostNetwork"
kubectl -n rook-ceph get configmap rook-ceph-operator-config -o yaml
kubectl -n rook-ceph get csv -o yaml | grep -n "hostNetwork"
```

If the components can reach the storage network only through `hostNetwork`, fix pod-network-to-storage-network connectivity before upgrading the platform or Rook-Ceph. Do not treat direct CSV or operator ConfigMap edits as durable upgrade configuration.

## Related Issue

- Jira: ACP-53205

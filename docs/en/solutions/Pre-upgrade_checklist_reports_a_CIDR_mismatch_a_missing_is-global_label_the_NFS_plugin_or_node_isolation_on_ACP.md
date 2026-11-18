---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.1"
  - "4.2"
---

# Pre-upgrade checklist reports a CIDR mismatch, a missing is-global label, the NFS plugin, or node isolation on ACP

## Issue

The pre-upgrade checklist prints one of the following lines before an ACP upgrade, and it is not clear whether the line is a real blocker or what to change:

- `集群的 cluster cidr不一致,cluster资源上的为:<pod-cidr>,kubeadm config上的为: cluster-cidr` (the cluster CIDR is inconsistent: the Cluster resource has `<pod-cidr>`, the kubeadm config has `cluster-cidr`). On the cluster, `kubectl get cm -n kube-system kubeadm-config -o yaml | grep -iE "cluster-cidr"` prints only the parameter name, not a CIDR.
- `ERROR: global集群不存在is-global的label` (the global cluster has no `is-global` label).
- `ERROR: 集群 <cluster> 已部署 NFS 插件，请确认 NFS 的协议版本，如果为 NFSv3 则需要手动添加 nolock 参数或者升级后将 NFS 插件的 readOnlyRootFilesystem 修改为 false` (the NFS plugin is deployed on cluster `<cluster>`; confirm the NFS protocol version; for NFSv3 add the `nolock` option, or after the upgrade set `readOnlyRootFilesystem` of the NFS plugin to `false`).
- `升级前，请确认 global 集群中的节点是否已 启用 global Cluster Platform Node Isolation 。如需解决方案，请联系技术支持。` (before upgrading, confirm whether the global cluster nodes have global Cluster Platform Node Isolation enabled; contact technical support for a solution).

## Root Cause

### Cause 1: CIDR mismatch line that shows the parameter name cluster-cidr instead of a value

The checklist compares the CIDRs on the platform's Cluster resource with the values in the `kube-system/kubeadm-config` ConfigMap. Newer kubeadm configurations (the `v1beta4` configuration API) store the controller-manager flags under `controllerManager.extraArgs` as a list of `name`/`value` pairs:

```yaml
controllerManager:
  extraArgs:
  - name: allocate-node-cidrs
    value: "false"
  - name: cluster-cidr
    value: <pod-cidr>
  - name: node-cidr-mask-size
    value: "24"
```

The CIDR is on the `value:` line after `- name: cluster-cidr`. Older configurations write `cluster-cidr: <cidr>` on one line. With the list layout, a one-line match for `cluster-cidr` returns only the name line, so the checklist prints `cluster-cidr` where a CIDR is expected. When the YAML is read in full and the value matches the Cluster resource, the line is a parsing artifact and nothing has to change.

The same comparison answers other CIDR lines of the checklist: compare the cluster overview page with `kubeadm-config` and, on Kube-OVN clusters, with the `join` subnet. When the CIDR shown on the cluster's CIDR page is the one in use, the CIDR item can be ignored.

### Cause 2: the global cluster has no is-global label

The cluster label check applies to upgrades to 3.8 or later. It requires the label `is-global=true` on both global cluster resources: `cluster global`, and the `cluster.v1alpha1.clusterregistry.k8s.io` object named `global` in `cpaas-system`. When either object lacks the label, the checklist stops with this error.

### Cause 3: the NFS plugin is deployed on the cluster

The checklist flags every cluster that has the NFS plugin deployed, because an NFSv3 export needs either the `nolock` mount option or `readOnlyRootFilesystem: false` on the NFS plugin after the upgrade. The line is printed once per cluster, for example for both `global` and a business cluster. The check does not test whether the plugin is actually in use on that cluster, so it also appears for a cluster where the plugin is installed but unused.

### Cause 4: Confirm whether global Cluster Platform Node Isolation is enabled

The item refers to the node isolation policy of the global cluster. It is a confirmation prompt: when the policy is not enabled, the item does not apply.

The same pre-upgrade step can also ask to upload the TopoLVM plugin before upgrading. That is the Alauda Build of TopoLVM entry for the matching node architecture in the App Marketplace (for a 4.2.1 target: channel `alpha`, version `v4.2.4`), which is offered for x86, ARM, and heterogeneous architectures.

## Resolution

### Cause 1: CIDR mismatch line that shows the parameter name cluster-cidr instead of a value

Compare the two sources for each cluster the checklist names, one cluster at a time.

1. In the console, open Cluster Management, select the cluster, and record the pod CIDR, the service CIDR, and on Kube-OVN clusters the join CIDR from the cluster overview page.
2. On a control-plane node of that cluster, read the values in use. `-A1` prints the `value:` line that follows each `name:` line; `podSubnet` and `serviceSubnet` are printed on their own lines:

   ```bash
   kubectl get cm -n kube-system kubeadm-config -o yaml | grep -iE -A1 "cluster-cidr|subnet"
   ```

   On a Kube-OVN cluster also read the join subnet:

   ```bash
   kubectl get subnet join -o jsonpath='{.spec.cidrBlock}{"\n"}'
   ```

3. If every value matches the overview page, the checklist line is a parsing artifact. Ignore it and keep the comparison with the upgrade plan.

If a value really differs from what the cluster is running, this cause does not apply. Send the comparison and the checklist output to Alauda technical support before the upgrade window.

### Cause 2: the global cluster has no is-global label

1. On a control-plane node of the global cluster, check the label on both objects:

   ```bash
   kubectl get cluster global --show-labels | grep is-global
   kubectl get cluster.v1alpha1.clusterregistry.k8s.io -n cpaas-system global --show-labels | grep is-global
   ```

2. If either command prints nothing, add the label to that object:

   ```bash
   kubectl label cluster global is-global=true
   kubectl label cluster.v1alpha1.clusterregistry.k8s.io -n cpaas-system global is-global=true
   ```

3. Run the checklist again.

Add the label only to the global cluster's objects. A label added by mistake to another cluster is removed with `kubectl label cluster <cluster-name> is-global-`.

### Cause 3: the NFS plugin is deployed on the cluster

1. On a node of each named cluster that mounts the export, read the NFS protocol version. `vers=` in the mount options is the version in use. Also list the StorageClasses, PVs, and NFS Pods:

   ```bash
   grep -E ' nfs4? ' /proc/mounts
   kubectl get sc -o custom-columns=NAME:.metadata.name,PROVISIONER:.provisioner,MOUNTOPTIONS:.mountOptions
   kubectl get pv -o custom-columns=NAME:.metadata.name,SC:.spec.storageClassName,CLAIM:.spec.claimRef.name
   kubectl get pods -A | grep -i nfs
   ```

   If `vers=4` or later is in use, the NFSv3 condition does not apply.

2. **The cluster does not use the NFS plugin.** Uninstall the NFS plugin from that cluster through the platform's cluster plugin management before the upgrade.

   > **Warning:** Only when no PV on that cluster uses the NFS StorageClass and no workload mounts the NFS export, as shown by the `kubectl get pv` and `kubectl get sc` output above. Impact: new PVCs on the NFS StorageClass can no longer be provisioned on that cluster. Save the PV list first. Rollback: install the NFS plugin again from cluster plugin management with the same export settings.

3. **The cluster uses the NFS plugin over NFSv3.** Add `nolock` to the mount options of the NFS StorageClass. Back the StorageClass up first:

   ```bash
   kubectl get sc <nfs-storageclass> -o yaml > <nfs-storageclass>.yaml
   ```

   > **Warning:** With `nolock`, NFS file locks are local to each client node, so two nodes writing to the same file are not protected from each other by NFS locking. Precondition: the export is confirmed to be NFSv3 and the backup file exists. Rollback: remove `nolock` again with `kubectl apply -f <nfs-storageclass>.yaml`. A StorageClass change applies to PVs provisioned after it; each existing PV keeps the options in its own `spec.mountOptions`.

   If the StorageClass already has a `mountOptions` list, append to it:

   ```bash
   kubectl patch sc <nfs-storageclass> --type=json -p '[{"op":"add","path":"/mountOptions/-","value":"nolock"}]'
   ```

   If it has no `mountOptions` field yet, create the list:

   ```bash
   kubectl patch sc <nfs-storageclass> --type=merge -p '{"mountOptions":["nolock"]}'
   ```

The checklist also offers setting `readOnlyRootFilesystem` to `false` on the NFS plugin after the upgrade as the alternative. This article covers the `nolock` path only.

### Cause 4: Confirm whether global Cluster Platform Node Isolation is enabled

1. Open the node isolation policy setting of the global cluster in the console.
2. If the policy is not enabled, ignore this checklist item.
3. If it is enabled, contact Alauda technical support for the solution before the upgrade, as the item instructs.

For the TopoLVM upload, read the node architecture and pick the TopoLVM package for it (for example `topolvm-operator.alpha.arm64.v4.2.4.tgz` when the nodes are ARM):

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture
```

## Diagnostic Steps

1. A CIDR line that shows a parameter name (`cluster-cidr`) or an empty value where a CIDR is expected: read `kubeadm-config` with `grep -A1` and compare with the overview page and, on Kube-OVN, the `join` subnet. Expected for Cause 1: the `value:` line carries the same CIDR as the overview page.
2. `global集群不存在is-global的label`: the two `--show-labels` commands of Cause 2. Expected for Cause 2: at least one of them prints nothing.
3. `已部署 NFS 插件`: read `vers=` from `/proc/mounts` and list the PVs on the NFS StorageClass. No PVs: uninstall the unused plugin. `vers=3` with PVs in use: add `nolock`. `vers=4` or later: the NFSv3 condition does not apply.
4. `global Cluster Platform Node Isolation`: check the node isolation policy of the global cluster. Not enabled: ignore. Enabled: contact technical support.

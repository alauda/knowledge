---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After fresh installation of a vSphere-backed cluster, the storage cluster operator stays in a degraded state with a message that points at the vSphere CSI driver:

```text
VSphereCSIDriverOperatorCRDegraded: VMwareVSphereOperatorCheckDegraded:
  unable to find VM by UUID
reason: VSphereCSIDriverOperatorCR_VMwareVSphereOperatorCheck_vcenter_api_error
```

The driver pods are running but the operator's vCenter sanity check fails: it cannot map at least one node back to a vCenter VM. The cluster is otherwise healthy — workloads schedule and run, but PVC provisioning against the vSphere CSI storage class is broken until the operator clears the degraded condition.

## Root Cause

The vSphere CSI driver identifies each node by its `spec.providerID`, a string of the form `vsphere://<vm-uuid>`. The Cloud Controller Manager (CCM) writes this field exactly once: when a freshly-joined node carries the well-known taint `node.cloudprovider.kubernetes.io/uninitialized:NoSchedule`. The CCM watches for nodes with that taint, looks up the matching VM in vCenter, populates `providerID` plus the cloud labels, and removes the taint. If the taint is not present, the CCM never picks the node up, `providerID` stays empty, and the CSI operator's "find VM by UUID" check fails forever.

The taint is set by the kubelet at node registration time when the kubelet is started with `--cloud-provider=external`. Common reasons for a node to come up without it:

- Infra nodes that were added through a custom workflow (manual scale-out, an out-of-band script) where the kubelet flag was not applied.
- Nodes that joined before the cluster was reconfigured to use the external cloud provider — those nodes never received the new flag and were never re-registered.
- A bootstrap script that calls `kubeadm join` directly without passing through the operator that normally sets the kubelet's cloud-provider arguments.

Once the node is `Ready` without the taint, the CCM doesn't retroactively pick it up — the taint is the trigger.

## Resolution

Add the missing taint by hand on every node where `providerID` is empty. The CCM watches the taint, fills in the missing fields, and removes the taint itself once the lookup succeeds:

```bash
for node in $(kubectl get node -o jsonpath='{range .items[?(!@.spec.providerID)]}{.metadata.name}{"\n"}{end}'); do
  kubectl taint node "$node" \
    node.cloudprovider.kubernetes.io/uninitialized=true:NoSchedule
done
```

Within a minute, the CCM logs should show one "Successfully initialised node" entry per affected node, the taint disappears, and the CSI operator's degraded condition clears.

To prevent the recurrence on future scale-out, fix the registration workflow rather than re-applying the taint each time:

- For nodes provisioned through the cluster's installer / node management flow, confirm the kubelet drop-in passes `--cloud-provider=external`. New nodes will then carry the uninitialized taint at first registration.
- For one-off nodes added manually, codify the post-join steps so the operator runs the taint command before the node leaves the install playbook.
- For clusters running with the in-tree vSphere driver migrated to the external CSI driver, validate that every existing node has a non-empty `providerID` after the migration, and apply the taint to any laggards.

## Diagnostic Steps

List nodes that are missing `providerID`:

```bash
kubectl get node -o json \
  | jq -r '.items[] |
      select(.spec.providerID == null or .spec.providerID == "") |
      .metadata.name'
```

For one such node, inspect both the system UUID (set by the kubelet at registration) and the providerID (set by the CCM):

```bash
kubectl get node <node> -o yaml \
  | grep -E 'systemUUID|providerID'
```

A healthy node has both populated and the providerID's UUID portion matches `systemUUID`. A node missing the providerID may also be missing the cloud taint — confirm with:

```bash
kubectl get node <node> -o jsonpath='{.spec.taints}' ; echo
```

If `node.cloudprovider.kubernetes.io/uninitialized` is absent, the CCM never saw the node — apply the taint and re-check.

To verify the CCM picks the node up after the taint is applied, follow its log:

```bash
kubectl -n cloud-controller-manager logs deployment/vsphere-cloud-controller-manager --tail=100 \
  | grep -E '<node-name>|providerID'
```

A successful initialisation logs a "Successfully initialized node" entry and the taint vanishes from the node spec on the next reconcile.

If the taint stays in place after several minutes, the failure is on the vCenter side: the CCM cannot match the node's `systemUUID` to a VM. Verify in vCenter that the VM exists and that the system UUID matches the value reported by the node — a mismatch usually points at a clone-from-template that re-used the source VM's UUID.

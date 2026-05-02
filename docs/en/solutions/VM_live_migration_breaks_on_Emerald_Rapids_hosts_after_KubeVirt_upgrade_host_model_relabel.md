---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After upgrading the KubeVirt operator on a cluster whose worker nodes are Intel Emerald Rapids hosts, live migration breaks for VMs that had been migrated previously. Symptoms:

- The target `virt-launcher` pod for the migration sticks in `Pending`; the scheduler reports no nodes match the pod's selector.
- The VM's running pod has a `nodeSelector` of the form `cpu-model-migration.node.kubevirt.io/SapphireRapids: "true"`, but no node in the cluster carries that label any more.
- Worker node labels now include `cpu-model-migration.node.kubevirt.io/SierraForest=true` instead.
- Brand-new VMs and VMs that have never been live-migrated migrate successfully; only previously-migrated VMs are stuck.

## Root Cause

KubeVirt's `node-labeller` queries `libvirt`'s `host-model` for each worker and writes a `cpu-model-migration.node.kubevirt.io/<model>` label that virt-launcher pods carry as a `nodeSelector` — so a migrating VM only lands on a host whose CPU model is identical to the source.

Before the upgrade, the bundled libvirt did not have an exact match for Emerald Rapids and reported `SapphireRapids` as the closest `host-model`. node-labeller wrote `SapphireRapids=true` on every Emerald Rapids node; VMs that live-migrated during this window kept the `SapphireRapids` selector pinned in their virt-launcher pod spec.

The KubeVirt upgrade pulls in a newer libvirt that adds a `SierraForest` model, which is now the closest match for Emerald Rapids. node-labeller re-runs, removes `SapphireRapids=true`, and writes `SierraForest=true`. Pods with the old selector lose every viable target. To make this worse, the new libvirt build often returns `usable=no` for `SapphireRapids` even on the same Emerald Rapids silicon — so the old label cannot simply be added back without telling node-labeller to leave it alone.

## Resolution

Upstream fix: the KubeVirt project has the regression tracked and a corrected build of node-labeller / libvirt is in the pipeline. Until the cluster runs that fix, two workarounds keep migrations alive.

### Workaround A — Stop and start each affected VM (cleanest)

A cold start (stop + start) replaces the virt-launcher pod entirely. The newly created pod inherits today's labels, so its `nodeSelector` carries `SierraForest=true` and the VM migrates correctly afterwards. Schedule a maintenance window for the affected guests; this is the option that does not leave residual configuration to undo.

```bash
virtctl stop  <vm-name> -n <ns>
virtctl start <vm-name> -n <ns>
```

### Workaround B — Re-add the missing CPU label and pin node-labeller

When stopping VMs is unacceptable, manually re-add `SapphireRapids=true` to each worker node and tell node-labeller to leave that node alone so it does not strip the label on the next reconcile.

> Apply only after the cluster upgrade has finished and node-labeller has settled — annotating mid-upgrade interleaves badly with the labeller's reconcile loop. If you previously disabled node-labeller during the upgrade window, re-enable it first, let it relabel everything once, then run these steps.

For each affected worker:

```bash
NODE=worker-0
# Tell node-labeller to skip this node — preserves manual labels.
kubectl annotate node "$NODE" node-labeller.kubevirt.io/skip-node=true --overwrite
# Re-add the migration-target CPU label that the running VMs depend on.
kubectl label node "$NODE" cpu-model-migration.node.kubevirt.io/SapphireRapids=true --overwrite
```

After the cluster moves to the fixed KubeVirt build, remove the skip annotation so node-labeller resumes reconciling that node:

```bash
kubectl annotate node "$NODE" node-labeller.kubevirt.io/skip-node-
```

Existing VMs migrate again because both the old and the new label are now present. New VMs will be tagged with the new `SierraForest` label, so they migrate cleanly without the workaround.

## Diagnostic Steps

1. Inspect a stuck virt-launcher pod's `nodeSelector` — that is the source of truth for which migration label the running VM expects:

   ```bash
   kubectl get pod <virt-launcher-pod> -n <ns> -o jsonpath='{.spec.nodeSelector}' | jq
   # Expect: { "cpu-model-migration.node.kubevirt.io/SapphireRapids": "true", ... }
   ```

2. Confirm that no current node carries the required label:

   ```bash
   kubectl get node --show-labels | grep cpu-model-migration
   ```

   Nodes with `SierraForest=true` and no `SapphireRapids=true` is the fingerprint of this issue on Emerald Rapids hardware.

3. Cross-check what libvirt reports inside an upgraded virt-launcher and a non-upgraded one — the `host-model` element is the data point node-labeller uses:

   ```bash
   # On a freshly created (post-upgrade) virt-launcher pod:
   kubectl exec -it <new-virt-launcher> -- virsh domcapabilities | grep -A2 host-model
   #  -> <model>SierraForest</model>

   # On a virt-launcher pod created before the upgrade (still running):
   kubectl exec -it <old-virt-launcher> -- virsh domcapabilities | grep -A2 host-model
   #  -> <model>SapphireRapids</model>
   ```

   The two values being different on the same physical host confirms libvirt's host-model has shifted — the underlying cause of the broken `nodeSelector`.

4. To watch node-labeller reconcile after applying the workaround, follow its logs:

   ```bash
   kubectl logs -n <kubevirt-namespace> ds/node-labeller --tail=100 -f
   ```

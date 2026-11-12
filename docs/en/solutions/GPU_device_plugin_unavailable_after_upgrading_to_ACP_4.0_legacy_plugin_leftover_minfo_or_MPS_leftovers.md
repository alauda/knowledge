---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
---

# GPU device plugin unavailable after upgrading to ACP 4.0: legacy plugin, leftover minfo, or MPS leftovers

## Issue

Around a cluster upgrade to the ACP 4.0 line, the GPU plugin stops working or blocks the upgrade:

- A GPU cluster cannot be upgraded to 4.0.11, or the cluster shows a device plugin with `mps` although MPS is not enabled in the plugin (Cause 1).
- After a cluster upgrade (for example from 3.16 to 4.0.12), the NVIDIA GPU plugin is unavailable. `kubectl get minfo` still lists a GPU plugin entry for the cluster at the pre-upgrade version, but no `ars` object exists for it and no device-plugin Pod runs on the GPU nodes. GPU nodes stop advertising `nvidia.com/gpu`, and GPU workloads cannot be scheduled (Cause 2).
- After the MPS plugin was uninstalled and the cluster switched to HAMi, applications seem unable to run GPU processes, and `nvidia-smi` shows no application process on the card. `nvidia-mps-device-plugin-daemonset-<suffix>` and `nvidia-mps-webhook-deployment-<suffix>` Pods are still `Running` in `kube-system` (Cause 3).

`minfo` (ModuleInfo) is the platform's record of a cluster plugin installed on a cluster; `ars` is the object that deploys the plugin's workloads.

Related articles: *HAMi or NVIDIA device-plugin Pod missing, Pending, or failing on a GPU node on ACP* (a device-plugin DaemonSet that exists but has no Pod on a node: label, taint, or driver).

## Root Cause

### Cause 1: The legacy GPU device plugin is not compatible with ACP 4.0

The legacy plugin, Alauda Container Platform GPU Device Plugin (latest version then v4.1.5, which supports exclusive and shared GPU use), is no longer supported for an upgrade to the 4.0 line. A cluster that still runs it cannot be upgraded to 4.0.11, and the cluster can show a device plugin with `mps` although MPS is not enabled. The replacement is the cluster plugin Alauda Build of NVIDIA GPU Device Plugin (latest version then v0.18.4), which provides exclusive whole-card physical GPU scheduling. A cluster that uses MPS-style sharing deploys Alauda Build of HAMi as well.

### Cause 2: The old plugin's minfo is still listed after the upgrade, but its ars and Pods are gone

The cluster upgrade left the old-version GPU plugin behind. Its `minfo` still points at the pre-upgrade version, and the plugin version that matches the upgraded platform has not been deployed. With no current plugin running, nothing registers the GPUs on the nodes. Deploying the new-version GPU plugin and deleting the old-version `minfo` make the plugin available again. Changing node labels is not part of this fix.

### Cause 3: GPU processes do not run after switching from the MPS plugin to HAMi, because MPS leftovers remain

The MPS plugin was uninstalled and the cluster switched to HAMi (2.6.1). The plugin's `minfo` was deleted, but its `ars` object was left, and in `kube-system` the `nvidia-mps-device-plugin-daemonset-<suffix>` Pods (`2/2`) and `nvidia-mps-webhook-deployment-<suffix>` (`1/1`) are still `Running`. Deleting the `ars` by hand leaves the DaemonSet in place, because the DaemonSet is owned by a Helm release rather than by the cluster plugin. Deleting the residual `ars`, running `helm uninstall` for that release, and restarting the application restores service.

## Resolution

### Cause 1: The legacy GPU device plugin is not compatible with ACP 4.0

Use this only when the cluster still runs Alauda Container Platform GPU Device Plugin, and either the upgrade to 4.0.x is blocked or a device plugin with `mps` appears though MPS is not enabled. Replace the legacy plugin with Alauda Build of NVIDIA GPU Device Plugin; if workloads use MPS-style sharing, deploy Alauda Build of HAMi for them. After the switch, check GPU monitoring: from ACP 4.0, platform GPU monitoring reads the DCGM exporter, which can be missing after the legacy plugin is removed.

```bash
kubectl get ds -A | grep -i -E 'device-plugin|mps|hami|dcgm'
kubectl get node -L nvidia-device-enable,gpu
```

> **Warning:** Uninstalling the legacy plugin removes its device registration. Nodes stop advertising its GPU resources until the replacement is Ready, and GPU Pods recreated in that window stay Pending; running containers are not deleted by the uninstall itself. Use a maintenance window. Each node can be owned by only one of `gpu=on`, `nvidia-device-enable=pgpu`, and `nvidia-device-enable=pgpu-dra`; set the label for the plugin that will own the node. Rollback, before the cluster upgrade is started, is reinstalling the legacy plugin from the cluster plugin page.

After the switch, clear MPS leftovers with Cause 3 before declaring the move done.

### Cause 2: The old plugin's minfo is still listed after the upgrade, but its ars and Pods are gone

Use this only when, after a cluster upgrade, the GPU plugin's `minfo` for this cluster shows the pre-upgrade version and there is no `ars` and no device-plugin Pod for it.

1. Deploy the new-version GPU plugin on the upgraded cluster from Administrator > Marketplace > Cluster Plugin > the target cluster. On 4.0, the replacement for the legacy plugin is Alauda Build of NVIDIA GPU Device Plugin. Keep the node label the plugin selects (`nvidia-device-enable=pgpu`) on the GPU nodes it should own.

> **Warning:** Deploying the GPU plugin starts device-plugin Pods on every node that carries the selected label, and those nodes begin advertising `nvidia.com/gpu`. Nodes owned by HAMi (`gpu=on`) or DRA (`nvidia-device-enable=pgpu-dra`) must not also get the pGPU label. Only on the cluster whose plugin is confirmed missing. Rollback is uninstalling the plugin from the same Cluster Plugin page.

2. Delete the old-version `minfo`. `ModuleInfo` objects are read on the global cluster; find the entry by the business cluster's name.

> **Warning:** Deleting a `minfo` removes the platform's record of that plugin installation on the cluster. Only when its version is the pre-upgrade one and no `ars` or Pod belongs to it. If the only GPU `minfo` for the cluster is already the new version, stop: deleting it removes the plugin you just deployed. Save the YAML first; `kubectl apply -f` of the saved file restores the record, together with the old, incompatible plugin entry.

```bash
kubectl get minfo -l cpaas.io/cluster-name=<cluster-name> --show-labels | grep -i -E 'gpu|nvidia'
kubectl get minfo <old-gpu-minfo> -o yaml | grep -i -E 'version|module-name'
kubectl get minfo <old-gpu-minfo> -o yaml > "$HOME/<old-gpu-minfo>.yaml"
kubectl delete minfo <old-gpu-minfo>
```

3. On the upgraded cluster, confirm that the device-plugin Pods are `Running` and the GPU nodes advertise `nvidia.com/gpu` again:

```bash
kubectl get pods -A -o wide | grep -E 'nvidia-device-plugin|device-plugin'
kubectl get node -o custom-columns='NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu'
```

### Cause 3: GPU processes do not run after switching from the MPS plugin to HAMi, because MPS leftovers remain

Use this only when the MPS plugin has been uninstalled, HAMi is installed, and an MPS `ars` object or MPS DaemonSet is still present. Identify the leftovers first; `-A` finds the `ars` wherever it is (usually `cpaas-system`).

```bash
kubectl get pods -n kube-system | grep -E 'nvidia-mps-device-plugin-daemonset|nvidia-mps-webhook-deployment'
kubectl get minfo -A | grep -i mps
kubectl get ars -A | grep -i mps
kubectl get ds,deploy -A | grep -i mps
kubectl get ds -n <namespace> <mps-ds> -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}{"\t"}{.metadata.annotations.meta\.helm\.sh/release-name}{"\n"}'
helm list -A | grep -i mps
```

> **Warning:** Deleting the leftover `ars` object cannot be undone from the cluster, so save its YAML first; `kubectl apply -f` of the saved file restores the object, not any workload removed in the meantime. Only when the matching `minfo` is already gone and the MPS plugin is no longer wanted.

```bash
kubectl get ars -n <namespace> <mps-ars> -o yaml > "$HOME/mps-ars.yaml"
kubectl delete ars -n <namespace> <mps-ars>
```

> **Warning:** `helm uninstall` deletes the MPS DaemonSet, the MPS webhook Deployment if it belongs to the same release, and the other objects of that release; nodes that the MPS plugin still served lose its devices. Only when `managed-by` is `Helm` or `helm list` shows the release, and the cluster has already moved to HAMi. Save the values first; rollback is `helm install` of the same chart with the saved values.

```bash
helm get values -n <namespace> <release> -o yaml > "$HOME/mps-release-values.yaml"
helm uninstall -n <namespace> <release>
```

Confirm that no `nvidia-mps-device-plugin-daemonset` or `nvidia-mps-webhook-deployment` Pod is left in `kube-system`, then restart the application.

> **Warning:** A rollout restart replaces every Pod of the workload; requests in flight on the old Pods end. Only after the MPS leftovers are removed. No rollback is needed; the Deployment recreates its Pods from the same template.

```bash
kubectl rollout restart -n <app-namespace> deploy/<app>
```

## Diagnostic Steps

1. On the global cluster, list the GPU plugin `minfo` objects for the cluster and read their versions. A version from before the upgrade and no entry at the new version is Cause 2. An `mps` entry left after a switch to HAMi points to Cause 3.

```bash
kubectl get minfo -A | grep <cluster-name> | grep -i -E 'gpu|nvidia|mps|hami'
kubectl describe minfo <gpu-minfo>
```

2. Look for the matching `ars` object and the device-plugin DaemonSet. No `ars` and no DaemonSet means the plugin is not deployed (Cause 2). A DaemonSet with no Pod on a node is the device-plugin article in Issue instead.

```bash
kubectl get ars -A | grep -i -E 'gpu|nvidia|mps'
kubectl get ds -A | grep -i -E 'device-plugin|nvidia|mps'
```

3. List the GPU plugin DaemonSets and their images. A legacy Alauda Container Platform GPU Device Plugin on a cluster heading for 4.0 is Cause 1.

```bash
kubectl get ds -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,IMAGE:.spec.template.spec.containers[*].image' | grep -i -E 'device-plugin|mps|hami'
```

4. Read the GPU node labels so that the redeployed plugin lands on the right nodes and no node gets two GPU managers:

```bash
kubectl get node -L nvidia-device-enable,gpu
```

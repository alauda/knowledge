---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# HAMi or NVIDIA device-plugin Pod missing, Pending, or failing on a GPU node on ACP

## Issue

GPU resources disappear from a node and GPU workloads on it cannot start, because the device-plugin Pod for that node is not running:

- `gpu-device-plugin` Pods are missing after an upgrade to 4.0.11, so application Pods cannot be scheduled (Cause 1).
- After a node-isolation policy assigned nodes to a project, the `hami-device-plugin` Pod stays `Pending` on those nodes, GPU resources are no longer reported, and GPU workloads in the project do not start. `dcgm-exporter` on the same nodes can be hit the same way (Cause 2).
- New Pods cannot be brought up on a GPU node, and HAMi is not running there (Cause 3).
- Alerts keep firing for `nvidia-device-plugin`, its Pod on one node cannot start, and `nvidia-smi` on that node prints nothing (Cause 4).

Background: Alauda Build of HAMi, the physical-GPU (pGPU) device plugin, and the NVIDIA DRA driver can be installed in one cluster, but they cannot share one node or one GPU. The mutually exclusive node assignments are `gpu=on` (HAMi), `nvidia-device-enable=pgpu` (pGPU), and `nvidia-device-enable=pgpu-dra` (DRA). The pGPU plugin's core workload is the `nvidia-device-plugin` DaemonSet, which reports `nvidia.com/gpu` and depends on the NVIDIA driver and the NVIDIA container runtime.

Related articles: *GPU device plugin unavailable after upgrading to ACP 4.0: legacy plugin, leftover minfo, or MPS leftovers* (the plugin itself is gone or replaced after an upgrade), and *HAMi GPU Pods stay Pending while GPUs are free: expired certificate or default-scheduler on ACP* (device-plugin Pods are `Running` and a GPU Pod is still `Pending`).

## Root Cause

### Cause 1: gpu-device-plugin 4.0.11 Pods are not created while nvidia-device-enable=enable

After `gpu-device-plugin` is upgraded to 4.0.11, the device-plugin Pod is not created and application Pods cannot be scheduled. The node label `nvidia-device-enable` is still `enable`, while that package selects `vgpu`. Changing the value from `enable` to `vgpu` creates the Pods. This is not the HAMi label `gpu=on`, nor the pGPU value `pgpu` or the DRA value `pgpu-dra`.

### Cause 2: hami-device-plugin is Pending with untolerated taint nodeGroup=<policy-name>:NoSchedule

An Exclusive node-isolation policy (`NodeGroup`, `security.alauda.io/v1beta1`) taints its nodes `nodeGroup=<policy-name>:NoSchedule`. This is expected: Pods of other projects cannot land there. The HAMi device-plugin DaemonSet has no toleration for that taint, so it cannot land there either, and the node stops advertising GPU resources. This is a product limitation; adding a matching toleration to the device-plugin DaemonSet restores GPU registration. A toleration setting in the plugin itself was planned for HAMi 2.9.1.

### Cause 3: The NVIDIA driver is not installed on the node, so HAMi cannot start there

New Pods cannot start on a GPU node that has no GPU driver installed. HAMi does not run on that node because the driver is missing. After the driver is installed, HAMi comes up and new Pods start.

### Cause 4: nvidia-device-plugin keeps alerting on a node with a broken driver that still has nvidia-device-enable=pgpu

The node once had an NVIDIA driver, the driver is now broken, and the GPU on it is no longer used. `nvidia-smi` returns no output. The node still carries `nvidia-device-enable=pgpu`, so the `nvidia-device-plugin` DaemonSet of Alauda Build of NVIDIA GPU Device Plugin keeps placing a Pod there; the Pod cannot start and the alerts keep firing. Other GPU nodes still need the plugin, so uninstalling it is not an option. Removing the label from that one node stops the plugin Pod there and leaves the plugin running on the rest of the cluster.

## Resolution

### Cause 1: gpu-device-plugin 4.0.11 Pods are not created while nvidia-device-enable=enable

Use this only when `gpu-device-plugin` is 4.0.11, the device-plugin Pod is absent, the DaemonSet `nodeSelector` requires `nvidia-device-enable=vgpu`, and the node label is still `enable`. Read the selector before labeling. If the node already has `gpu=on`, `nvidia-device-enable=pgpu`, or `nvidia-device-enable=pgpu-dra`, confirm which plugin should own the node first.

> **Warning:** Overwriting `nvidia-device-enable` changes which device-plugin DaemonSet can place Pods on the node. The plugin Pod starting or stopping registers or unregisters GPU devices and can leave new GPU Pods Pending. Existing application Pods are not deleted by the label command. Only on nodes whose label is `enable` and whose 4.0.11 DaemonSet requires `vgpu`. Rollback is `kubectl label node <node> nvidia-device-enable=enable --overwrite`.

```bash
kubectl get ds -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,SELECTOR:.spec.template.spec.nodeSelector' | grep -i device-plugin
kubectl label node <node> nvidia-device-enable=vgpu --overwrite
kubectl get pods -A -o wide | grep -i device-plugin
```

If the cluster upgrade itself is blocked by the legacy plugin, see the related upgrade article.

### Cause 2: hami-device-plugin is Pending with untolerated taint nodeGroup=<policy-name>:NoSchedule

Use this only when the device-plugin Pod event says it does not tolerate `nodeGroup=<policy-name>:NoSchedule`, and the value matches an Exclusive `NodeGroup`. Save the DaemonSet first, and add toleration items; replacing the whole `tolerations` list drops the tolerations the DaemonSet already has.

The narrow form tolerates only that policy's taint:

> **Warning:** This lets the HAMi device plugin run on nodes that are exclusive to the bound projects, so those nodes advertise GPU resources again. It does not add the toleration to business Pods; other projects still cannot schedule there. Only when the event cites this taint. Rollback is `kubectl apply -f` of the saved DaemonSet. Do not remove the `NodeGroup` or the taint instead; that would let other projects onto those nodes.

```bash
kubectl get ds -n kube-system hami-device-plugin -o yaml > "$HOME/hami-device-plugin-ds.yaml"
kubectl patch ds -n kube-system hami-device-plugin --type=json -p '[{"op":"add","path":"/spec/template/spec/tolerations/-","value":{"key":"nodeGroup","operator":"Equal","value":"<policy-name>","effect":"NoSchedule"}}]'
```

The broad form copies the toleration set of the cluster's `calico` DaemonSet, so later policies do not break the plugin again. Compare with the `calico` DaemonSet first.

> **Warning:** Tolerations with `operator: Exists` for `NoSchedule` and `NoExecute` and no key let the device-plugin Pod run on every node with such a taint, including nodes tainted `NoExecute` for maintenance or by other policies. Only when the device-plugin Pod cannot be placed on nodes of an Exclusive node-isolation policy. Rollback is `kubectl apply -f` of the saved DaemonSet. A change made directly on a platform-managed DaemonSet can be overwritten by a plugin upgrade; re-check the tolerations after every HAMi upgrade.

```bash
kubectl get ds -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.template.spec.tolerations}{"\n"}{end}' | grep -i calico
kubectl patch ds -n kube-system hami-device-plugin --type=json -p '[{"op":"add","path":"/spec/template/spec/tolerations/-","value":{"effect":"NoSchedule","operator":"Exists"}},{"op":"add","path":"/spec/template/spec/tolerations/-","value":{"key":"CriticalAddonsOnly","operator":"Exists"}},{"op":"add","path":"/spec/template/spec/tolerations/-","value":{"effect":"NoExecute","operator":"Exists"}}]'
kubectl get ds -n kube-system hami-device-plugin -o jsonpath='{.spec.template.spec.tolerations}{"\n"}'
```

If `tolerations` is absent, the `/-` path fails; add a `tolerations` array with those items through `kubectl edit` instead. After the edit, confirm the DaemonSet still carries its container `lifecycle` section; HAMi relies on it to enforce GPU memory limits in containers. Apply the same toleration to `dcgm-exporter` or another DaemonSet only when its own Pod event cites the same taint.

### Cause 3: The NVIDIA driver is not installed on the node, so HAMi cannot start there

Use this only when the HAMi device-plugin Pod is not running on the node and `nvidia-smi` on that node is `command not found`, or no NVIDIA kernel module is loaded. Install the NVIDIA GPU driver on the node, following the platform GPU driver installation documentation for a driver version your HAMi build supports. HAMi starts on the node afterwards without any other change.

> **Warning:** Installing a GPU driver loads kernel modules and often needs a node reboot. The drain below evicts every non-DaemonSet Pod on the node and deletes their `emptyDir` data, and GPU workloads on that node stop until it is back. Only on a node where the driver is confirmed absent, in a maintenance window. Rollback is `kubectl uncordon <node>` for the drain, and removing the driver package with the package manager that installed it.

```bash
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
# install the NVIDIA driver on the node; reboot if the installer asks for it
kubectl uncordon <node>
```

After the node is back, `nvidia-smi` must list the GPUs and the `hami-device-plugin` Pod on that node must be `Running` before GPU Pods are scheduled there.

### Cause 4: nvidia-device-plugin keeps alerting on a node with a broken driver that still has nvidia-device-enable=pgpu

Use this only when `nvidia-smi` on the node returns no output, the GPU on that node is not in use, the failing `nvidia-device-plugin` Pod runs only on that node, and the node has `nvidia-device-enable=pgpu`.

> **Warning:** Removing `nvidia-device-enable` stops the `nvidia-device-plugin` Pod on that node, so the node stops advertising `nvidia.com/gpu`. Running Pods are not deleted, and nothing that needs `nvidia.com/gpu` can be scheduled there. Only when the driver on that node is confirmed broken and its GPU is unused. Rollback is `kubectl label node <node> nvidia-device-enable=pgpu` after the driver is repaired.

```bash
kubectl get node <node> -L nvidia-device-enable
kubectl label node <node> nvidia-device-enable-
kubectl get pods -A -o wide | grep nvidia-device-plugin
```

A taint on the node is the alternative. Uninstalling Alauda Build of NVIDIA GPU Device Plugin is only an option when no node in the cluster needs it.

## Diagnostic Steps

1. Find the device-plugin Pod for the affected node and read its state. No Pod at all points to Cause 1 or 4 (label). `Pending` points to Cause 2. A missing Pod on a node without a driver is Cause 3.

```bash
kubectl get pods -A -o wide | grep -E 'hami-device-plugin|nvidia-device-plugin|gpu-device-plugin|dcgm-exporter'
kubectl get ds -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,SELECTOR:.spec.template.spec.nodeSelector' | grep -i -E 'device-plugin|hami|mps'
kubectl get node -L nvidia-device-enable,gpu
```

2. For a `Pending` device-plugin Pod, read the event and the policies. `untolerated taint` with `nodeGroup` is Cause 2.

```bash
kubectl describe pod -n kube-system <hami-device-plugin-pod> | grep -E 'FailedScheduling|untolerated|nodeGroup|nvidia-device-enable'
kubectl get nodegroups.security.alauda.io
kubectl describe node <node> | grep -A3 Taints
```

3. On the node, check the driver. `command not found` or no `nvidia` module is Cause 3. A driver that is installed but `nvidia-smi` prints nothing is Cause 4.

```bash
nvidia-smi
lsmod | grep -i nvidia
```

4. If there is no device-plugin DaemonSet at all, or a GPU plugin `minfo` is listed at a pre-upgrade version, see the related upgrade article.

---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

A node running virtual machines on the ACP virtualization stack (`docs/en/virtualization/`, built on KubeVirt) can become unhealthy at any point — kernel lock-up, disk saturation, a kubelet that has wedged on a finalizer, or a full network partition. When that happens, the VMs on the node need to be rescheduled promptly. But for any VM running a workload that assumes *at-most-one* semantics (a SQL primary, a clustered file-system node, a stateful leader in a distributed algorithm), it is equally important that the *old* copy of the VM is confirmed dead before a new copy is started. Two live copies of the same at-most-one VM is worse than zero — split-brain corrupts data, duplicates external side-effects, and breaks the workload's own recovery assumptions.

High availability for VMs on ACP is therefore the combination of two mechanisms:

- **Node health detection** — the control plane recognises that a node has gone silent and declares it unhealthy.
- **Fencing** — the platform takes a positive action to guarantee the old VMs cannot be running (either by power-cycling the node externally or by confirming the node is off through the infrastructure API) before the scheduler is allowed to create replacement VMs.

Without the fencing step, the normal Kubernetes behaviour for an unreachable node — eventually evicting the pods after a grace period — is unsafe for at-most-one VMs: the node might still be running the VM when the eviction timer fires on the API server side. This article describes how to set up the two mechanisms on ACP.

## Resolution

### 1. Classify the VMs

Not every VM needs at-most-one protection. Before enabling fencing, label the VMs that do:

```bash
kubectl -n <vm-namespace> label vm <vm-name> ha-policy=at-most-one
```

The label becomes the selector for both the node-health check and any cluster-level alerting rule you add later. VMs without the label get the default "reschedule on best effort" behaviour: the platform picks them up after the standard node-unhealthy timeout, with the acceptance that a brief double-run in the worst case is tolerable for that workload.

### 2. Deploy a node health monitor

The platform's node-health surface (`configure/clusters/nodes` and the **Immutable Infrastructure** extension where installed) monitors node heartbeats. Configure a `NodeHealthCheck` (or the equivalent health-monitor CR the cluster ships) that watches the nodes carrying at-most-one VMs, escalates to `Unhealthy` after a short grace period, and triggers the fencing action when the condition is met:

```yaml
apiVersion: remediation.medik8s.io/v1alpha1
kind: NodeHealthCheck
metadata:
  name: vm-host-health
spec:
  selector:
    matchLabels:
      node-role.kubernetes.io/vm-host: ""
  unhealthyConditions:
    - type: Ready
      status: "False"
      duration: 300s
    - type: Ready
      status: Unknown
      duration: 300s
  minHealthy: "51%"
  remediationTemplate:
    apiVersion: self-node-remediation.medik8s.io/v1alpha1
    kind: SelfNodeRemediationTemplate
    name: self-node-remediation-automatic-strategy-template
    namespace: <node-health-ns>
```

Key knobs:

- **`duration`** — how long the node must be unhealthy before the monitor acts. Too short, and a transient kubelet hiccup triggers an unnecessary reboot. Too long, and at-most-one VMs stall for minutes before recovery. A five-minute window is a common default; tune per environment.
- **`minHealthy`** — a safeguard that prevents mass-remediation during a network partition that affects many nodes at once. If fewer than 51% of selected nodes are currently healthy, the monitor refuses to act on any of them until the cluster stabilises.
- **`remediationTemplate`** — the *how* of fencing. Several engines are available; which one is appropriate depends on whether the node can be trusted to reboot itself.

### 3. Pick a fencing strategy

Two broad strategies:

**Self-node-remediation (software fence).** The unhealthy node sees, via a watchdog on its own kubelet, that it has lost quorum with the rest of the cluster, and reboots itself. Cheap, no external dependencies, and works on any hardware. The catch: if the node is *actually* partitioned (not crashed), it will reboot, come back, and rejoin — which is the right outcome. If the node is wedged at a kernel level and its watchdog is also wedged, the reboot never happens; the cluster will only reschedule VMs if the underlying infrastructure can be queried to confirm the node is powered off.

**External fence (BMC, hypervisor API, cloud API).** The control plane calls a BMC (IPMI/Redfish) or an IaaS API (vSphere, KVM virtualisation host, a cloud provider's instance API) to force the node off. Guaranteed by the infrastructure, not by software running on the node. Requires credentials in-cluster and network path to the fencing endpoint.

For production at-most-one workloads, prefer the external fence as the primary, with self-node-remediation as a fallback when the external endpoint is unreachable.

Template the fencing agent as a CR:

```yaml
apiVersion: self-node-remediation.medik8s.io/v1alpha1
kind: SelfNodeRemediationTemplate
metadata:
  name: self-node-remediation-automatic-strategy-template
  namespace: <node-health-ns>
spec:
  template:
    spec:
      remediationStrategy: Automatic
```

For BMC-based external fencing, the templates are usually named after the driver (`fence-agents-redfish`, `fence-agents-ipmilan`). Configure the credentials as a Secret in the health-monitor namespace and reference it from the template `spec`.

### 4. Ensure replacement placement works

When a fenced node is declared down and the VMs it was running are rescheduled, the target host must have capacity and the VM's resources must be provisionable elsewhere:

- **Persistent volumes must be RWX-capable or live on storage that supports re-attachment** — block volumes pinned to the old node's topology will not re-attach until the old pod is force-deleted.
- **CPU / memory requests** on the VM should leave headroom across the cluster for at least one node's worth of VMs to move.
- **Placement constraints** (`nodeSelector`, `topologySpreadConstraints`) should permit more than one valid host per VM.

Prove this by drawing a virtual outage on paper: "if host X dies, do all its VMs have a landing pad?" If any one VM cannot answer yes, the HA story breaks for that VM.

### 5. Handle pre-existing pod finalisation on the fenced node

When the node health monitor marks a node unreachable, the API server applies the `node.kubernetes.io/unreachable` taint and the scheduler holds off new work. What it does *not* do is force-delete the existing `virt-launcher` pods — those are still attached to the old node and the VMs still hold their pod-level identity. The fencing agent's remediation strategy must include: confirm the node is off, then `kubectl delete pod --force --grace-period=0` the `virt-launcher` pods on the down node, so KubeVirt can create the replacement virt-launcher on a healthy host. The default remediation templates handle this; a custom template must do it explicitly.

### 6. Observe and alert

Wire alerts for both "a node has been fenced" and "a VM has not recovered after a fence":

- `NodeHealthCheck` exposes `.status` conditions and counters that can drive Prometheus alert rules (`observability/monitor`).
- A VM stuck `Starting` for longer than a few minutes after a fence is usually a storage re-attach problem (block volume multi-attach errors) — alert on `VirtualMachineInstance.status.phase == Starting` with a `for: 5m`.

## Diagnostic Steps

Confirm the `NodeHealthCheck` is active and its selector matches the expected nodes:

```bash
kubectl get nodehealthcheck vm-host-health -o yaml \
  | sed -n '/status:/,$p'
```

The `status.observedNodes` count should match the number of nodes carrying the VM-host label. `observedNodes` at zero is almost always a typo in the `matchLabels`.

During an actual fence, the sequence to watch is:

1. Node `Ready` transitions to `Unknown` or `False`.
2. `NodeHealthCheck` increments `status.inFlightRemediations`.
3. The fencing agent logs a call to the external endpoint (or the node reboots itself).
4. Node enters `NotReady,SchedulingDisabled`; the platform force-deletes the old `virt-launcher` pods.
5. New `virt-launcher` pods are created on other nodes; VMs return to `Running`.

Capture each stage:

```bash
kubectl get nodehealthcheck vm-host-health -w
kubectl -n <node-health-ns> logs -l app=self-node-remediation --tail=200
kubectl get vmi -A -l ha-policy=at-most-one -w
```

If at step 4 the VMI stays `Starting` for long, the typical culprits are:

- **Multi-attach error on a block PVC** — confirm with `kubectl describe pod <new-virt-launcher>`; resolution is to wait for the volume attach controller to notice the old node is gone (it does so once the node object is deleted, or once the force-delete of the old pod clears the volume's `.status.attachedVolumes`).
- **No capacity left on healthy nodes** — seen as `FailedScheduling`; the HA plan did not leave enough headroom, expand cluster or reduce requests.
- **Pod affinity / anti-affinity conflict** — the VM is soft-anti-affined to itself; a stale placement record on a surviving node's `virt-handler` can leave it refusing the new pod. Restart the virt-handler on the target node to clear.

A successful fence drill runs end-to-end in under a minute once the `duration:` grace has elapsed; anything longer is a signal to rehearse the scenario before depending on it in production.
</content>
</invoke>
---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Specific virtual machines exhibit a cluster of related symptoms that all trace back to the same churn:

- The platform console renders extremely slowly when viewing the affected VMs.
- A *Pending Changes* banner appears, disappears, and reappears every few seconds.
- The VM's IP field on the corresponding `VirtualMachineInstance` (VMI) flickers between values.
- The `virt-launcher` pod log is flooded with `Synced vmi` lines several times per second:

```text
{"component":"virt-launcher","level":"info","msg":"Synced vmi",
 "name":"vm-multinic","namespace":"default",
 "timestamp":"2025-09-16T01:38:35.979577Z"}
{"component":"virt-launcher","level":"info","msg":"Synced vmi",
 "name":"vm-multinic","namespace":"default",
 "timestamp":"2025-09-16T01:38:35.996711Z"}
{"component":"virt-launcher","level":"info","msg":"Synced vmi",
 "name":"vm-multinic","namespace":"default",
 "timestamp":"2025-09-16T01:38:36.179636Z"}
... (dozens per second)
```

The shared trigger is that the VM has **two or more secondary networks** attached in addition to the default pod network. VMs with only the pod network (or with one secondary network) do not loop.

## Root Cause

KubeVirt's reconcile loop on the VMI rewrites `status.interfaces` from two sources:

1. The active state observed in the launcher pod (libvirt domain interfaces, IP from the guest agent).
2. The desired state derived from the VM spec template, which lists interfaces in declaration order.

When two or more secondary networks are present, the order in which interfaces appear can disagree between those two sources — the guest agent enumerates interfaces in kernel order, the spec lists them in declaration order, and the controller's diff classifies the mismatch as a meaningful change. It writes the spec-ordering version, immediately observes the agent-ordering version, classifies that as a change too, and the loop runs continuously.

The loop is harmless to the data plane (the VM keeps running) but expensive on:

- API server traffic from the unending PUT/PATCH against VMI,
- the platform console, which subscribes to VMI updates and re-renders on every event,
- log volume on `virt-launcher` and on any logging pipeline downstream.

Two related bugs have been tracked upstream — one fixed in the 4.20-line image, one still open at the time of writing — and the workaround for both is the same: ensure the *first* interface in the VM spec is the pod network. With the pod network at index 0, the controller's diffing logic does not flip-flop on the secondary network ordering.

## Resolution

ACP delivers KubeVirt-based VM workloads through the `virtualization` capability area. The platform-preferred path is to consume the upstream fix through a managed virtualization-stack version bump rather than to hand-edit launcher pods:

1. **Upgrade the platform's virtualization stack to a version that includes the KubeVirt 4.20+ fix.** From the `virtualization` admin surface, check the running KubeVirt image; a stack older than the 4.20 fix line will keep the loop even with the workaround in place. Schedule the upgrade through the platform — KubeVirt control-plane components (virt-controller, virt-handler, virt-api) must move together, and the platform handles the order.

2. **Re-order interfaces in the VM spec so the pod network is first.** Before *and* after the upgrade, the safe authoring pattern is to declare the default pod network as the first entry under `spec.template.spec.domain.devices.interfaces` and as the first entry under `spec.template.spec.networks`. The reconciler stops flipping order when this invariant holds.

   ```yaml
   apiVersion: kubevirt.io/v1
   kind: VirtualMachine
   metadata:
     name: vm-multinic
     namespace: default
   spec:
     template:
       spec:
         domain:
           devices:
             interfaces:
               - name: default       # pod network FIRST
                 masquerade: {}
                 model: virtio
               - name: trunk0        # secondary networks AFTER
                 bridge: {}
                 model: virtio
               - name: storage-net
                 bridge: {}
                 model: virtio
         networks:
           - name: default
             pod: {}
           - name: trunk0
             multus:
               networkName: br0-trunk
           - name: storage-net
             multus:
               networkName: storage-vlan
   ```

   Apply with `kubectl apply -f vm.yaml`. The VM must be **stopped and started** (not live-migrated) to take effect — the launcher pod re-reads the spec only on fresh start, and a live migration carries the existing libvirt domain across.

3. **For VMs that cannot tolerate a stop/start, isolate the noise downstream.** Until the VM can be restarted:

   - Drop `Synced vmi` log lines at the log-collector layer (Vector/Fluentd filter on `msg == "Synced vmi"`) so the logging backend does not page on the volume.
   - Suppress the console subscription to that VM's VMI watch (most consoles let an operator switch off live updates per object); the *Pending Changes* banner toggle is harmless apart from the visual noise.

4. **Monitor for recurrence after the upgrade.** The companion upstream issue is still open, so a small subset of VMs may continue to loop even on the 4.20 line. Treat any VM whose `virt-launcher` log shows more than a couple of `Synced vmi` per minute as suspect, re-check the interface ordering, and capture a YAML diff of `kubectl get vmi <name> -o yaml` taken five seconds apart. If the diff is purely on `status.interfaces` ordering, the workaround did not stick — re-apply step 2 and confirm the spec really has the pod network at index 0 (not just *present*; index matters).

## Diagnostic Steps

Confirm the loop and identify the affected VMs:

```bash
kubectl -n <ns> logs -l vm.kubevirt.io/name=<vm> -c compute --tail=200 \
  | grep -c "Synced vmi"
```

Anything in the dozens for a 200-line tail (covering only a few seconds) is the loop. A healthy VM shows `Synced vmi` only at start, on configuration changes, and on migration.

Inspect the VMI for spec/status interface ordering:

```bash
kubectl -n <ns> get vmi <vm> -o jsonpath='{.spec.domain.devices.interfaces[*].name}{"\n"}'
kubectl -n <ns> get vmi <vm> -o jsonpath='{.status.interfaces[*].name}{"\n"}'
```

If the two lists are not in the same order *or* the spec list does not start with the pod network's interface name, the workaround applies. Re-author the VM with the pod network as the first interface, stop the VM, and start it again.

To confirm the fix has landed, take two snapshots of the VMI five seconds apart:

```bash
kubectl -n <ns> get vmi <vm> -o yaml > /tmp/vmi-1.yaml
sleep 5
kubectl -n <ns> get vmi <vm> -o yaml > /tmp/vmi-2.yaml
diff /tmp/vmi-1.yaml /tmp/vmi-2.yaml | head -40
```

A healthy VMI shows differences only on `metadata.resourceVersion` and on a handful of timestamp/heartbeat fields. A VMI still in the loop shows differences on `status.interfaces` (order, IPs, or names flipping back and forth) — that is the fingerprint that the reconciler is still racing on this VM.

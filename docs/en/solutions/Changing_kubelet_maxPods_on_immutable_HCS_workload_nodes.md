---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.x,4.2.x,4.3.x
---

# Changing the kubelet maxPods setting on immutable infrastructure nodes

## Issue

You need to change the kubelet `maxPods` setting on immutable-infrastructure worker nodes — for example, to raise pod density on a cluster provisioned on Huawei Cloud Stack (HCS). On immutable nodes you cannot simply edit a file on the host and expect the change to persist: node files are reconciled by the platform's Machine Configuration component, and an out-of-band edit is treated as configuration drift. The change also has to reach two different node populations:

- **Nodes that already exist**, which must take the new value **without being rebooted**.
- **Nodes added later** by scale-out, or replaced during an upgrade's rolling update, which must come up already carrying the new value.

This article covers both: Machine Configuration for the existing nodes, and the cluster's provider template for future nodes.

## Environment

This procedure is delivered by the Alauda Container Platform Machine Configuration component, and its applicability is tied to that component's version — **not** to the ACP platform version:

- **Machine Configuration version.** This procedure applies to the current Machine Configuration releases — those prior to the planned **v4.1.x** release. v4.1.x is **planned but not yet released**; it is intended to introduce a dedicated custom resource for kubelet configuration. Once that release is available and in use, configure the kubelet through that resource instead, and migrate the objects created here.
- **ACP platform version.** The method itself does not depend on the ACP version. Whether it can be used on a given cluster depends only on which ACP versions the installed Machine Configuration release supports. The current Machine Configuration supports ACP v4.1, v4.2, and v4.3.

## Root Cause

`maxPods` is a field of the upstream `KubeletConfiguration` (`kubelet.config.k8s.io/v1beta1`). On immutable nodes the kubelet configuration is owned by Machine Configuration, which renders and reconciles node files through the machine configuration daemon; the daemon marks a node `Degraded` if a managed file is edited out of band. Two independent delivery paths are needed because the two node populations are created differently:

- Existing nodes are **not** reprovisioned, so their running configuration must be changed in place.
- Future nodes are created from the provider's **bootstrap configuration**, so they inherit whatever that configuration specifies at first boot.

The kubelet reads its configuration from several layered sources, and the effective value follows a fixed precedence: **command-line flag > `--config-dir` drop-in > base configuration file > built-in default**. This precedence is what lets the two delivery paths coexist without fighting (see *Keeping the two paths consistent*, below).

In the Machine Configuration releases this procedure targets (see *Environment* above), there is no dedicated custom resource for kubelet configuration. The supported interim method is therefore a `MachineConfig` that writes a kubelet configuration drop-in, described below.

> This is an advanced, node-level procedure. A mistake in the kubelet service override can leave a node `NotReady`. Apply it to a non-production pool first, and engage Alauda support if you are unsure.

## Resolution

### Part 1 — Change existing nodes with Machine Configuration (no reboot)

`maxPods` takes effect after a kubelet restart; it does not require a node reboot, and running pods are not evicted. Deliver it with three objects, applied in order.

**Prerequisite — confirm the node's kubelet service.** The switch in Step 2 overrides the kubelet `ExecStart`. Read the actual `ExecStart` from a target node first and reuse it verbatim, only appending the `--config-dir` flag:

```bash
systemctl cat kubelet
```

**Step 1 — Node disruption policy.** By default a file change does not restart any service, so a drop-in would be written to disk but not applied. Add a policy that reloads systemd and restarts the kubelet when either file changes. Apply this first and confirm it appears in the `cluster` resource's `status.nodeDisruptionPolicyStatus` **before** creating the objects in Steps 2 and 3.

```yaml
apiVersion: machineconfiguration.alauda.io/v1alpha1
kind: MachineConfiguration
metadata:
  name: cluster            # the singleton in the cpaas-system namespace
spec:
  nodeDisruptionPolicy:
    files:
      - path: /etc/systemd/system/kubelet.service.d/25-config-dir.conf
        actions:
          - type: DaemonReload
          - type: Restart
            restart:
              serviceName: kubelet.service
      - path: /etc/kubernetes/kubelet.conf.d/30-maxpods.conf
        actions:
          - type: DaemonReload
          - type: Restart
            restart:
              serviceName: kubelet.service
    sshkey:
      actions:
        - type: None
```

**Step 2 — Enable the kubelet `--config-dir` (once per pool).** This lets the kubelet read drop-in files from `/etc/kubernetes/kubelet.conf.d/`. Write it as a file (not as a `systemd.units` entry) so that removing it later does not disturb the base kubelet unit. Prepare the drop-in — **adjust the `ExecStart` line to match the output of `systemctl cat kubelet` on your nodes**:

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS --config-dir=/etc/kubernetes/kubelet.conf.d
```

Base64-encode it:

```bash
base64 -w0 25-config-dir.conf
```

Create the `MachineConfig` (the `contents.source` below is the encoding of the drop-in above):

```yaml
apiVersion: machineconfiguration.alauda.io/v1alpha1
kind: MachineConfig
metadata:
  name: 25-worker-kubelet-config-dir
  labels:
    machineconfiguration.alauda.io/role: worker
    machineconfiguration.alauda.io/kubelet-config: "config-dir"
spec:
  config:
    ignition:
      version: 3.4.0
    storage:
      files:
        - path: /etc/systemd/system/kubelet.service.d/25-config-dir.conf
          mode: 0o644
          overwrite: true
          contents:
            source: 'data:text/plain;base64,W1NlcnZpY2VdCkV4ZWNTdGFydD0KRXhlY1N0YXJ0PS91c3IvYmluL2t1YmVsZXQgJEtVQkVMRVRfS1VCRUNPTkZJR19BUkdTICRLVUJFTEVUX0NPTkZJR19BUkdTICRLVUJFTEVUX0tVQkVBRE1fQVJHUyAtLWNvbmZpZy1kaXI9L2V0Yy9rdWJlcm5ldGVzL2t1YmVsZXQuY29uZi5kCg=='
```

**Step 3 — Set maxPods.** Write a partial `KubeletConfiguration` into the `--config-dir` directory. The example sets `maxPods: 250`:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
maxPods: 250
```

Base64-encode it:

```bash
base64 -w0 30-maxpods.conf
```

Create the `MachineConfig`:

```yaml
apiVersion: machineconfiguration.alauda.io/v1alpha1
kind: MachineConfig
metadata:
  name: 30-worker-kubelet-maxpods
  labels:
    machineconfiguration.alauda.io/role: worker
    machineconfiguration.alauda.io/kubelet-config: "setting"
  annotations:
    machineconfiguration.alauda.io/kubelet-fields: "maxPods"
spec:
  config:
    ignition:
      version: 3.4.0
    storage:
      files:
        - path: /etc/kubernetes/kubelet.conf.d/30-maxpods.conf
          mode: 0o644
          overwrite: true
          contents:
            source: 'data:text/plain;base64,YXBpVmVyc2lvbjoga3ViZWxldC5jb25maWcuazhzLmlvL3YxYmV0YTEKa2luZDogS3ViZWxldENvbmZpZ3VyYXRpb24KbWF4UG9kczogMjUwCg=='
```

After both `MachineConfig` objects are applied, the daemon reloads systemd and restarts the kubelet on each targeted node; the new `maxPods` takes effect and the node is not rebooted.

Keep each concern in its own object: put only kubelet settings in these objects (not chrony, sysctl, or unrelated files); name drop-in files `NN-<name>.conf` with `NN` in the 10–49 range; and keep the labels shown above. To change another kubelet field, add another Step 3-style object with a new file number, and add its path to the disruption policy in Step 1.

### Part 2 — Make future nodes carry the value (provider template)

New worker (compute) nodes are created from the worker pool's `KubeadmConfigTemplate` (together with its `MachineDeployment` and `HCSMachineTemplate`). Set `maxPods` there so nodes are born with it. Control-plane nodes are configured through a different resource—the `KubeadmControlPlane`—and are out of scope for this workload-node procedure.

For worker nodes, set the value with `joinConfiguration.nodeRegistration.kubeletExtraArgs` in the `KubeadmConfigTemplate`. Add `max-pods` alongside any existing `kubeletExtraArgs` entries (such as `volume-plugin-dir`); do not remove them:

```yaml
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: <cluster>-<worker-pool>
spec:
  template:
    spec:
      joinConfiguration:
        nodeRegistration:
          kubeletExtraArgs:
            max-pods: "250"
```

`kubeletExtraArgs` becomes a kubelet command-line flag (`--max-pods`). Applying this template does not change existing nodes; it only affects worker nodes created after the change. Because a flag takes precedence over the Part 1 `--config-dir` drop-in, the provider value is authoritative on new nodes—keep it identical to the Part 1 value (see *Keeping the two paths consistent*).

### Keeping the two paths consistent

A common concern is whether re-applying the Machine Configuration drop-in to a new node—one the provider bootstrap already configured—causes a problem. It does not:

- The two paths do not share a file. On existing nodes, Machine Configuration writes the `maxPods` drop-in under `/etc/kubernetes/kubelet.conf.d/`. On new worker nodes, the provider sets `maxPods` as a kubelet flag (`--max-pods`) through `kubeletExtraArgs`. The machine configuration daemon manages only its own drop-in and switch files and never touches the provider's flag, so there is no shared-ownership conflict, no drift, and no reboot loop.
- A new node also matches the `MachineConfigPool`, so the daemon applies the drop-in there too. Because the flag already sets the same value, the effective `maxPods` does not change; at most this triggers one kubelet restart on first reconcile — harmless.
- Precedence decides the effective value on a new node, where both are present: the kubelet flag wins over the `--config-dir` drop-in, so the provider value is authoritative and the drop-in is shadowed. Keep the Part 1 and Part 2 values **identical** so the result is the same either way. Set the value only through these two declarative paths; do not edit nodes over SSH.

### Limitations

- **Pod network sizing.** `maxPods` cannot exceed the number of pod IP addresses available per node. With the default per-node pod CIDR (a `/24`, roughly 254 usable addresses), a node cannot usefully run more pods than that regardless of `maxPods`. Before raising `maxPods` toward or beyond that number, check the cluster's per-node pod CIDR size; enlarging it is a cluster-wide networking change that must be planned separately.
- **Interim method, bounded by the Machine Configuration version.** This drop-in approach is the supported path on the current Machine Configuration releases (those prior to the planned **v4.1.x**), which have no dedicated kubelet-configuration resource. The v4.1.x release is **planned but not yet available**; it is intended to add that resource. Once the cluster runs a Machine Configuration release that provides it, migrate the Part 1 objects to it and stop using this method. The labels and the one-object-per-field layout above are what make that migration mechanical. Note this boundary is set by the Machine Configuration version, not by the ACP version.

## Diagnostic Steps

Read the live, effective kubelet configuration from a node and confirm `maxPods`. This returns the merged value actually in use:

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | jq '.kubeletconfig.maxPods'
```

Check both an existing node (changed by Part 1) and a node added after the Part 2 change; both should report the value you set (`250` in the examples). If an existing node still shows the old value, confirm that the node disruption policy from Step 1 is present in the `cluster` resource's `status.nodeDisruptionPolicyStatus`, and that the kubelet `ExecStart` in the Step 2 switch matches the node's actual service.

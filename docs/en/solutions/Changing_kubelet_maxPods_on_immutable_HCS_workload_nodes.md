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

## Root Cause

`maxPods` is a field of the upstream `KubeletConfiguration` (`kubelet.config.k8s.io/v1beta1`). On immutable nodes the kubelet configuration is owned by Machine Configuration, which renders and reconciles node files through the machine configuration daemon; the daemon marks a node `Degraded` if a managed file is edited out of band. Two independent delivery paths are needed because the two node populations are created differently:

- Existing nodes are **not** reprovisioned, so their running configuration must be changed in place.
- Future nodes are created from the provider's **bootstrap configuration**, so they inherit whatever that configuration specifies at first boot.

The kubelet reads its configuration from several layered sources, and the effective value follows a fixed precedence: **command-line flag > `--config-dir` drop-in > base configuration file > built-in default**. This precedence is what lets the two delivery paths coexist without fighting (see *Keeping the two paths consistent*, below).

On ACP 4.1–4.3, Machine Configuration does not yet provide a dedicated custom resource for kubelet configuration. The supported interim method is a `MachineConfig` that writes a kubelet configuration drop-in, described below. A future release introduces a dedicated kubelet-configuration resource; when you upgrade to it, migrate the objects created here to that resource.

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

New worker nodes are created from the worker pool's `KubeadmConfigTemplate` (together with its `MachineDeployment` and `HCSMachineTemplate`). Set `maxPods` there so nodes are born with it.

Use a kubeadm `KubeletConfiguration` **patch**, not `kubeletExtraArgs`. HCS clusters already apply kubelet patches this way (for example, for the kubelet serving certificate). Add `maxPods` to the worker pool's `KubeadmConfigTemplate`, either by extending the existing `kubeletconfiguration…+strategic.json` patch or by adding a new patch file:

```yaml
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: <cluster>-<worker-pool>
spec:
  template:
    spec:
      files:
        - path: /etc/kubernetes/patches/kubeletconfiguration1+strategic.json
          owner: root:root
          permissions: "0644"
          content: |
            {
              "apiVersion": "kubelet.config.k8s.io/v1beta1",
              "kind": "KubeletConfiguration",
              "maxPods": 250
            }
      joinConfiguration:
        patches:
          directory: /etc/kubernetes/patches
```

Because a patch modifies the base kubelet configuration file — not a command-line flag — it stays underneath the Part 1 `--config-dir` drop-in in precedence, so the two paths agree. Applying this template does not change existing nodes; it only affects nodes created after the change.

### Keeping the two paths consistent

A common concern is whether re-applying the Machine Configuration drop-in to a node that the provider already configured causes a problem. It does not:

- The two paths write **different files**. The provider sets `maxPods` in the node's base kubelet configuration; Machine Configuration writes a separate drop-in under `/etc/kubernetes/kubelet.conf.d/`. The machine configuration daemon manages only its own two files and never touches the base configuration, so there is no shared-ownership conflict, no drift, and no reboot loop.
- When a newly provisioned node joins and matches the pool, the daemon applies the drop-in as well. This re-asserts the same value and triggers a single kubelet restart on first reconcile — harmless.
- Only the effective-value precedence matters. Keep the value in Part 1 and Part 2 **identical**. If they ever differ, the `--config-dir` drop-in wins over the base configuration file — which is exactly why Part 2 uses a patch and not `kubeletExtraArgs`: `kubeletExtraArgs` becomes a command-line flag, and a flag would instead win over the drop-in and silently shadow it. Set the value through these two declarative paths only; do not edit nodes over SSH.

### Limitations

- **Pod network sizing.** `maxPods` cannot exceed the number of pod IP addresses available per node. With the default per-node pod CIDR (a `/24`, roughly 254 usable addresses), a node cannot usefully run more pods than that regardless of `maxPods`. Before raising `maxPods` toward or beyond that number, check the cluster's per-node pod CIDR size; enlarging it is a cluster-wide networking change that must be planned separately.
- **Interim method.** On ACP 4.1–4.3, Machine Configuration has no dedicated kubelet-configuration resource, so this drop-in approach is the supported path. A future release adds a dedicated resource; once you upgrade, migrate the Part 1 objects to it. The labels and the one-object-per-field layout above are what make that migration mechanical.

## Diagnostic Steps

Read the live, effective kubelet configuration from a node and confirm `maxPods`. This returns the merged value actually in use:

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | jq '.kubeletconfig.maxPods'
```

Check both an existing node (changed by Part 1) and a node added after the Part 2 change; both should report the value you set (`250` in the examples). If an existing node still shows the old value, confirm that the node disruption policy from Step 1 is present in the `cluster` resource's `status.nodeDisruptionPolicyStatus`, and that the kubelet `ExecStart` in the Step 2 switch matches the node's actual service.

---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.x,4.2.x,4.3.x
id: KB260700026
---

# Changing the kubelet maxPods setting on immutable infrastructure nodes

## Issue

You need to change the kubelet `maxPods` setting on immutable-infrastructure worker nodes — for example, to adjust pod density on a cluster provisioned on Huawei Cloud Stack (HCS). On immutable nodes you cannot simply edit a file on the host and expect the change to persist: node files are reconciled by the platform's Machine Configuration component, and an out-of-band edit is treated as configuration drift. The change also has to reach two different node populations:

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

The kubelet reads its configuration from layered sources with a fixed precedence: **command-line flag > `--config-dir` drop-in > `--config` file > built-in default**. Both delivery paths below set `maxPods` as a command-line flag; which one wins where both apply is explained in *Keeping the two paths consistent*.

In the Machine Configuration releases this procedure targets (see *Environment* above), there is no dedicated custom resource for kubelet configuration. The supported interim method is therefore a `MachineConfig` that installs a systemd drop-in for the kubelet, described below.

> This is an advanced, node-level procedure. A mistake in the kubelet service override can leave a node `NotReady`. Apply it to a non-production pool first, and engage Alauda support if you are unsure.

## Resolution

### Part 1 — Change existing nodes with Machine Configuration (no reboot)

`maxPods` is set with a systemd drop-in that passes `--max-pods` to the kubelet through `KUBELET_EXTRA_ARGS`. It takes effect after a kubelet restart—the node is not rebooted and running pods are not evicted. This applies to **all worker nodes, including infrastructure (`infra`) nodes**, which take the same value. Deliver it with two objects, applied in order.

**Prerequisite — confirm the node's kubelet service.** The drop-in below re-declares the kubelet `ExecStart`. Read the actual `ExecStart` from a target node first and reuse it verbatim; the one requirement is that it ends with `$KUBELET_EXTRA_ARGS`, so the value set below is applied:

```bash
systemctl cat kubelet
```

**Step 1 — Node disruption policy.** By default a file change does not restart any service, so a drop-in would be written to disk but not applied. Add a policy that reloads systemd and restarts the kubelet when the drop-in file changes. Edit the existing singleton with **`kubectl edit machineconfiguration cluster`** — do **not** `kubectl apply`, which would overwrite other policies already on the object — and confirm the entry appears in `status.nodeDisruptionPolicyStatus` **before** creating the `MachineConfig` in Step 2:

```yaml
apiVersion: machineconfiguration.alauda.io/v1alpha1
kind: MachineConfiguration
metadata:
  name: cluster            # the singleton in the cpaas-system namespace
spec:
  nodeDisruptionPolicy:
    files:
      - path: /etc/systemd/system/kubelet.service.d/30-maxpods.conf
        actions:
          - type: DaemonReload
          - type: Restart
            restart:
              serviceName: kubelet.service
    sshkey:
      actions:
        - type: None
```

**Step 2 — Set maxPods.** Prepare the systemd drop-in. `ExecStart=` is cleared and re-declared so `$KUBELET_EXTRA_ARGS` is applied last; **replace `250` with your target value, and match the `ExecStart` line to the output of `systemctl cat kubelet` on your nodes**:

```ini
[Service]
Environment="KUBELET_EXTRA_ARGS=--max-pods=250"
ExecStart=
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
```

Base64-encode it:

```bash
base64 -w0 30-maxpods.conf
```

Create the `MachineConfig` (the `contents.source` below is the encoding of the drop-in above). The `role: worker` label applies it to every worker node, `infra` included:

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
        - path: /etc/systemd/system/kubelet.service.d/30-maxpods.conf
          mode: 0o644
          overwrite: true
          contents:
            source: 'data:text/plain;base64,W1NlcnZpY2VdCkVudmlyb25tZW50PSJLVUJFTEVUX0VYVFJBX0FSR1M9LS1tYXgtcG9kcz0yNTAiCkV4ZWNTdGFydD0KRXhlY1N0YXJ0PS91c3IvYmluL2t1YmVsZXQgJEtVQkVMRVRfS1VCRUNPTkZJR19BUkdTICRLVUJFTEVUX0NPTkZJR19BUkdTICRLVUJFTEVUX0tVQkVBRE1fQVJHUyAkS1VCRUxFVF9FWFRSQV9BUkdTCg=='
```

> **Do not enable `--config-dir` against a directory that does not exist.** An earlier version of this procedure pointed the kubelet at `--config-dir=/etc/kubernetes/kubelet.conf.d` and restarted it before that directory existed, which left nodes `NotReady`. The drop-in above avoids `--config-dir` entirely. If you must use it for a setting that has no command-line flag (see *Limitations*), create the directory in the same `MachineConfig`—by writing a file into it—before anything references it.

After the `MachineConfig` is applied, the daemon reloads systemd and restarts the kubelet on each worker node; the new `maxPods` takes effect and the node is not rebooted.

Keep only kubelet settings in this object (not chrony, sysctl, or unrelated files); name the drop-in `NN-<name>.conf` with `NN` in the 10–49 range; and keep the labels shown above. To set additional flag-settable fields, add them to the **same** `KUBELET_EXTRA_ARGS` line, space-separated—do **not** create a second drop-in that also assigns `KUBELET_EXTRA_ARGS` (systemd keeps only the last assignment of a variable)—and list every field in the `kubelet-fields` annotation.

### Part 2 — Make future nodes carry the value (provider template)

New worker (compute) nodes are created from the worker pool's `KubeadmConfigTemplate` (together with its `MachineDeployment` and `HCSMachineTemplate`). Set `maxPods` there so nodes are born with it. Control-plane nodes are configured through a different resource—the `KubeadmControlPlane`—and are out of scope for this workload-node procedure.

For worker nodes, set the value with `joinConfiguration.nodeRegistration.kubeletExtraArgs` in the `KubeadmConfigTemplate`. Add `max-pods` alongside any existing `kubeletExtraArgs` entries (such as `volume-plugin-dir`); do not remove them. Apply the same value to **every** worker pool's template, the `infra` pool included, so all worker nodes match:

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

`kubeletExtraArgs` becomes a kubelet command-line flag (`--max-pods`). Applying this template does not change existing nodes; it only affects worker nodes created after the change. On a node that Machine Configuration also manages, the Part 1 value overrides this one (see *Keeping the two paths consistent*), so set both to the **same** value.

### Keeping the two paths consistent

A common concern is whether re-applying the Machine Configuration drop-in to a new node—one the provider bootstrap already configured—causes a problem. It does not, but be clear about which value wins:

- **No shared file.** Machine Configuration writes its systemd drop-in at `/etc/systemd/system/kubelet.service.d/30-maxpods.conf`. The provider's `kubeletExtraArgs` is rendered by kubeadm into `/var/lib/kubelet/kubeadm-flags.env` (`KUBELET_KUBEADM_ARGS`). The daemon manages only its own drop-in and never touches the kubeadm file, so there is no shared-ownership conflict, no drift, and no reboot loop.
- **Both are command-line flags, and Machine Configuration wins.** The kubelet unit's `ExecStart` ends with `... $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS`. The provider value arrives in `$KUBELET_KUBEADM_ARGS`; the Machine Configuration value arrives in `$KUBELET_EXTRA_ARGS`, which is **last**. When the same flag (`--max-pods`) appears twice, the kubelet uses the last occurrence. So on any node managed by Machine Configuration, the Machine Configuration value takes effect and overrides the provider value.
- **Consequence.** Set both paths to the **same** value. If they differ, the `max-pods` in the `KubeadmConfigTemplate` will have no effect on managed nodes. Set the value only through these two declarative paths; do not edit nodes over SSH.

### Limitations

- **Pod network sizing.** `maxPods` cannot exceed the number of pod IP addresses available per node. With the default per-node pod CIDR (a `/24`, roughly 254 usable addresses), a node cannot usefully run more pods than that regardless of `maxPods`. Before raising `maxPods` toward or beyond that number, check the cluster's per-node pod CIDR size; enlarging it is a cluster-wide networking change that must be planned separately.
- **Only settings that have a command-line flag can use this method.** `--max-pods` has a flag, so it works through `KUBELET_EXTRA_ARGS`. Settings that exist only in `KubeletConfiguration`—for example `systemReserved`, `evictionHard`, or `cpuManagerPolicy`—have no flag and must be delivered through the kubelet `--config-dir` mechanism (a config drop-in directory) instead. If you use `--config-dir`, the directory must be **created first** (by a `MachineConfig` that writes a file into it), before any unit points the kubelet at it—otherwise the kubelet fails to start and the node goes `NotReady`.
- **Interim method, bounded by the Machine Configuration version.** This drop-in approach is the supported path on the current Machine Configuration releases (those prior to the planned **v4.1.x**), which have no dedicated kubelet-configuration resource. The v4.1.x release is **planned but not yet available**; it is intended to add that resource. Once the cluster runs a Machine Configuration release that provides it, migrate the Part 1 objects to it and stop using this method. The labels above are what make that migration mechanical. This boundary is set by the Machine Configuration version, not by the ACP version.

## Diagnostic Steps

Read the live, effective kubelet configuration from a node and confirm `maxPods`. This returns the merged value actually in use:

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | jq '.kubeletconfig.maxPods'
```

Check both an existing node (changed by Part 1) and a node added after the Part 2 change; both should report the value you set (`250` in the examples). If an existing node still shows the old value, confirm that the node disruption policy from Step 1 is present in the `cluster` resource's `status.nodeDisruptionPolicyStatus`, and that the kubelet `ExecStart` in the Step 2 drop-in matches the node's actual service.

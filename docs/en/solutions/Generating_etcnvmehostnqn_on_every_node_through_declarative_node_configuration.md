---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On a fresh bare-metal node the contents of `/etc/nvme/hostnqn` do not match the value produced by `nvme gen-hostnqn`. Because NVMe-oF and several storage initiators identify the host by the NQN string in that file, a stale or empty file prevents the kernel from initialising the NVMe devices on first boot. The fault is per-host: each node needs its own `hostnqn` regenerated, and the regeneration must persist across reboots without an operator logging into every box.

## Root Cause

`/etc/nvme/hostnqn` is shipped empty (or with a placeholder) on the node OS image. The node runs `nvme gen-hostnqn` exactly once during provisioning, but if the install image bundles `nvme-cli` later than the bootstrap script that calls it — or if the script was added long after the image was already minted — the file is never written and the value reported by `nvme gen-hostnqn` does not end up on disk.

The clean fix is to make the regeneration part of the node's declared configuration: a small systemd oneshot unit that runs `nvme gen-hostnqn > /etc/nvme/hostnqn` exactly once, distributed to every target node by the cluster's node-configuration mechanism, and re-applied automatically on any node added later. Once the unit is part of the node spec, the file is guaranteed to be present after every install or reimage.

## Resolution

Express the unit through the cluster's node-configuration CR. The shape below uses the on-cluster Machine Configuration operator to push a per-role unit; adapt the role label (`worker`) to the pool you want to target.

```yaml
apiVersion: node.alauda.io/v1
kind: NodeConfig
metadata:
  name: 99-worker-nvme-hostnqn
  labels:
    node-role.kubernetes.io/worker: ""
spec:
  systemd:
    units:
      - name: nvme-gen-hostnqn.service
        enabled: true
        contents: |
          [Unit]
          Description=Populate /etc/nvme/hostnqn from nvme gen-hostnqn
          ConditionPathExists=!/etc/nvme/hostnqn.populated
          Before=network-online.target

          [Service]
          Type=oneshot
          ExecStart=/usr/bin/sh -c '/usr/sbin/nvme gen-hostnqn > /etc/nvme/hostnqn'
          ExecStartPost=/usr/bin/touch /etc/nvme/hostnqn.populated
          RemainAfterExit=yes

          [Install]
          WantedBy=multi-user.target
```

The `ConditionPathExists=!/etc/nvme/hostnqn.populated` guard combined with the `ExecStartPost` marker keeps the unit idempotent: it runs exactly once per node and skips on subsequent boots, which avoids regenerating the NQN every time the node restarts.

Apply through `kubectl`:

```bash
kubectl apply -f 99-worker-nvme-hostnqn.yaml
```

Watch the rollout — the node-configuration controller drains and reboots one node at a time:

```bash
kubectl get nodepool worker -w
```

Each `worker` node reboots serially, runs the unit once, and the file is populated.

For air-gapped or vSphere-templated environments, bake the same unit into the base node image so freshly provisioned hosts have the file before they join the cluster — the on-cluster CR then becomes a safety net for nodes that escape the template.

## Diagnostic Steps

Check the contents on a target node from a debug pod:

```bash
kubectl debug node/<node> -it --image=busybox -- \
  cat /host/etc/nvme/hostnqn
```

If the value is empty or does not start with the expected `nqn.` prefix, the unit either has not run yet or failed.

Inspect the systemd unit status on the node:

```bash
kubectl debug node/<node> -it --image=busybox -- \
  chroot /host systemctl status nvme-gen-hostnqn.service
```

A successful unit shows `Active: inactive (dead)` with `ConditionPathExists=!/etc/nvme/hostnqn.populated` listed under `Drop-In` and the marker file present. A failed unit will show the exit code from `nvme gen-hostnqn`.

Compare the file value with what the host would generate now — they should match:

```bash
kubectl debug node/<node> -it --image=busybox -- \
  chroot /host /usr/sbin/nvme gen-hostnqn
```

For the related `hostid`, the same pattern works with `dmidecode -s system-uuid` writing into `/etc/nvme/hostid`. Apply through a second `NodeConfig` if the deployment uses NVMe-oF identifiers and not just NQNs.

---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A specific kernel module shipped by the host image needs to stay unloaded on every cluster worker. Common reasons:

- A buggy NIC driver causes the kernel to wedge under load and an alternative driver should be used.
- A storage driver (e.g. `nvme_tcp`) is incompatible with the chosen storage stack and should never auto-load.
- A security audit flagged a module (`pcspkr`, `bluetooth`, exotic filesystems) that the cluster does not need exposed.

The desired effect is what `modprobe.d` blacklisting gives on a normal Linux host: drop a `blacklist <modname>` line into `/etc/modprobe.d/` and reload. The complication is that on a managed cluster, every node's filesystem is reconciled by a node-configuration controller — a hand-edit on a single node is reverted at the next reconcile, and any change has to flow through the controller's CR.

## Resolution

### Option 1 — node configuration via the platform's MachineConfiguration

If the platform exposes an `Alauda Container Platform Machine Configuration` (ACP MC) CR that materialises files onto every node in a chosen pool, declare the modprobe drop-in as an ACP MC `file` entry. The controller renders the spec, distributes it to the matching nodes, and reconciles content on every reconciliation cycle.

Define the file in the CR's `spec.config.storage.files` section, base64-encoding the body so the controller can transport it inline:

```bash
echo 'blacklist examplemod' | base64
# YmxhY2tsaXN0IGV4YW1wbGVtb2QK
```

```yaml
apiVersion: machineconfiguration.alauda.io/v1
kind: MachineConfig
metadata:
  name: 99-worker-blacklist-examplemod
  labels:
    machineconfiguration.alauda.io/role: worker
spec:
  config:
    ignition:
      version: 3.2.0
    storage:
      files:
        - path: /etc/modprobe.d/blacklist_example.conf
          mode: 0644
          overwrite: true
          contents:
            source: data:text/plain;charset=utf-8;base64,YmxhY2tsaXN0IGV4YW1wbGVtb2QK
```

(The exact `apiVersion` and CR shape depend on the platform's ACP MC release; consult the deployed CRD with `kubectl explain machineconfig.spec.config.storage.files` if the field path differs from the example above.)

Apply the manifest:

```bash
kubectl apply -f 99-worker-blacklist-examplemod.yaml
```

The controller queues a node-by-node reconciliation. Each affected node:

1. Materialises the new file under `/etc/modprobe.d/`.
2. Drains the workloads (a controlled cordon + drain).
3. Reboots so the kernel loader picks up the blacklist on the next module-load attempt.
4. Re-adds itself to the schedulable pool when the kubelet reports `Ready`.

Plan the change for a maintenance window — even with PodDisruptionBudgets honoured, the rolling reboot touches every node in the targeted pool. Stagger the change across pools (worker, infra, storage) if downtime needs to be budgeted per role.

### Option 2 — privileged DaemonSet (no reboot)

When a reboot is not acceptable and the platform does not expose a usable MC CR, run a small DaemonSet that drops the modprobe file into `/host/etc/modprobe.d/` and unloads the module if it's already loaded. This is best for a temporary workaround or for clusters whose host images are mutable but unmanaged:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: blacklist-examplemod
  namespace: cpaas-system
spec:
  selector:
    matchLabels:
      app: blacklist-examplemod
  template:
    metadata:
      labels:
        app: blacklist-examplemod
    spec:
      hostPID: true
      tolerations:
        - operator: Exists
      containers:
        - name: writer
          image: registry.example.com/cpaas/busybox:1.36
          securityContext:
            privileged: true
          command:
            - sh
            - -c
            - |
              set -eu
              CONF=/host/etc/modprobe.d/blacklist_example.conf
              echo 'blacklist examplemod' > "$CONF"
              chmod 0644 "$CONF"
              # Unload the module immediately if currently loaded.
              if grep -q '^examplemod ' /host/proc/modules 2>/dev/null; then
                nsenter -t 1 -m -u -i -n -p -- rmmod examplemod || true
              fi
              # Idle so DaemonSet's pod stays Running for `kubectl logs`.
              sleep infinity
          volumeMounts:
            - name: host-etc
              mountPath: /host/etc
            - name: host-proc
              mountPath: /host/proc
              readOnly: true
      volumes:
        - name: host-etc
          hostPath:
            path: /etc
        - name: host-proc
          hostPath:
            path: /proc
```

This DaemonSet works on any node OS that uses `modprobe.d`. It does **not** survive a host-image rebuild — if the platform reconciles `/etc` from a baseline image, the file disappears at the next reboot. Treat it as the bridge between "we need this gone right now" and the proper `MachineConfig` rollout.

### Option 3 — boot-time kernel argument (rd.driver.blacklist)

For drivers that load early in the boot sequence (NIC drivers, storage drivers needed before the cluster controller runs), `modprobe.d` may be too late. Append `modprobe.blacklist=<modname>` and `rd.driver.blacklist=<modname>` to the kernel cmdline. Most node-configuration CRs accept a `kernelArguments` (or analogous) field:

```yaml
apiVersion: machineconfiguration.alauda.io/v1
kind: MachineConfig
metadata:
  name: 99-worker-blacklist-examplemod-kargs
  labels:
    machineconfiguration.alauda.io/role: worker
spec:
  kernelArguments:
    - modprobe.blacklist=examplemod
    - rd.driver.blacklist=examplemod
```

This also forces a reboot; the upside is the module never gets a chance to load even during initramfs.

## Diagnostic Steps

Confirm the file landed on a representative node:

```bash
NODE=worker-1.lab.example.com
kubectl debug node/"$NODE" -- chroot /host \
  cat /etc/modprobe.d/blacklist_example.conf
```

Confirm the module is not currently loaded:

```bash
kubectl debug node/"$NODE" -- chroot /host \
  bash -c 'lsmod | grep -E "^examplemod " || echo "not loaded"'
```

If `lsmod` still shows the module after the rollout, the blacklist file is in place but the module is held by a running consumer (NIC up with that driver, mounted filesystem using it). Identify the holder and stop it before unloading:

```bash
kubectl debug node/"$NODE" -- chroot /host \
  bash -c 'lsmod | awk "/^examplemod /"'
# Module                  Size  Used by
# examplemod             24576  3 dependent_a,dependent_b
```

Either remove the consumers (downcount NIC, unmount filesystem) or accept that a reboot is required.

If the platform's MC controller reports the new manifest as `Degraded`, inspect its status:

```bash
kubectl get machineconfigpool worker -o yaml | yq '.status.conditions'
```

A common failure mode is conflict with another file at the same `/etc/modprobe.d/<file>` path: the controller refuses to merge two MC manifests writing the same target. Either consolidate the two files into one MC, or use distinct filenames (`blacklist_examplemod.conf`, `blacklist_otherthing.conf`).

For the DaemonSet form, follow the writer pod's logs to confirm it ran:

```bash
kubectl -n cpaas-system logs ds/blacklist-examplemod -f
```

Successful runs print one or two lines per node and then idle on `sleep infinity`. Pods that crash-loop usually hit a privilege denial (PodSecurityStandards) — relax the namespace's PSS label or use the platform's official MC path instead.

To confirm the kernel-argument form took effect, inspect `/proc/cmdline` on a representative node:

```bash
kubectl debug node/"$NODE" -- chroot /host cat /proc/cmdline
```

Look for `modprobe.blacklist=examplemod`. Its absence after a reboot means the MC controller has not yet rolled the change to that node — wait for the MachineConfigPool to report `Updated=True` for the target role.

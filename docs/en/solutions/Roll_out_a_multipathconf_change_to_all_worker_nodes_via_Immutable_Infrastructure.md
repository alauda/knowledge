---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A cluster is running on an immutable node OS (the node image is managed by the platform, not by `yum`/`apt`). The storage team needs to:

- push a customised `/etc/multipath.conf` to every worker node so that a SAN back-end is discovered with the right path-grouping / no-path-retry / dev_loss_tmo policy, and
- add a kernel argument (for example `loglevel=7`) so the change can be validated under load.

Editing `/etc/multipath.conf` directly in a shell inside the node is not a durable fix — on an immutable node OS those edits are either reverted on the next reconcile or lost across image upgrades. The change has to go through the node-configuration layer.

Caveat: enabling or reworking multipath as a day-2 operation is known to cause I/O errors on the non-optimised paths of some arrays and can require the node to be reinstalled. Validate in a non-production environment before rolling across production.

## Resolution

The ACP equivalent of the immutable-OS MachineConfig pipeline is the `configure/clusters/nodes` surface, backed by the **Immutable Infrastructure** extension product. The config-generation flow mirrors the upstream: describe the node change in a high-level "butane" YAML, transpile to the low-level node-config CR, apply, wait for the pool to roll.

1. **Author the node-config source (butane-style).**

   This example patches `/etc/multipath.conf` on the worker pool and adds a kernel argument. Save it as `worker-multipath.bu`:

   ```yaml
   variant: alauda
   version: 4.1.0
   metadata:
     name: 99-worker-multipath
     labels:
       machineconfiguration.alauda.io/role: worker
   kernel_arguments:
     - loglevel=7
   storage:
     files:
       - path: /etc/multipath.conf
         mode: 0644
         overwrite: true
         contents:
           inline: |
             defaults {
               user_friendly_names no
               find_multipaths yes
             }
             devices {
               device {
                 vendor "ACME"
                 product "ARRAY"
                 path_grouping_policy "group_by_prio"
                 path_checker           "tur"
                 failback               "immediate"
                 no_path_retry          5
                 rr_weight              uniform
                 rr_min_io_rq           1
                 dev_loss_tmo           120
               }
             }
   ```

   Replace the `vendor`/`product` stanza and the tuning values with what your SAN vendor recommends. Applying the new config **overwrites** the existing `/etc/multipath.conf`, so take a copy of the current content from any worker before continuing:

   ```bash
   kubectl debug node/<worker> -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host cat /etc/multipath.conf > multipath.conf.before
   ```

2. **Transpile to the node-config CR.**

   ```bash
   butane worker-multipath.bu -o worker-multipath.yaml
   ```

   The output is a `MachineConfig`-shaped CR (under the ACP `machineconfiguration.alauda.io` API group) that embeds both the file change and the kernel arguments.

3. **Apply it.**

   ```bash
   kubectl apply -f worker-multipath.yaml
   ```

   The node-config controller renders a new node image for the worker pool and rolls the pool one node at a time, each with a drain and reboot. Monitor the rollout:

   ```bash
   kubectl get mcp worker -o \
     jsonpath='{.status.machineCount}{"/"}{.status.updatedMachineCount}{"\n"}'
   kubectl get nodes -l node-role.kubernetes.io/worker -w
   ```

4. **Back out plan.**

   If the new `multipath.conf` breaks I/O on a node, delete the rendered `MachineConfig` object to revert the pool to the previous render:

   ```bash
   kubectl delete -f worker-multipath.yaml
   ```

   The pool then rolls again, restoring the previous `/etc/multipath.conf` and kernel args. Keep the `multipath.conf.before` snapshot from step 1 as the authoritative fallback.

If you only need to tune a parameter that multipath already manages without rewriting the whole file, consider a minimal butane snippet that drops a small file under `/etc/multipath/conf.d/` instead — that keeps the vendor-shipped defaults intact and lowers the blast radius of a bad edit.

## Diagnostic Steps

Confirm each worker ended up with the expected `/etc/multipath.conf`:

```bash
for node in $(kubectl get nodes -l node-role.kubernetes.io/worker -o name); do
  echo "=== $node ==="
  kubectl debug "$node" -it \
    --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
    -- chroot /host cat /etc/multipath.conf
done
```

Check that the kernel argument landed:

```bash
for node in $(kubectl get nodes -l node-role.kubernetes.io/worker -o name); do
  kubectl debug "$node" -it \
    --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
    -- chroot /host cat /proc/cmdline
done | grep loglevel=7
```

Verify multipath reloaded the config and is showing the expected priority groups:

```bash
kubectl debug node/<worker> -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host multipath -ll
```

If a node is stuck in the update, inspect the node-config controller and MCP status:

```bash
kubectl get mcp
kubectl -n <node-config-namespace> logs deploy/machine-config-controller --tail=200
```

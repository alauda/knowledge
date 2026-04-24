---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Adding a new worker to a cluster that uses Fibre Channel storage stalls during early boot. The console (or the hypervisor's serial log) shows systemd working its way through the boot unit list and then parking on the multipath unit:

```text
Reached target RDMA Hardware.
Finished Wait for udev To Complete Device Initialization.
A start job is running for Enable Multipathing for SCSI over FC (26min 20s / no limit)
```

The job never finishes, the node never appears in the API as `Ready`, and — because the unit has no timeout — the node will sit in this state indefinitely rather than giving up and allowing the rest of boot to complete.

## Root Cause

The node is trying to bring up device-mapper multipath (`multipathd.service` plus the unit that waits for the multipath devices to materialise), and the configuration declared by the cluster-wide node-configuration layer is not compatible with the actual SCSI / FC topology attached to this host. Common variants:

- The `/etc/multipath.conf` the node was rendered with includes a `blacklist_exceptions` / `devices` stanza that does not match the WWIDs the HBA is reporting on this specific host, so the unit waits for "expected" paths that never appear.
- The boot-time ordering has the multipath wait unit before `udev-settle` has actually finished enumerating all FC paths on this HBA model, so `multipathd` starts with a partial view and then keeps waiting for the rest.
- The node-configuration object that declares `/etc/multipath.conf` and the corresponding kernel module/friendly-name policy was authored with a slightly different stanza than the one the storage team validated — easy to drift if two administrators maintain the file and the cluster.

Because the cluster manages node OS configuration through a declarative layer (ACP's node configuration under `configure/clusters/nodes`, or the Immutable Infrastructure extension for deeper OS-image flows), the bad file is baked into every new node the moment it is provisioned — which is why the symptom appears on the *first* boot of any newly-added node and not on a random running node.

## Resolution

Fix the node-configuration object so the rendered `/etc/multipath.conf` matches the validated topology, then allow the stuck node to boot.

1. **Audit the current node-configuration definition** that installs `/etc/multipath.conf` and any related `multipathd` drop-ins. It is held in the cluster's declarative node-config surface (either under `configure/clusters/nodes`, or in an Immutable Infrastructure OS-image definition, depending on which configuration product the cluster uses). Export the currently-active definition so you can diff it against the validated golden:

   ```bash
   kubectl get <node-config-kind> -o yaml > /tmp/current-nodeconfig.yaml
   ```

   Compare with the validated configuration. If you do not have one, take the storage vendor's reference `multipath.conf` for the specific HBA model and array, and the list of WWIDs the array exposes to this cluster, and construct the expected file.

2. **Re-render the node configuration** with the corrected content. Follow the same authoring flow the cluster normally uses for node-level files (keep ownership / mode / path identical — `/etc/multipath.conf`, root-owned, mode 0644, and any drop-in such as `/etc/modules-load.d/dm-multipath.conf`), and re-apply.

3. **Wait for the node-configuration layer to roll out** to existing, already-healthy nodes. Do this *before* retrying the stuck node — that way, once the stuck node eventually comes online, it is receiving the already-converged-good revision rather than a still-propagating one:

   ```bash
   kubectl get nodes -o wide
   # watch the node-config controller's conditions / rolled-out revision
   ```

4. **Unblock the stuck new node.** Power-cycle it through the hypervisor (or PDU for bare metal). On the next boot it will render the corrected `multipath.conf` during ignition / image-assembly, the multipath unit will find the paths it expects, and the job will complete in seconds instead of hanging. The node will reach `Ready` and the cluster will add it to the worker pool.

5. If you need an unblock *before* the node-config layer has rolled out, you can intervene on the single stuck host by dropping into an emergency shell from the console, placing the corrected `/etc/multipath.conf` by hand, and resuming boot. This is a one-shot workaround — the next time the node is re-provisioned it will again render whatever the node-configuration layer says, so the durable fix still has to happen in step 1.

## Diagnostic Steps

Before changing the node-configuration layer, isolate the failure to multipath and not something upstream (HBA firmware, zoning, or LUN masking):

1. **Confirm the node is hung on the multipath unit specifically.** From the console / serial log during the hang:

   ```text
   # on the stuck node
   systemctl status multipathd.service
   systemctl list-jobs
   journalctl -b -u multipathd --no-pager
   ```

2. **Check which paths the kernel actually sees**, versus what multipath is expecting. On a healthy peer with the same HBA model, collect a reference:

   ```bash
   # on a healthy node, for reference
   kubectl debug node/<healthy-node> -- chroot /host sh -c \
     'ls /sys/class/fc_host/ && multipath -ll'
   ```

   Then on the stuck node (from the emergency shell), run the same commands and diff. A short path list on the stuck node (`/sys/class/fc_host/*` missing, or only showing one port of a supposed dual-fabric) points at zoning / HBA rather than multipath configuration.

3. **Inspect the declared configuration.** Compare the node-configuration object that renders `/etc/multipath.conf` against the vendor-validated stanza. A single-character drift in a `devnode` regex or `wwid` filter is enough to stall the whole unit.

4. **Once boot has completed**, verify the node now has the expected number of paths per LUN and that device-mapper has consolidated them into the right `mpath` devices:

   ```bash
   kubectl debug node/<worker> -- chroot /host sh -c 'multipath -ll'
   ```

5. **Keep the fix durable.** Add a smoke check to cluster add-node runbooks: boot a single new worker with the node-configuration change, validate multipath converges within a small time budget (a minute or two for a correctly-configured node), and only then scale the worker pool out further. Catching the drift on one node is cheap; catching it after every new worker has inherited the bad file is expensive.

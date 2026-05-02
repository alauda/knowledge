---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM migration from VMware fails with Deprecated XFS V4 format when running virt-v2v
## Issue

When migrating a VM from VMware into ACP Virtualization, the virt-v2v conversion step aborts during guest inspection. The guest is an older Linux system whose root filesystem is XFS formatted in the deprecated V4 on-disk layout. The conversion log shows:

```text
command: mount '-o' 'ro' '/dev/<vg>/root' '/sysroot/'
[ ... ] SGI XFS with ACLs, security attributes, scrub, quota, no debug enabled
[ ... ] XFS (dm-0): Deprecated V4 format (crc=0) not supported by kernel.
command: mount returned 32
command: mount: stderr: mount: /sysroot: wrong fs type, bad option, bad
superblock on /dev/mapper/<vg>-root, missing codepage or helper program,
or other error. dmesg(1) may have more information after failed mount
system call.
ocaml_exn: 'mount_ro' raised 'Failure' exception
libguestfs: trace: v2v: mount_ro = -1 (error)
```

The migration plan fails on that VM and never produces a converted disk. Other VMs in the same plan — those using XFS V5 or ext4 — convert normally.

## Root Cause

Modern kernels used by the conversion image no longer mount XFS V4 (`crc=0`) as read-write, and recent builds have dropped read-only support as well. virt-v2v relies on libguestfs to mount the guest root filesystem read-only during inspection; when the kernel inside the conversion container refuses to mount an XFS V4 volume, the whole conversion aborts.

XFS V4 is the on-disk layout that older enterprise Linux distributions (roughly the early 2010s generation — minor releases from around 2013-2014 and earlier) installed by default before the XFS V5 format with checksums became standard. Any guest that was installed from one of those early media and has not since had its root filesystem recreated is still on V4.

## Resolution

The virt-v2v conversion needs to run against an image that still supports XFS V4. The migration tooling in ACP Virtualization (based on Forklift) exposes this through a per-plan setting.

Preferred path on ACP — set `spec.xfsCompatibility: true` on the `Plan` custom resource so that Forklift runs virt-v2v inside the XFS-compatible conversion image instead of the default one:

```yaml
apiVersion: forklift.konveyor.io/v1beta1
kind: Plan
metadata:
  name: <plan-name>
  namespace: <migration-namespace>
spec:
  xfsCompatibility: true
  # ... rest of the plan (provider, vms, targetNamespace, etc.)
```

Apply and re-run the plan for the affected VMs:

```bash
kubectl -n <migration-namespace> apply -f plan.yaml
kubectl -n <migration-namespace> patch migration <migration-name> \
  --type=merge -p '{"spec":{"cutover":null}}'   # or start a new Migration CR
```

Forklift will schedule the conversion pods using a kernel / userspace stack that still honours the deprecated V4 layout, the libguestfs mount succeeds, and virt-v2v proceeds to convert the disk.

**Caveat.** The compatibility image tolerates XFS V4 at the cost of **disabling BTRFS support** in the same plan. Do not enable `xfsCompatibility` for a plan that mixes XFS V4 guests with BTRFS guests — split them into two plans. A safe pattern is: one plan with `xfsCompatibility: true` for the legacy XFS guests, another plan with the default settings for everything else.

**Long-term mitigation.** XFS V4 has been deprecated by upstream for multiple releases and the in-place upgrade of a live volume is not supported. Once the VM has been migrated onto ACP Virtualization, plan a one-time rebuild of the root filesystem to XFS V5 (or ext4). The usual path is to add a new disk, `xfs_repair -v` the source, create a V5 target with `mkfs.xfs` (V5 is the default on current tooling), copy the data, and swap the disks. Doing the rebuild *after* migration keeps the conversion compatibility setting scoped to a one-off plan.

If using an upstream Forklift install without the ACP Virtualization packaging, the same `xfsCompatibility` field is available on the Plan CRD — the underlying image selection is driven by the same controller.

## Diagnostic Steps

1. Identify which VM in the plan is failing and inspect the per-VM virt-v2v log to confirm the XFS V4 signature. Forklift writes the conversion pod logs under the migration namespace:

   ```bash
   kubectl -n <migration-namespace> get pod -l vmID=<vm-id>
   kubectl -n <migration-namespace> logs <virt-v2v-pod> -c virt-v2v | \
     grep -E 'XFS|V4|mount_ro'
   ```

   The combination of `XFS (dm-*): Deprecated V4 format (crc=0) not supported by kernel` and `mount_ro = -1 (error)` confirms the diagnosis.

2. From a machine with read access to the source VMDK (for example, a temporary debug pod with `libguestfs-tools`), probe the root volume's XFS version directly:

   ```bash
   xfs_info /dev/<vg>/root 2>/dev/null | grep -E 'crc|version'
   ```

   Output of `crc=0` (V4) matches the incompatible case. `crc=1` (V5) should not trigger this error — if it does, the issue is elsewhere.

3. After setting `xfsCompatibility: true`, confirm the plan picks up the compatible conversion image. The conversion pod spec should reference an image tagged for XFS-compatible conversion; a quick check is:

   ```bash
   kubectl -n <migration-namespace> get pod -l vmID=<vm-id> \
     -o jsonpath='{.items[*].spec.containers[*].image}' | tr ' ' '\n'
   ```

   Re-run the plan. The conversion should now complete and libguestfs no longer logs `mount_ro = -1`.

4. Keep `xfsCompatibility: true` plans **separate** from plans that contain BTRFS guests. If a mixed plan is inadvertently flipped, BTRFS guests in the same plan will start failing with their own filesystem-detect errors — split them and retry.

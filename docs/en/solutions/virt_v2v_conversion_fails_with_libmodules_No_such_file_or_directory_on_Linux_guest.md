---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# virt-v2v conversion fails with "/lib/modules: No such file or directory" on Linux guest
## Issue

Migration of a Linux guest from VMware into the cluster's virtualization stack — using the VM-import / Forklift workflow that delegates conversion to `virt-v2v` — fails during the inspection / conversion phase. The conversion pod logs end with libguestfs reporting the kernel modules tree cannot be found:

```text
libguestfs: trace: v2v: find "/lib/modules/<kver>"
guestfsd:  error: /lib/modules/<kver>: No such file or directory
libguestfs: trace: v2v: find = NULL (error)
virt-v2v: error: libguestfs error: find0:
   /lib/modules/<kver>: No such file or directory
```

A directory listing of `/boot` from the same trace shows the kernel image, the matching `initramfs`, and the `System.map` — so the kernel itself is installed and intact. Only the `/lib/modules/<kver>` path lookup fails.

## Root Cause

Modern Linux distributions ship `/lib` as a symlink into `/usr/lib` (a `usr-merge` layout). The symlink is supposed to be **relative**:

```text
/lib -> usr/lib
```

The guest in question has it as an **absolute** symlink:

```text
/lib -> /usr/lib
```

The two look equivalent from inside a running system, but `virt-v2v` does not run inside the guest — it inspects the guest's root filesystem from the outside through libguestfs. libguestfs follows symlinks against the guest filesystem's root, not the host's. When it follows an *absolute* symlink, the leading `/` resolves to the host (`virt-v2v`'s own root), where `/usr/lib/modules/<kver>` does not exist. The `find` then returns "no such file" and the conversion aborts.

A relative `usr/lib` symlink is interpreted relative to the symlink's directory inside the guest, which lands correctly on the guest's `/usr/lib` and the modules tree is found.

This is a quirk of how the conversion tool walks symlinks during inspection, not a kernel module problem. The kernel modules are present; libguestfs simply cannot reach them through the absolute symlink.

## Resolution

The fix is on the **source** guest, before re-running the migration: replace the absolute `/lib` symlink with a relative one. Boot the source VM (still on its original hypervisor) and run, as root:

```bash
cd /
ls -l lib                 # confirm: /lib -> /usr/lib  (absolute)
rm /lib
ln -s usr/lib /lib
readlink /lib             # expected: usr/lib  (relative)
```

The change is backwards-compatible — every read of `/lib/...` continues to resolve to `/usr/lib/...` on the running system — and survives reboot.

After the symlink is corrected, re-run the migration. virt-v2v will follow the relative symlink correctly during inspection, find `/lib/modules/<kver>`, and continue the conversion to completion.

### Hardening for future migrations

If a fleet of guests was provisioned from a template that contained the absolute symlink, fix the template once and re-base. For long-running guests where touching the running system is sensitive, the equivalent fix from rescue media works the same way: chroot into the guest's root, replace the symlink, exit. There is no need to touch `/usr/lib/modules` itself.

If the guest's `/usr-merge` was performed by a manual script in the past, it is worth auditing all of the top-level compatibility symlinks (`/bin`, `/sbin`, `/lib64`) for the same absolute-vs-relative mistake — the conversion will fail again on the next one libguestfs encounters.

## Diagnostic Steps

1. Inspect the conversion pod logs and confirm the failing path is `/lib/modules/<kver>`. Other libguestfs failures (missing initramfs, wrong root partition, encrypted disk without key) look superficially similar but list different paths:

   ```bash
   kubectl logs -n <virt-namespace> <conversion-pod> -c <converter-container> \
     | grep -E 'libguestfs error|virt-v2v: error|/lib/'
   ```

2. From the source VM (or its rescue media), check the symlink:

   ```bash
   readlink /lib
   readlink /lib64 || true
   readlink /bin   || true
   readlink /sbin  || true
   ```

   Any output that begins with a leading `/` is an absolute symlink and is a candidate for the same failure.

3. Confirm the kernel modules are actually present in the guest, ruling out a real missing-modules problem (rare but possible on rebuilt guests):

   ```bash
   ls -ld /usr/lib/modules/$(uname -r)
   ```

   If the directory exists, the conversion failure is purely the symlink case described here. If the directory genuinely does not exist, that is a separate problem (broken kernel package install) and the symlink fix will not help.

4. After fixing the symlink and re-running the migration, watch the conversion pod for the next libguestfs `find` against `/lib/modules` — it should succeed and the run should progress to the disk-conversion phase:

   ```bash
   kubectl logs -n <virt-namespace> <new-conversion-pod> -f \
     | grep -E '/lib/modules|copying|inspecting'
   ```

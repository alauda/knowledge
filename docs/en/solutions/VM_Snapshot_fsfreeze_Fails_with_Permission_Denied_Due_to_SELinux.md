---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Taking a consistent snapshot of a running VirtualMachine fails. The `VirtualMachineSnapshot` object surfaces a freeze error that looks like:

```text
Internal error occurred: unexpected return code 400 (400 Bad Request),
  message: server error. command Freeze failed:
  "LibvirtError(Code=1, Domain=10,
    Message='internal error: unable to execute QEMU agent command
    'guest-fsfreeze-freeze': failed to open /mount_point: Permission denied')"
```

The VM is otherwise running normally and the qemu-guest-agent process is alive. Snapshots without the freeze step complete, but at the cost of in-flight writes not being quiesced on disk.

## Root Cause

`guest-fsfreeze-freeze` runs **inside** the guest OS under the qemu-guest-agent binary, which is confined by SELinux inside the VM (label `virt_qemu_ga_t`). It is not the hypervisor or the cluster that denies the open — it is the guest's own SELinux policy.

SELinux grants `virt_qemu_ga_t` access to files tagged as "non-security file types": common data paths like `default_t`, `var_t`, etc. If a filesystem was mounted onto a directory that never had a label applied — the typical case is a freshly-formatted block device mounted into a subdirectory created ad-hoc — the mountpoint carries the label `unlabeled_t`. `virt_qemu_ga_t` has no rule permitting access to `unlabeled_t`, so the freeze request is refused with `Permission denied`, the VMSnapshot marks the freeze step failed, and the `virt-controller` logs a 400 back from libvirt.

A similar failure appears if a directory is relabelled to a security-sensitive type (e.g. `kdump_crash_t`, `shadow_t`) that is not part of the guest-agent allowlist.

## Resolution

Fix the SELinux context **inside the guest**. Host-side or cluster-side changes will not help — the denial is in the guest's policy layer.

Option A and option B below represent two ends of the trade-off: A is the broad, low-ceremony fix that covers most environments; B is surgical and leaves the default policy intact.

### Option A — Relax the SELinux Boolean (recommended for general use)

Inside the VM, relabel the affected path so it is no longer `unlabeled_t`, then allow `qemu-ga` to read non-security file types:

```bash
# relabel the mount point (and its contents) to the default type
sudo restorecon -Rv /mount_point

# persistent boolean: allow qemu-ga to read any non-security-labelled file
sudo setsebool -P virt_qemu_ga_read_nonsecurity_files 1
```

This is persistent across reboots. Any future filesystem mounted into a default-labelled directory will freeze correctly without re-tuning SELinux each time.

### Option B — Write a Targeted Policy Module

If the environment disallows setting the boolean (stricter policy, compliance requirements), write a module that grants exactly the access the agent needs. The example below covers `/var/crash` (`kdump_crash_t`):

```bash
# reproduce the failure once to get a fresh AVC in the audit log
sudo grep AVC /var/log/audit/audit.log | grep qemu | audit2allow -M qemu-ga-crash
sudo cat qemu-ga-crash.te
# module qemu-ga-crash 1.0;
# require { type virt_qemu_ga_t; type kdump_crash_t; class dir { ioctl open read }; }
# allow virt_qemu_ga_t kdump_crash_t:dir { open read ioctl };

sudo semodule -i qemu-ga-crash.pp
sudo restorecon -Rv /var/crash   # only if the path is also mislabeled
```

Repeat for every path the agent must freeze. Keep the modules under version control and ship them via your usual VM image build pipeline so new VMs get them automatically.

### Verification

Trigger another snapshot and watch the freeze step complete:

```bash
cat <<EOF | kubectl apply -f -
apiVersion: snapshot.kubevirt.io/v1alpha1
kind: VirtualMachineSnapshot
metadata:
  name: <vm-name>-$(date +%s)
  namespace: <ns>
spec:
  source:
    apiGroup: kubevirt.io
    kind: VirtualMachine
    name: <vm-name>
EOF

kubectl -n <ns> get virtualmachinesnapshot <snapshot-name> -w
```

A healthy snapshot progresses from `Preparing` → `InProgress` → `Succeeded` without a Freeze error in the `indications` or the `virt-controller` log.

## Diagnostic Steps

In the guest, confirm the label of the offending mount:

```bash
ls -lZd /mount_point
# drwxr-xr-x. 2 root root system_u:object_r:unlabeled_t:s0  6 Aug 25 07:54 /mount_point
```

Correlate with SELinux denials:

```bash
sudo ausearch -m AVC -ts recent -c qemu-ga
# or
sudo journalctl -b | grep -i 'SELinux is preventing /usr/bin/qemu-ga'
```

On the cluster side, confirm the failure maps to a freeze call and not a different issue (transport, storage):

```bash
kubectl -n <ns> describe virtualmachinesnapshot <snapshot>
kubectl -n <vm-ns-handler> logs -l kubevirt.io=virt-controller | grep -i freeze
kubectl -n <vm-ns-handler> logs -l kubevirt.io=virt-handler    | grep -i 'Failed to freeze'
```

If the guest logs no AVC for `qemu-ga` but the freeze still fails, investigate the guest agent's health separately (`systemctl status qemu-guest-agent`, channel socket permissions under `/dev/virtio-ports/`); those belong to a different failure mode.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# virtctl memory-dump fails with "No space left on device"

## Issue

`virtctl memory-dump <vm> --create-claim` against a running VirtualMachine on Alauda Container Platform Virtualization (KubeVirt) returns with a failure, and the VMI surfaces an event whose payload starts with `Memory dump to pvc <name> failed: Domain memory dump failed: virError(Code=9, ...) ... Unable to write /var/run/kubevirt/hotplug-disks/<pvc>/<...>.memory.dump: No space left on device`. The dump never completes; the PVC that the `--create-claim` flag auto-provisioned has been filled to capacity by the in-progress dump and libvirt's `libvirt_iohelper` aborts the write with `ENOSPC`.

## Root Cause

`virtctl memory-dump --create-claim` records its target on `VirtualMachine.status.memoryDumpRequest`, whose CRD shape on this platform is `{claimName, phase, fileName, message, remove, startTimestamp, endTimestamp}`; `claimName` is the auto-created PVC and `message` carries the failure text quoted above. The PVC is hot-plugged into the VMI and its progress is mirrored on `VirtualMachineInstance.status.volumeStatus[].memoryDumpVolume{claimName, targetFileName, startTimestamp, endTimestamp}` — `targetFileName` is the `.memory.dump` path that the `ENOSPC` event names.

The auto-created PVC is sized off the guest's declared memory. KubeVirt reads that from `VirtualMachine.spec.template.spec.domain.memory.guest`, which itself defaults to `spec.template.spec.domain.resources.requests.memory` when not set explicitly. When the VirtualMachine spec carries neither — i.e. the guest's memory size is not declared — the controller falls back to a value that does not bound the actual RAM the libvirt domain will dump, so the PVC is provisioned smaller than the dump payload and the first write past the PVC's filesystem-usable size hits `ENOSPC`.

A second factor reduces the usable size below what the PVC requests. When the dump PVC is provisioned with `volumeMode: Filesystem` (the default for `topolvm-hdd` and other Filesystem-capable StorageClasses), CDI reserves a fraction of the requested capacity as filesystem overhead. That fraction is `CDI.spec.config.filesystemOverhead` (effective values surfaced on `CDIConfig.status.filesystemOverhead`), defined as a value between 0 and 1; the CDI CRD documents the default as `0.06` (6%) when unset, and on this platform the effective value on the default StorageClass is `0.06`. A PVC asking for exactly the guest memory size therefore has only `requested * (1 - overhead)` available to libvirt, which is short of the dump file by the overhead margin plus the libvirt header bytes.

## Resolution

Do not rely on `--create-claim`. Pre-create the memory-dump PVC at a size that accounts for both the guest memory and the filesystem-overhead reservation, then pass its name to `virtctl memory-dump` so the auto-sizing path is bypassed entirely.

Size the PVC by the following formula. `MEMORY` is the value declared in `spec.template.spec.domain.memory.guest` (or `spec.template.spec.domain.resources.requests.memory` if `memory.guest` is unset); `OVERHEAD` is the effective `CDIConfig.status.filesystemOverhead` for the StorageClass the dump PVC will land on:

```text
PVC size = (MEMORY + 100 MiB) * (1 + OVERHEAD)
```

On a cluster whose CDI `filesystemOverhead` is the default `0.06` (6%), an 8 GiB guest needs:

```text
PVC size = (8 GiB + 100 MiB) * (1 + 0.06)
        = 8.1 GiB * 1.06
        ≈ 8.586 GiB   → round up to 8.6 GiB
```

If the cluster has been customised with a non-default `filesystemOverhead` per-StorageClass — or if the dump PVC will be `volumeMode: Block`, in which case no overhead is reserved — substitute the corresponding value (or `0`) into the same formula.

Create the PVC explicitly, then trigger the dump against it. Replace `<dump-sc>` with the StorageClass to provision against, `<ns>` with the VM's namespace, and `<vm>` with the VirtualMachine name:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vm-memdump
  namespace: <ns>
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: <dump-sc>
  volumeMode: Filesystem
  resources:
    requests:
      storage: 8600Mi   # adjust per the formula above
```

Apply the manifest and then trigger the dump with `--claim-name` instead of `--create-claim` so the controller routes to the pre-created PVC:

```bash
kubectl apply -f vm-memdump-pvc.yaml
virtctl memory-dump <vm> -n <ns> --claim-name vm-memdump
```

`--claim-name` populates `VirtualMachine.status.memoryDumpRequest.claimName` with the pre-existing PVC; the auto-sizing path that `--create-claim` would take is not invoked, so the PVC capacity is whatever the manifest above declared.

While addressing the immediate dump, also fix the underlying VirtualMachine if it was missing a guest-memory declaration: set `spec.template.spec.domain.memory.guest` (or at minimum `spec.template.spec.domain.resources.requests.memory`) so that any future `--create-claim` invocation has a defined RAM size to base auto-sizing on.

## Diagnostic Steps

Confirm that the failure is the `ENOSPC` path described here rather than an unrelated dump error. Inspect the failure message on the VirtualMachine and the corresponding VMI volume status:

```bash
# Failure text written by the controller after libvirt reports the dump error
kubectl get vm <vm> -n <ns> \
  -o jsonpath='{.status.memoryDumpRequest.message}{"\n"}'

# Per-VMI view of the hot-plugged dump volume and its target file name
kubectl get vmi <vm> -n <ns> \
  -o jsonpath='{range .status.volumeStatus[?(@.memoryDumpVolume)]}{.name}{"\t"}{.memoryDumpVolume.targetFileName}{"\n"}{end}'
```

The message should match the article's signature — `Domain memory dump failed: virError(...) ... Unable to write ...memory.dump: No space left on device`. If the message is different (for example, an `AttachHotplugVolume` failure, a CDI populator failure, or a `permission denied`), this article does not apply.

Check whether the VirtualMachine actually declares guest memory, because that determines whether `--create-claim` will pick a sensible auto-size on the next attempt:

```bash
kubectl get vm <vm> -n <ns> -o jsonpath='\
guest:    {.spec.template.spec.domain.memory.guest}{"\n"}\
requests: {.spec.template.spec.domain.resources.requests.memory}{"\n"}'
```

If both fields are empty, the VM has no declared RAM size and `--create-claim`'s sizing fallback is the root cause; correct the spec before re-running the dump.

Capture the effective filesystem-overhead value the dump PVC will be subject to. This is the constant that goes into the `(1 + OVERHEAD)` term of the sizing formula and is not necessarily `0.07`; the upstream CDI default is `0.06`, and the effective value can be overridden per-StorageClass:

```bash
# Effective values per StorageClass, plus the global default
kubectl get cdiconfig config \
  -o jsonpath='{.status.filesystemOverhead}{"\n"}'

# CRD-level default (documents "if not defined it is 0.06 (6% overhead)")
kubectl explain cdi.spec.config.filesystemOverhead | sed -n '1,20p'
```

Sample output on a cluster using the default overhead with a `topolvm-hdd` StorageClass:

```text
{"global":"0.06","storageClass":{"topolvm-hdd":"0.06"}}
```

If the dump PVC was provisioned `volumeMode: Block` rather than `Filesystem`, no overhead is reserved and the sizing formula reduces to `MEMORY + 100 MiB`. Inspect the StorageClass's effective volume mode via the StorageProfile to know which case applies:

```bash
kubectl get storageprofile <dump-sc> \
  -o jsonpath='{.status.claimPropertySets}{"\n"}'
```

A `claimPropertySets` entry of `{"accessModes":["ReadWriteOnce"],"volumeMode":"Filesystem"}` confirms the dump PVC takes the overhead path; an entry of `"volumeMode":"Block"` confirms it does not.

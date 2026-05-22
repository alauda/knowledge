---
kind:
   - How To
products:
  - Alauda Application Services
ProductsVersion:
   - 4.0,4.1,4.2,4.3
id: KB260515001
---

# Troubleshooting MySQL Initialization Failure Caused by Exhausted Async I/O Slots

## Issue

A MySQL Pod (single-instance, PXC, or MGR) fails to initialize and the container log shows `io_setup() failed`. Inspecting the host shows that `/proc/sys/fs/aio-nr` is at or close to `/proc/sys/fs/aio-max-nr`, meaning the kernel's pool of async I/O contexts is exhausted and MySQL cannot register the AIO contexts it needs to open InnoDB tablespaces.

This typically appears on hosts that already serve many AIO-heavy workloads (multiple NFS or distributed-storage mounts, other database containers, virtualized I/O paths), where the default `fs.aio-max-nr = 65536` is no longer sufficient.

## Environment

- Alauda Application Services for MySQL on ACP (any topology: standalone MySQL, MySQL-PXC, MySQL-MGR)
- Linux kernel with libaio (any supported distribution)
- Host has reached or is close to the kernel default `fs.aio-max-nr = 65536`

## Resolution

### 1. Confirm the symptom

On the node hosting the failing Pod, check the current AIO usage:

```bash
cat /proc/sys/fs/aio-nr
cat /proc/sys/fs/aio-max-nr
```

If `aio-nr` is at or near `aio-max-nr`, the host has run out of AIO contexts and any new MySQL container scheduled on it will fail with `io_setup() failed`.

### 2. Raise `fs.aio-max-nr` temporarily

This unblocks initialization without rebooting the node:

```bash
echo 1048576 > /proc/sys/fs/aio-max-nr
cat /proc/sys/fs/aio-max-nr
```

After the value is raised, delete the failing MySQL Pod so the operator schedules a fresh one; initialization should now succeed.

### 3. Persist the change across reboots

Add the setting to `/etc/sysctl.conf` (or a drop-in under `/etc/sysctl.d/`):

```bash
echo 'fs.aio-max-nr = 1048576' >> /etc/sysctl.conf
sysctl -p
cat /proc/sys/fs/aio-max-nr
```

Apply this on every node that may host a MySQL Pod — if scheduling moves the Pod onto a node where the value is still the default, the failure recurs.

### 4. Choose an appropriate value

`fs.aio-max-nr` caps the number of outstanding async I/O requests the kernel will accept system-wide. The default `65536` is sized for a light desktop workload, not a database host.

| Host profile | Suggested value |
| --- | --- |
| Dedicated database host with fast storage (NVMe/flash) | `1048576` or higher |
| General-purpose Kubernetes node also running databases | `262144` |
| Hosts with multiple NFS / distributed-storage mounts | `1048576` (each backend consumes contexts) |

Notes:

- Each AIO context costs a small amount of kernel memory; on nodes with less than 16 GB of RAM, prefer the lower value to avoid wasting memory.
- High-performance storage benefits most from the larger value — without it, the storage layer will be unable to drive enough concurrent requests to saturate the device.

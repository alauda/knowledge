---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Capturing a .NET memory dump from a hardened pod via kubectl debug — TMPDIR through /proc/1/root
## Issue

A hardened, self-contained .NET application runs in a pod with the strictest mainstream security context: `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, all Linux capabilities dropped (`drop: ["ALL"]`). Capturing a memory dump for a production memory-leak investigation hits a dead end:

- An ephemeral debug container attached with `kubectl debug --target=<container> --share-processes` can see the .NET process — but `dotnet-dump` cannot connect to it.
- The dump tool fails with "Permission denied" or with a Unix-domain-socket connection error, despite running in the same PID namespace as the target.
- Modifying the production pod's security context (granting `SYS_PTRACE`, opening up the root filesystem, running as root) is not an option — the workload's compliance baseline rules it out.

## Root Cause

`kubectl debug --target=<container> --share-processes` joins the ephemeral container into the **PID namespace** of the target container. It does not join the **mount namespace** — by design — because reusing the target's mount layout would defeat the isolation that ephemeral containers are meant to preserve.

`dotnet-dump` connects to the running .NET process through a Unix Domain Socket placed under `$TMPDIR` (defaults to `/tmp`). The socket is created by the .NET runtime in the *target* container's `/tmp`, which is in the target's mount namespace. The ephemeral container's `/tmp` is a different filesystem (its own, ephemeral, writable scratch directory). When `dotnet-dump` looks for the socket it looks in the wrong `/tmp`, and the connect fails — there is no socket there to find.

The classic workaround paths (writing the socket somewhere else; ptrace-attach) all require either modifying the target's security context or sharing the mount namespace. Neither is available on a hardened pod.

What works is to point `dotnet-dump` at the target's `/tmp` through the kernel's `/proc` view: a process can read and write any other process's mounts via `/proc/<pid>/root/<path>`. PID 1 inside the shared PID namespace is the .NET process; `/proc/1/root/tmp` is the target's `/tmp`. Setting `TMPDIR=/proc/1/root/tmp` on the dump command makes `dotnet-dump` look for and create the diagnostic socket under that path — which is the same path the .NET runtime is already serving on.

## Resolution

The pod must already have a writable `Volume` mounted somewhere (a `PersistentVolumeClaim` or `emptyDir` shared with the target), because `readOnlyRootFilesystem: true` means the dump output cannot land on the target's root. The dump tool itself runs in the ephemeral debug container, but its output file has to live on the writable shared volume so `kubectl cp` can pull it out.

### 1. Attach an ephemeral container that shares PID namespace

```bash
kubectl debug -it <pod-name> -n <ns> \
  --image=<utility-image-with-dotnet-tools> \
  --target=<app-container-name> \
  --share-processes \
  -- /bin/bash
```

`--share-processes` is what makes PID 1 inside the debug container map to the .NET process; without it, `/proc/1/root` would point at the ephemeral container's own `/`.

### 2. Run dotnet-dump with TMPDIR routed through /proc/1/root/tmp

Inside the debug container's shell:

```bash
TMPDIR=/proc/1/root/tmp \
  /tools/dotnet-dump collect \
    --process-id 1 \
    --output /shared/dump-$(date +%s).dmp
```

- `--process-id 1` is the .NET app (PID 1 in the shared PID namespace).
- `--output /shared/...` writes the dump to a writable PVC mounted into both containers — the file has to land somewhere outside the target's read-only root.

The runtime accepts the diagnostic-port connection (because the socket path now resolves to the target's actual `/tmp`), the dump streams out, and the resulting file lands on the shared volume.

### 3. Pull the dump file out

```bash
kubectl cp <ns>/<pod-name>:shared/dump-<ts>.dmp ./dump-<ts>.dmp \
  -c <app-container-name>
```

Once the file is local, analyse with `dotnet-dump analyze`, `dotnet-sos`, or any tool that accepts a Linux core file produced by the .NET runtime.

## Diagnostic Steps

1. Confirm the pod's security context is what you think it is — the workaround is only necessary when both `readOnlyRootFilesystem: true` and dropped capabilities are in play:

   ```bash
   kubectl get pod <pod-name> -n <ns> \
     -o jsonpath='{.spec.containers[?(@.name=="<app>")].securityContext}' | jq
   ```

2. Confirm the ephemeral container can in fact see the .NET process:

   ```bash
   # inside the debug shell
   ps auxf | head
   ls -la /proc/1
   ```

   PID 1 named `dotnet` (or your app's binary name) is the success signal.

3. Confirm what fails *without* the TMPDIR override — useful to capture as the negative result:

   ```bash
   /tools/dotnet-dump collect --process-id 1 --output /shared/test.dmp
   # expect: socket connection error / "Permission denied" / IPC timeout
   ```

4. Confirm the socket exists under the target's `/tmp` view through `/proc`:

   ```bash
   ls -la /proc/1/root/tmp/dotnet-diagnostic-* 2>/dev/null
   ```

   A socket file named `dotnet-diagnostic-<pid>-<something>` confirms the runtime's diagnostic port is open and the dump command is going to find it once `TMPDIR` is rerouted.

5. If the debug command fails with `localhost:8080: connection refused` before you even reach the dump step, the host environment used `sudo -i` and lost `KUBECONFIG`. Use `sudo -E` instead or pass `--kubeconfig` explicitly — this is unrelated to the dump path but a common derail when running the workflow on hardened bastion hosts.

---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
  - "4.4"
---

# Web terminal, exec window, debug container, or console file transfer fails on ACP

## Issue

The console opens, but entering a Pod or a node from it does not work. Typical reports:

- After an upgrade, users who could enter a Pod before cannot. If the **EXEC** entry is missing altogether, enable the `cpc-exec` feature gate as described in [EXEC and Debug entries missing from Pod and application pages until the cpc-exec feature gate is enabled on ACP](EXEC_and_Debug_entries_missing_from_Pod_and_application_pages_until_the_cpc-exec_feature_gate_is_enabled_on_ACP.md).
- The exec pop-up window opens as a blank white page.
- The terminal does not open, or **Reconnect** does nothing.
- After an upgrade the per-cluster CLI entry is gone.
- A debug container never finishes initializing.
- **File Transfer** is greyed out with a message that `tar` is missing, although `tar` is in the container.
- `nsenter` Pods in `Error` are found on every cluster during an inspection.
- Exec sessions drop often.
- `kubectl get ns` works on a master node but fails on worker nodes and in the Web CLI with `connection refused` on `localhost:8080`.

The `web-terminal` Pods in `cpaas-system` serve the terminal sessions.

## Root Cause

### Cause 1: the platform is opened over HTTP and the exec window stays blank

Running exec from the container page opens a pop-up window that stays blank white while the platform is accessed over `http://`. The blank window is attributed to the concurrency limit of HTTP access; opening the platform over HTTPS fixes it. (Browsers limit the number of HTTP/1.1 connections per host, while HTTP/2 over HTTPS multiplexes requests over one connection.)

### Cause 2: the terminal access token expired

The `web-terminal` log repeats `invalid access token: authentication head is invalid` and `failed open terminal for user` with an empty user, for the `global` cluster and for business clusters, while the Pod is running and its initial request to the API server succeeded. The terminal session was left open so long that its access token expired.

### Cause 3: the disk that holds the web-terminal audit log is full

**Reconnect** has no effect. The `web-terminal` Pods are `Running` with no restarts, and the log shows:

```text
login termail audit failed. ... error: write /var/audit/cpaas-web-terminal-audit.log: no space left on device
failed open terminal for user: ...
```

`web-terminal` cannot write its audit log and refuses to open terminals. Earlier `etcdserver: request timed out` errors can appear in the same log.

### Cause 4: the CLI entry moved to a single Web CLI icon

After an upgrade the per-cluster CLI entry is no longer in the cluster list. By design, the CLI entry moved to a single **Web CLI** icon at the top right of the platform management view, served at `/console-webcli/`. In a working setup the **Alauda Container Platform Web Terminal** plugin is installed on the `global` cluster and the `web-cli` feature gate is enabled. The Web CLI lists the `global` nodes and the business clusters, and a node shell opens with `This is a shell for node, the host root directory is mounted to /host`.

### Cause 5: the debug container image registry address was not replaced

New Pods hang while the debug container initializes, and Pod events show the debug container image pull failing because the registry address in the debug image was not replaced. A debug container in an older Pod on the same cluster still works. Restarting `metis` on the affected cluster fixes new Pods.

### Cause 6: file transfer detection fails although tar exists

The **File Transfer** button is grey and the tooltip says `该容器内不存在tar工具，不支持文件传输功能` (the container has no tar tool; file transfer is not supported), while `tar` is present in the container and `kubectl cp` works. Setting `LANG=en_US.UTF-8` and `LC_ALL=en_US.UTF-8` on the container restores the detection; upgrading the platform to 3.16 or later is the lasting fix.

### Cause 7: nsenter Pods left in Error by the platform CLI

Using the platform CLI tool (the **CLI Tool** entry in the cluster's **Actions** menu, or the terminal icon in the top bar) creates an `nsenter` Pod. A Pod that ended in an error state got stuck during the later cleanup. Such Pods can be deleted and have no impact on the platform or on workloads.

### Cause 8: exec sessions drop because of the network path

The exec window has no fixed timeout: the front end sends a ping every 5 seconds, which keeps the connection open, and exec connects through to the API server. Frequent disconnects therefore point at the network path, for example a proxy with a short idle timeout.

### Cause 9: kubectl on a worker node or in a Web CLI node shell has no kubeconfig

A worker node has no kubeconfig by default, so `kubectl` falls back to `http://localhost:8080` and gets `connect: connection refused`. A node shell in the Web CLI starts inside the CLI container with the host root mounted at `/host`; until `chroot /host` is run, it cannot read the host's configuration.

## Resolution

### Cause 1: the platform is opened over HTTP and the exec window stays blank

Check the scheme in the address bar. If it is `http://`, open the platform through its `https://` access address and run exec again. No platform object changes.

### Cause 2: the terminal access token expired

```bash
kubectl get pods -n cpaas-system | grep web-terminal
kubectl logs -n cpaas-system <web-terminal-pod> --tail=100 | grep -F 'invalid access token'
```

Close the old terminal session and open a new one, so that the page sends a current token. No Pod restart is required. If a brand-new session still logs `authentication head is invalid`, it is not this cause.

### Cause 3: the disk that holds the web-terminal audit log is full

1. Confirm the error and find the full filesystem:

   ```bash
   kubectl get pods -n cpaas-system -o wide | grep -E 'web-terminal|node-terminal'
   kubectl logs -n cpaas-system <web-terminal-pod> --tail=500 | grep -E 'no space left on device|failed open terminal|etcdserver'
   kubectl exec -n cpaas-system <web-terminal-pod> -- df -h /var/audit
   ```

   If `/var/audit` is a host path, run `df -h` on the node that hosts the Pod.

2. Free space on that path, or expand it, until usage is well below the kubelet eviction threshold (about 85%).

   > **Warning:** Deleting files is irreversible; copy anything you still need off the node first, and leave etcd data and container runtime storage in place. Do this only when the `web-terminal` log reports `no space left on device`.

3. Recreate the Pod. Open CLI sessions drop until it is `Ready`.

   ```bash
   kubectl delete pod -n cpaas-system <web-terminal-pod>
   ```

### Cause 4: the CLI entry moved to a single Web CLI icon

Use the **Web CLI** icon at the top right, or open `<platform-address>/console-webcli/`. If it does not load, check the **Alauda Container Platform Web Terminal** plugin on the `global` cluster and the `web-cli` feature gate.

### Cause 5: the debug container image registry address was not replaced

1. Confirm that the event is an image pull failure of the debug container:

   ```bash
   kubectl describe pod -n <namespace> <pod> | sed -n '/Events/,$p'
   kubectl get pods -n cpaas-system | grep metis
   ```

2. Restart `metis` on the affected cluster.

   > **Warning:** Debug image handling and the other functions served by `metis` are interrupted until the new Pod is `Ready`. Do this only when the debug container pull fails because the registry address was not replaced. The Pod is recreated from the same spec.

   ```bash
   kubectl delete pod -n cpaas-system <metis-pod>
   ```

3. Create a new test Deployment and add a debug container; the pull succeeds. If the image is missing from the registry itself, restarting `metis` does not help.

### Cause 6: file transfer detection fails although tar exists

1. Confirm `tar` in the container:

   ```bash
   kubectl exec -n <namespace> <pod> -c <container> -- tar --version
   ```

2. Set `LANG=en_US.UTF-8` and `LC_ALL=en_US.UTF-8` on the container and let the workload roll.

   > **Warning:** Changing the workload's environment rolls its Pods. To roll back, remove the two variables. On platform versions earlier than 3.16 this is a workaround; upgrading to 3.16 or later is the lasting fix.

3. Open **File Transfer** again.

### Cause 7: nsenter Pods left in Error by the platform CLI

```bash
kubectl get pods -A -o wide | grep nsenter | grep -v Running
```

> **Warning:** Deleting an `nsenter` Pod ends any CLI session still using it. Delete only Pods in `Error` or another terminated state. A new CLI session creates a new Pod.

```bash
kubectl delete pod -n <namespace> <nsenter-pod>
```

### Cause 8: exec sessions drop because of the network path

Exec into containers of different projects, and record whether all sessions drop or only some, and after how long. Drops after a fixed number of seconds point at a proxy idle timeout on the path, for example an external nginx `stream` listener with a short `proxy_timeout`; see Cause 5 of [Console returns 502 or does not open after installation or a VIP change on ACP](Console_returns_502_or_does_not_open_after_installation_or_a_VIP_change_on_ACP.md).

### Cause 9: kubectl on a worker node or in a Web CLI node shell has no kubeconfig

In a node shell of the Web CLI, enter the host first:

```bash
chroot /host
kubectl get ns
```

On a worker node, point `kubectl` at a kubeconfig with `--kubeconfig <file>` or at `$HOME/.kube/config`.

> **Warning:** A kubeconfig copied from a master node usually carries cluster-admin credentials, and anyone with access to the worker node can then administer the cluster. Use the narrowest role that works; delete the file to roll back.

```bash
kubectl --kubeconfig <kubeconfig-file> get ns
```

## Diagnostic Steps

```bash
kubectl get pods -n cpaas-system | grep -E 'web-terminal|metis'
kubectl logs -n cpaas-system <web-terminal-pod> --tail=80
```

```text
exec pop-up blank white, platform opened over http://              -> Cause 1
invalid access token: authentication head is invalid               -> Cause 2
write /var/audit/cpaas-web-terminal-audit.log: no space left on device -> Cause 3
per-cluster CLI entry gone after an upgrade, /console-webcli/ works -> Cause 4
debug container image pull fails, registry address not replaced    -> Cause 5
File Transfer grey, tar exists, kubectl cp works                   -> Cause 6
nsenter Pods in Error on every cluster                             -> Cause 7
exec sessions drop often                                           -> Cause 8
kubectl on a worker or in a Web CLI node shell: localhost:8080 refused -> Cause 9
no EXEC entry at all                                               -> the cpc-exec article linked in the Issue section
```

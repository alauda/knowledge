---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
---

# Debug container blocked or left running, and console file upload or download fails on ACP

## Issue

The console opens and the workload is healthy, but the debug function or the console file transfer of a container does not work:

- Enabling debug shows `forbidden by security policy`.
- A debug container of an application has existed for days and has not exited.
- Exec into a debug container keeps loading and never opens, with no error.
- Uploading a large file through **File Transfer** fails, and the browser shows `413 too large`.
- Uploading a large file or a folder through the page, or downloading a file larger than 1G, fails.
- Downloading a file from a container fails, and the browser says to check the internet connection (`请检查互联网连接状况`). It fails for some containers only, or for every container.

Console file transfer runs `tar` inside the target container through exec. An upload runs `kubectl exec -i -n <namespace> <pod> -c <container> -- tar -xmf - -C <destPath>`; no local `tar` or `kubectl` is started. Web CLI failures, a debug image pull that fails, and a greyed-out **File Transfer** button are covered in [Web terminal, exec window, debug container, or console file transfer fails on ACP](Web_terminal_exec_window_debug_container_or_console_file_transfer_fails_on_ACP.md).

## Root Cause

### Cause 1: Pod Security Admission on the namespace blocks the debug container

The namespace carries a Pod Security Admission (PSA) enforce level, and the debug container that the platform adds does not meet it, so its creation is rejected with `forbidden by security policy`. An unprivileged debug mode that fits the namespace PSA level, and copy-based debugging, are not available in these versions.

### Cause 2: debug containers are not cleaned up automatically

The debug function has no automatic cleanup. A debug container stays in the Pod until the business container is restarted.

### Cause 3: host security software intercepts exec into the debug container

Exec into the debug container never finishes loading and shows no error; the WebSocket (`wss`) connection is fine. An old version of host security software on the node intercepts exec and similar requests.

### Cause 4: an nginx in front of the platform limits the request body

Uploading through the platform domain returns `413 too large`, while uploading the same file through the global VIP address succeeds. An nginx operated by the site in front of the global VIP limits the request body size. The `archon-api` container of the `archon` Pod in `cpaas-system` logs the upload form fields (`form name: file`, `form name: dest`, `form name: size`) and no size error; other lines in that log (`Failed to get in-cluster client builder: Unauthorized`, `Get autoscaler with workload ... not found`, `find apiResource for kind error: ... skip`) are unrelated.

### Cause 5: page transfers of large files and folders are limited

The page exec channel has a size ceiling, and transfers through the page depend on several link-layer factors such as the browser and nginx; a download of more than 1G failed on 3.18. The page has also not been shown to upload a directory. Large transfers through the page are not recommended.

### Cause 6: the archon image is older than the download path

The console cannot download any file from any container, although the file exists. The `archon` image predates the download path, so restarting `archon` does not help.

### Cause 7: the tar in the container image fails with "Function not implemented"

Downloads fail for some containers only, including small files such as `/etc/adduser.conf`. The platform log for the transfer shows:

```text
Handle request error: read source file error: tar: Removing leading '/' from member names
tar: /etc/adduser.conf: Cannot stat: Function not implemented
tar: Exiting with failure status due to previous errors
Websocket Ping failed: ... write: broken pipe
```

`kubectl cp` from the same container fails with the same `Cannot stat: Function not implemented`. Running `tar -cf - -- /etc/gai.conf >/dev/null` inside that container fails with exit code `2`, while in another container on the same kind of node (same `tar (GNU tar) 1.35` version) it succeeds with exit code `0`. The custom-built business image cannot execute the `tar` command that file transfer relies on. `Function not implemented` is the Linux `ENOSYS` error: a system call used by that image's `tar` or its libraries is not available to the container on that node.

## Resolution

### Cause 1: Pod Security Admission on the namespace blocks the debug container

Confirm the PSA labels and the rejection:

```bash
kubectl get ns <namespace> -o jsonpath='{.metadata.labels}' | tr ',' '\n' | grep pod-security
kubectl get events -n <namespace> --sort-by=.lastTimestamp | grep -i -E 'forbidden|PodSecurity' | tail
```

A `pod-security.kubernetes.io/enforce` level such as `restricted` or `baseline`, together with `forbidden by security policy`, is this cause. Debug works only in namespaces whose PSA level admits the debug container; if the namespace policy must stay as it is, debug is not available there.

### Cause 2: debug containers are not cleaned up automatically

1. Find the Pod that still carries the debug container:

   ```bash
   kubectl get pod -n <namespace> <pod> -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{end}{range .spec.ephemeralContainers[*]}{.name}{" (ephemeral)\n"}{end}'
   ```

2. Restart the workload to remove it.

   > **Warning:** Restarting replaces the Pods; with one replica the service is unavailable until the new Pod is Ready. Precondition: the leftover debug container must go, and a restart is acceptable in this window. The restart cannot be undone, and the business container keeps running without it.

   ```bash
   kubectl rollout restart deployment -n <namespace> <deployment>
   kubectl rollout status deployment -n <namespace> <deployment>
   ```

### Cause 3: host security software intercepts exec into the debug container

1. Rule out the console path: if `kubectl exec` from a control-plane node into the same container also hangs, the request is stopped below the console.

   ```bash
   kubectl exec -n <namespace> <pod> -c <container> -- sh -c 'echo ok'
   kubectl get pod -n <namespace> <pod> -o jsonpath='{.spec.nodeName}{"\n"}'
   ```

2. On that node, check the host security agent's console or logs for blocked exec or process-creation events, and ask its owner to stop intercepting the exec requests (for example by upgrading the agent). Retry exec afterwards.

### Cause 4: an nginx in front of the platform limits the request body

1. Upload the same file through the platform domain and through the global VIP address. `413` on the domain and success on the VIP is this cause.

   ```bash
   kubectl logs -n cpaas-system <archon-pod> -c archon-api --tail=200 | grep -E 'form name|size'
   ```

2. Raise the request-body limit on the proxy in front of the global VIP. For nginx that is `client_max_body_size`; set it above the largest file you need to transfer.

   > **Warning:** Reloading that nginx applies the change to all traffic through it, and a syntax error stops it from serving. A larger limit also lets clients send larger requests to every site behind it. Precondition: a copy of the old configuration. Rollback: restore the copy and reload.

   ```bash
   grep -rn client_max_body_size /etc/nginx/
   nginx -t && nginx -s reload
   ```

### Cause 5: page transfers of large files and folders are limited

Copy large files with `kubectl cp` from a host that can reach the cluster API:

```bash
kubectl cp <namespace>/<pod>:/path/in/container/<file> ./<file> -c <container>
kubectl cp ./<local-file> <namespace>/<pod>:/path/in/container -c <container>
ls -l ./<file>
```

For a directory, archive it first, copy the archive, and extract it inside the container. `kubectl cp` also uses `tar` inside the container (see Cause 7).

### Cause 6: the archon image is older than the download path

```bash
kubectl get pods -A | grep archon
kubectl get deploy -A -o wide | grep archon
kubectl logs -n <namespace> <archon-pod> --tail=100
```

> **Warning:** Changing the `archon` image restarts console downloads and the exec helpers it serves until the new Pod is Ready. Precondition: the running image is older than the one shipped with the platform version; use that shipped image, not an arbitrary newer tag. Rollback: set the previous image.

Set the `archon` image to the one that ships with the platform version, wait until the Pod is Ready, and download a small file from a container to confirm.

### Cause 7: the tar in the container image fails with "Function not implemented"

1. Reproduce inside the failing container:

   ```bash
   kubectl exec -n <namespace> <pod> -c <container> -- tar --version
   kubectl exec -n <namespace> <pod> -c <container> -- sh -c 'tar -cf - -- /etc/hostname >/dev/null; echo exit=$?'
   ```

   `Cannot stat: Function not implemented` and `exit=2` confirm the cause. Run the same in a container where downloads work for comparison.

2. Fix the image: rebuild the business image with a `tar` (and libraries) that runs on the cluster nodes, and roll the workload to the new image. Neither the console nor `archon` needs a change.

3. Until the image is fixed, a single file can be read without `tar`:

   ```bash
   kubectl exec -n <namespace> <pod> -c <container> -- cat /path/in/container/<file> > ./<file>
   ```

## Diagnostic Steps

```bash
kubectl get ns <namespace> --show-labels
kubectl get pod -n <namespace> <pod> -o yaml | grep -n -E 'ephemeralContainers|container-debug'
kubectl get pods -n cpaas-system | grep archon
```

```text
debug says forbidden by security policy, namespace has a pod-security enforce label -> Cause 1
debug container still present days later                                            -> Cause 2
debug exec keeps loading, kubectl exec from a node also hangs                       -> Cause 3
upload returns 413 through the domain, succeeds through the VIP                     -> Cause 4
large file (over 1G) or folder through the page fails, kubectl cp works             -> Cause 5
every download from every container fails, archon image older than the platform     -> Cause 6
download fails for some containers, tar in that container: Function not implemented -> Cause 7
```

To tell Cause 7 from the others, run `kubectl cp` for the same file: it fails the same way only for Cause 7.

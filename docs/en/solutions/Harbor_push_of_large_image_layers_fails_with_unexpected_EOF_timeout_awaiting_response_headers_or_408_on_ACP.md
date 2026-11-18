---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Harbor push of large image layers fails with unexpected EOF, timeout awaiting response headers, or 408 on ACP

## Issue

Small layers of an image push to Harbor (or report `Layer already exists`), but a large layer gets part way through the blob upload and then the connection closes or the commit never returns. Typical client output:

- `unexpected EOF` once a layer passes about 150 MB.
- `failed commit on ref "layer-sha256:<digest>": failed to do request: Put ".../v2/<project>/<repository>/blobs/uploads/...": EOF`, or `failed commit on ref` with `unexpected status` from the blob `PUT`, typically for multi-gigabyte layers.
- `timeout awaiting response headers` while a large layer is being committed.
- Images larger than about 1 GB fail during transfer to a Harbor exposed by NodePort.

`failed commit on ref` with `unexpected status` from the blob `PUT` means the registry reports that the upload did not finish. Find out where the connection was cut (client path, node agent, NodePort) before raising any Harbor limit.

Related articles: [Harbor image push fails while harbor-nginx restarts, or is rejected with too large on a NodePort Harbor](Harbor_image_push_fails_while_harbor-nginx_restarts_or_is_rejected_with_too_large_on_a_NodePort_Harbor.md) and [docker push to Harbor from Docker Desktop times out with proxyconnect i/o timeout](docker_push_to_Harbor_from_Docker_Desktop_times_out_with_proxyconnect_i_o_timeout.md).

## Root Cause

### Cause 1: a security agent on the Harbor nodes cuts uploads at about 150 MB

`unexpected EOF` appears while the blob upload is still below the size of images that otherwise push, commonly at about 150 MB. The registry logs show that the client connection dropped, and the upload URL then returns 404 or 500 on retry. Moving the client to NodePort does not help, because the connection is closed on the Harbor node and not by an ingress timeout. A host security agent such as Trend Micro Deep Security Agent (`dsa_agent` / `ds_agent`) on the nodes running Harbor, with a policy that inspects the upload, closes it. Relaxing that policy lets the same layer commit.

### Cause 2: the VPN or workstation path drops long uploads

Pushes from a workstation (for example Docker Desktop on Windows or macOS) through a VPN fail on large layers: smaller layers report `Layer already exists` or push, multi-gigabyte layers stall in `Pushing` and the final `PUT` ends with `unexpected EOF`, `EOF`, or `failed commit on ref ... unexpected status`. The `registry` container of the Harbor registry Pod logs:

```text
level=error msg="client disconnected during blob PUT" ... error="unexpected EOF" contentLength=241553920 copied=6859330
msg="response completed with error" ... http.request.method=PUT ... http.response.status=500
http: superfluous response.WriteHeader call
```

The `500` on the upload URL follows the client disconnect; it is not a registry storage error. Harbor itself is healthy: pushing the same image from a node inside the cluster, or on the Harbor server side, succeeds. The connection is dropped on the client path, most often by a rate or connection-time limit of the VPN, or by a timeout of the local Docker client. Giving Docker Desktop more memory does not help. The exact mechanism differs per network and is usually not visible from Harbor.

### Cause 3: `timeout awaiting response headers` on a large layer commit

The client sends the layer and then waits for the registry's response until its header timeout expires. Repeating the same push from a Linux Docker host on a network that reaches Harbor directly succeeds, so the failure belongs to the original client path. A wrong image name, node time skew, and the volume type of `harbor-registry` do not explain this pattern. A Linux retry that succeeds is a client-path recovery, not evidence of a corrupt blob store.

### Cause 4: images larger than about 1 GB fail against a NodePort Harbor with `408` and `upload resumed at wrong offset`

Harbor is exposed through NodePort and the client pushes to `<node-address>:<nodeport>`. The `nginx` container of `harbor-nginx` logs the blob uploads ending with `408` after roughly 750 seconds:

```text
"PUT /v2/<project>/<repository>/blobs/uploads/<uuid>?... HTTP/1.1" 408 0 ... "docker/<version> ..."
```

The `harbor-registry` log then rejects the resumed upload:

```text
level=error msg="upload resumed at wrong offset: 626907975 != 0"
msg="response completed with error" err.code="blob upload invalid" err.message="blob upload invalid" http.response.status=404
```

Concurrent large-layer uploads with the default MTU make the blob uploads time out through the NodePort, and the retried uploads then fail because the registry expects the upload to start over. Limiting the Docker client to one concurrent upload and setting its MTU to 1440 lets the large image push. Why exactly these two settings help is not established.

## Resolution

### Cause 1: a security agent on the Harbor nodes cuts uploads at about 150 MB

1. On each node that runs Harbor Registry, check for the agent. A hit here plus a repeatable close near 150 MB is the signature:

   ```bash
   ps -ef | grep -E 'dsa_agent|ds_agent' | grep -v grep
   systemctl status ds_agent --no-pager
   ```

   If no agent is installed, this cause does not apply.

2. In the security policy bound to those nodes, disable the intrusion-prevention or firewall rule that terminates the long upload, or exclude the Harbor registry port from that inspection.

   > **Warning:** Relaxing the agent policy stops that control from inspecting traffic on the Harbor nodes, which is a lasting security change if it stays. Impact: less inspection on those nodes. Precondition: a maintenance window, the policy name and previous setting recorded, and only the registry port excluded. Rollback: restore the recorded policy.

3. Push one image with a layer larger than 150 MB from the same client that failed. If it commits, keep the port exclusion, or restore the policy and run Harbor on nodes the agent does not inspect. Do not delete partial blobs or run garbage collection as part of this test; an interrupted upload does not corrupt existing manifests.

### Cause 2: the VPN or workstation path drops long uploads

1. Confirm that the registry saw the client go away rather than a storage failure:

   ```bash
   kubectl get pods -n <harbor-namespace> | grep registry
   kubectl logs -n <harbor-namespace> <harbor-registry-pod> -c registry --since=2h | grep -E 'client disconnected during blob PUT|response completed with error'
   ```

2. Retry the identical push from a host that reaches Harbor directly, without the VPN. If it succeeds, Harbor needs no change; take the VPN rate or connection-time limit to whoever operates that network.

3. To get the image in without the VPN path, save it, copy it to a node inside the cluster, and push it from there:

   ```bash
   docker save <harbor-host>:<port>/<project>/<repository>:<tag> -o /tmp/<repository>-<tag>.tar
   # copy the tar to a cluster node, then on that node:
   ctr -n k8s.io image import /tmp/<repository>-<tag>.tar
   ctr -n k8s.io image push -u <username>:'<password>' <harbor-host>:<port>/<project>/<repository>:<tag>
   ```

   Add `--plain-http` to `ctr image push` for an HTTP Harbor, or `--skip-verify` for an HTTPS Harbor whose CA the node does not trust; `ctr` does not read `/etc/containerd/certs.d` by default. Compare the size of the tar file at both ends of the copy; an interrupted copy produces a defective image.

4. Lowering the client MTU (see Cause 4) can be tried as a mitigation on the VPN path; whether it helps depends on the VPN.

### Cause 3: `timeout awaiting response headers` on a large layer commit

1. Retry the push from a Linux Docker client on a network that reaches Harbor directly:

   ```bash
   docker push <harbor-host>:<port>/<project>/<repository>:<tag>
   ```

2. While it runs, confirm that the registry is not stuck on storage:

   ```bash
   kubectl get pods -A | grep harbor-registry
   kubectl describe pod -n <harbor-namespace> <harbor-registry-pod>
   ```

   If the events or volume status show the disk is full, free space or expand the volume before another multi-gigabyte attempt. Do not wipe the registry volume because a push timed out.

### Cause 4: images larger than about 1 GB fail against a NodePort Harbor with `408` and `upload resumed at wrong offset`

1. Confirm the signature in the Harbor logs for the time of the failed push. If `registry` is not the container name, list them with `kubectl get pod -n <harbor-namespace> <harbor-registry-pod> -o jsonpath='{.spec.containers[*].name}'`.

   ```bash
   kubectl get deploy -n <harbor-namespace> | grep -E 'nginx|registry'
   kubectl logs -n <harbor-namespace> deploy/<harbor-nginx-deploy> -c nginx --since=2h | grep -E 'PUT /v2/.*/blobs/uploads/.* 408 '
   kubectl logs -n <harbor-namespace> <harbor-registry-pod> -c registry --since=2h | grep -E 'upload resumed at wrong offset|blob upload invalid'
   ```

2. Merge two settings into the client's existing Docker Engine configuration, keeping unrelated keys. The result must contain `"max-concurrent-uploads": 1` and `"mtu": 1440`, for example:

   ```json
   {
     "insecure-registries": ["192.0.2.10:<nodeport>"],
     "max-concurrent-uploads": 1,
     "mtu": 1440
   }
   ```

   On Docker Desktop the same JSON is edited under **Settings > Docker Engine**; **Apply & restart** restarts the engine. On a Linux host, edit `/etc/docker/daemon.json` and restart Docker.

   > **Warning:** Only when the NodePort signature in step 1 is confirmed. Impact: restarting Docker stops the containers that run under that `dockerd`; kubelet image pulls are not affected. Precondition: `/etc/docker/daemon.json` is copied aside. Rollback: restore the copy and restart Docker again.

   ```bash
   cp -a /etc/docker/daemon.json /root/daemon.json.bak
   # edit /etc/docker/daemon.json so it contains max-concurrent-uploads 1 and mtu 1440, then:
   systemctl restart docker
   docker push <harbor-host>:<nodeport>/<project>/<repository>:<tag>
   ```

## Diagnostic Steps

1. Record the layer size, the bytes sent at failure, the elapsed time, the client OS and network path (VPN or direct), the destination host and port, and whether a small push succeeds. Do not loop a multi-gigabyte push while collecting this.

2. Read the Harbor components and the registry log for the same timestamp:

   ```bash
   kubectl get pods -n <harbor-namespace> -o wide | grep -iE 'nginx|core|registry'
   kubectl logs -n <harbor-namespace> <harbor-registry-pod> -c registry --tail=200
   ```

   A client disconnect followed by 404 or 500 on the upload URL means the connection was cut outside the registry. A storage I/O or no-space error is a registry volume fault, not one of these causes.

3. Classify:

   | What you see | Cause |
   | --- | --- |
   | `unexpected EOF` near 150 MB, `dsa_agent` / `ds_agent` on the Harbor nodes, NodePort fails the same way as the ingress | Cause 1 |
   | `client disconnected during blob PUT` in the registry log; the push fails only from a VPN or workstation and succeeds from a cluster node | Cause 2 |
   | `timeout awaiting response headers` on commit; a Linux client on a direct network succeeds | Cause 3 |
   | NodePort Harbor, images over about 1 GB, nginx `408` on the blob `PUT`, then `upload resumed at wrong offset` | Cause 4 |
   | `harbor-nginx` restarted during the push, or the body says `too large` | First related article above |
   | `proxyconnect tcp: ... i/o timeout` before any layer uploads | Second related article above |

4. After the fix, confirm the manifest reads back, using the scheme this Harbor serves:

   ```bash
   curl -sS -o /dev/null -D - -u <username>:<password> \
     https://<harbor-host>:<port>/v2/<project>/<repository>/manifests/<tag>
   ```

   An HTTP `200`, and a later pull of the same tag, confirm the push. A `401` here is a credential problem, not a short upload.

A pull-side `unexpected EOF` on a single node is a different problem; see [Intermittent image pull io timeout from a single ACP node](Intermittent_image_pull_io_timeout_from_a_single_ACP_node.md). A push that never starts a blob and fails with `x509` or `HTTP response to HTTPS client` is covered in [Harbor push or pull fails because the client uses the wrong scheme](Harbor_push_or_pull_fails_because_the_client_uses_the_wrong_scheme_HTTP_response_to_HTTPS_client_or_port_443_refused.md).

---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Harbor image push fails while harbor-nginx restarts, or is rejected with too large on a NodePort Harbor

## Issue

An image push to Harbor fails, and Harbor looks abnormal, in one of two ways:

- The push fails during the upload of many layers at once, and the Harbor nginx Pod (`<harbor-name>-nginx`, also seen as `harbor-nginx`) has restarted during the push. Its events show `Liveness probe failed`, or the Pod keeps restarting because it does not have enough CPU. Every upload in progress is dropped at each restart.
- The push fails with a response body that says `too large`, and the question is how to raise the Harbor upload size limit. Harbor is exposed by NodePort, the push target is a node address, and the push comes from Docker on a machine outside the platform.

Related articles: [Harbor push of large image layers fails with unexpected EOF, timeout awaiting response headers, or 408 on ACP](Harbor_push_of_large_image_layers_fails_with_unexpected_EOF_timeout_awaiting_response_headers_or_408_on_ACP.md) and [docker push to Harbor from Docker Desktop times out with proxyconnect i/o timeout](docker_push_to_Harbor_from_Docker_Desktop_times_out_with_proxyconnect_i_o_timeout.md).

## Root Cause

### Cause 1: the Harbor nginx Pod is killed during the push because it lacks memory or CPU

The client pushes many blobs concurrently. nginx proxies them to Harbor Core, and Core proxies them to Harbor Registry. When the upload initialization requests (`POST /v2/<project>/<repository>/blobs/uploads/`) take several seconds each, the nginx workers are blocked and cannot answer the liveness probe, which has a 1-second timeout. Kubernetes kills and restarts the nginx container repeatedly, which drops every upload in progress. nginx memory use above its request (for example 184 Mi used against a 128 Mi request and a 256 Mi limit) goes with this pattern. Increasing the memory of the nginx component restores image upload.

The same failure appears when the nginx Pod restarts because it does not have enough CPU. Increasing the nginx CPU and memory in the Harbor instance makes image push work again.

### Cause 2: `too large` from an old Docker client pushing to a node address

The push target is a Kubernetes node address because Harbor is exposed by NodePort, and no load balancer or gateway sits in the path. The push comes from Docker on an external machine. The Docker client version on that machine is too old, and the `too large` error comes from that client, not from a Harbor size limit. The same images (about 300 MB, and about 1 GB) push successfully with containerd (`ctr`) from a platform node, with no Harbor limit changed.

When a Registry Gateway is in the push path, `too large` is that gateway's size policy instead; see [Restricting Docker image push size and tag count using the Registry Gateway plugin](Restricting_Docker_Image_Push_Size_and_Tag_Count_using_the_Registry_Gateway_Plugin.md). Do not disable the gateway to get a large image through.

## Resolution

### Cause 1: the Harbor nginx Pod is killed during the push because it lacks memory or CPU

1. Confirm the restarts and their reason, and compare CPU and memory use with the request and limit:

   ```bash
   kubectl get pods -n <harbor-namespace> | grep -i nginx
   kubectl describe pod -n <harbor-namespace> <harbor-nginx-pod> | grep -iE 'Restart Count|Last State|Reason|Liveness|Requests|Limits|cpu|memory'
   kubectl top pod -n <harbor-namespace> <harbor-nginx-pod>
   ```

   Continue only when the restarts line up with the failed pushes and the events show `Liveness probe failed`, or the CPU use is at the limit at the restart times.

2. Raise the nginx resources on the Harbor resource that the operator reconciles, not on the generated Deployment. Raise memory for a liveness-probe kill; raise CPU and memory together when CPU is short. In the Harbor chart values the nginx resources are under `nginx.resources`; check what `spec.helmValues` already contains before adding them, and size the values above what `kubectl top` showed. Example:

   ```yaml
   spec:
     helmValues:
       nginx:
         resources:
           requests:
             cpu: <cpu-request>
             memory: 256Mi
           limits:
             cpu: <cpu-limit>
             memory: 512Mi
   ```

   > **Warning:** Impact: saving the Harbor resource rolls the Harbor Pods it changes, and pushes and pulls through nginx are interrupted until the new nginx Pod is `Ready`. Precondition: the restart signature in step 1 is confirmed, a maintenance window, and the current resource saved by the first command below. Rollback: `kubectl apply -f /tmp/harbor-before-nginx.yaml`.

   ```bash
   kubectl get harbor -n <harbor-namespace> <harbor-name> -o yaml > /tmp/harbor-before-nginx.yaml
   kubectl edit harbor -n <harbor-namespace> <harbor-name>
   kubectl get deploy -n <harbor-namespace> <harbor-name>-nginx -o jsonpath='{.spec.template.spec.containers[0].resources}{"\n"}'
   ```

3. The last command must show the new values. If the Deployment does not change, the operator did not take the field; the Deployment-level alternative is described in [harbor-nginx or portal does not start or keeps restarting](harbor-nginx_or_portal_does_not_start_or_keeps_restarting_IP_address_family_unsupported_or_OOMKilled.md) (Cause 2).

4. Repeat the push that failed and confirm that the nginx restart count no longer grows.

### Cause 2: `too large` from an old Docker client pushing to a node address

1. Confirm that no load balancer or Registry Gateway is in front of Harbor, that the push target is a node address and NodePort, and that the push comes from a machine outside the platform. Read the client version:

   ```bash
   docker version
   ```

2. Upgrade Docker on that machine. Compare its version with a machine that can push the same image to choose the target version.

3. Until the client is upgraded, push the image from a platform node that runs containerd:

   ```bash
   docker save <harbor-host>:<nodeport>/<project>/<repository>:<tag> -o /tmp/<repository>-<tag>.tar
   # copy the tar to the platform node, then on that node:
   ctr -n k8s.io image import /tmp/<repository>-<tag>.tar
   ctr -n k8s.io image push -u <username>:'<password>' <harbor-host>:<nodeport>/<project>/<repository>:<tag>
   ```

   Add `--plain-http` to `ctr image push` for an HTTP Harbor, or `--skip-verify` for an HTTPS Harbor whose CA the node does not trust; `ctr` does not read `/etc/containerd/certs.d` by default. No Harbor upload size limit needs to change.

## Diagnostic Steps

1. Check whether nginx restarted during the push:

   ```bash
   kubectl get pods -n <harbor-namespace> -o wide | grep -iE 'nginx|core|registry'
   kubectl get events -n <harbor-namespace> --field-selector involvedObject.name=<harbor-nginx-pod>
   ```

   A restart count that grows at the time of the failed push, with `Liveness probe failed` events or CPU at its limit, is Cause 1, whatever the layer size. `Last State: Terminated, Reason: OOMKilled` without a push in progress is covered by [harbor-nginx or portal does not start or keeps restarting](harbor-nginx_or_portal_does_not_start_or_keeps_restarting_IP_address_family_unsupported_or_OOMKilled.md).

2. For `too large`, establish the push path:

   | What you see | Conclusion |
   | --- | --- |
   | A Registry Gateway is in the path | The gateway's size policy; follow the Registry Gateway article above |
   | Target is `<node-address>:<nodeport>`, no load balancer, push from an external machine's Docker, the same image pushes with `ctr` from a platform node | Cause 2 |

3. A push that fails with `unexpected EOF`, `timeout awaiting response headers`, or an nginx `408` without nginx restarting belongs to the first related article above.

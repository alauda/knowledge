---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Harbor image push through ALB fails with use of closed network connection when ALB runs out of memory on ACP

## Issue

Harbor is exposed through an ALB Layer 7 listener (for example after moving Harbor from another gateway to an ALB). Image pushes fail intermittently, mostly for large images or when several pushes run at the same time, and often succeed after a few retries. Later, image pulls can fail as well.

The Docker client retries each layer and then gives up:

```text
Retrying in 5 seconds
Retrying in 4 seconds
...
write tcp <client-ip>:<port>-><harbor-address>:<alb-port>: use of closed network connection
ERROR: Push image <harbor-address>:<alb-port>/<project>/<repository>:<tag> failed!
```

No NodePort or hostPort conflict for the ALB port is found on the nodes.

## Root Cause

### Cause 1: the ALB buffers whole request bodies in memory and exceeds its memory limit

By default, the ALB does not stream request bodies in Layer 7 forwarding. It buffers the complete request body in memory and only then forwards it to the backend. When Harbor is behind the ALB, every image layer upload is one request body, so the ALB holds whole layers in memory.

The memory of the ALB `nginx` container is bounded by `.spec.config.resources.limits` of the `ALB2` resource, which is `256Mi` in the default ALB configuration. With large image layers and concurrent pushes, the buffered data exceeds that limit, and the process handling the upload is killed for running out of memory. The connection to the client is cut in the middle of the upload, the client reports `use of closed network connection`, and the push fails. Pulls through the same ALB can fail as well; both recover once the memory limit is raised.

## Resolution

### Cause 1

Raise the memory limit of the ALB instance that serves Harbor. Raising it to `1.5Gi` restored Harbor push and pull for large images with concurrent pushes; size it to the largest layers and the push concurrency you expect.

1. Read the current resource settings of the ALB:

   ```bash
   kubectl -n cpaas-system get alb2 <alb-name> -o jsonpath='{.spec.config.resources}{"\n"}'
   ```

2. Raise the memory limit of the `nginx` container (`.spec.config.resources.limits.memory`). In the web console: **Administrator > Network Management > Load Balancer**, click **⋮ > Update** on the ALB, change the resource configuration and click **Update**. Or with `kubectl`:

   > **Warning:** Changing the ALB resources rolls the ALB Pods. Traffic through this ALB, including all other services it exposes, can be briefly interrupted while the Pods restart, longer with a single replica. Make sure the nodes running the ALB have enough free memory for the new limit. Do this only when the memory exhaustion is confirmed (see Diagnostic Steps). Roll back by setting the limit back to the value recorded in step 1.

   ```bash
   kubectl -n cpaas-system patch alb2 <alb-name> --type=merge \
     -p '{"spec":{"config":{"resources":{"limits":{"memory":"1536Mi"}}}}}'
   ```

   Keep `.spec.config.resources.requests.memory` less than or equal to the new limit.

3. Wait for the ALB Pods to be recreated and Ready:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep <alb-name>
   ```

4. Push the large image again, also with several pushes in parallel, and confirm that the push and later pulls succeed.

## Diagnostic Steps

1. Confirm that the failing pushes go through the ALB: the registry address and port in the error (`<harbor-address>:<alb-port>`) are the ALB address and listener port of the Harbor rule.

2. Check the memory limit of the ALB:

   ```bash
   kubectl -n cpaas-system get alb2 <alb-name> -o jsonpath='{.spec.config.resources.limits}{"\n"}'
   ```

   A limit of `256Mi` (the default) with images whose layers are hundreds of MB points to this cause.

3. Watch the ALB memory while reproducing the failure with a large image or with several concurrent pushes:

   ```bash
   kubectl -n cpaas-system top pod | grep <alb-name>
   ```

   Expected for this cause: the memory of the ALB Pod climbs to the limit during the upload, and the push fails at that moment.

4. Look for out-of-memory kills. A killed container shows `Reason: OOMKilled` in its last state; a killed worker process inside the container appears in the kernel log of the node running the ALB Pod:

   ```bash
   kubectl -n cpaas-system describe pod <alb-pod> | grep -A5 'Last State'
   journalctl -k | grep -iE 'memory cgroup out of memory|oom-kill'
   ```

   An OOM kill that matches the time of a failed push confirms this cause. If the ALB memory stays well below the limit while pushes fail, look at the network path between client, ALB and Harbor instead.

See also `ACP_ALB_pods_OOMKilled_with_high_restart_counts_remove_memory_limits_on_global_alb2.md` for OOM kills of the `global-alb2` instance.

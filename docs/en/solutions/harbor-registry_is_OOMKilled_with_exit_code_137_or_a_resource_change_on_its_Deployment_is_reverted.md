---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "3.14"
  - "3.18"
---

# harbor-registry is OOMKilled with exit code 137, or a resource change on its Deployment is reverted

## Issue

The Harbor `registry` component keeps restarting and its log shows no obvious error, or it has hit its CPU or memory limit and the image registry is unavailable. Typical signs:

- The `harbor-registry` Pod's `RESTARTS` count grows, it may alternate between `Running` and `CrashLoopBackOff`, and its last state shows exit code `137`. This can start after the node container runtime was switched from Docker to containerd.
- An engineer raises the limits on the `harbor-registry` Deployment, and the change is reverted shortly afterwards.
- Clicking Update on the Harbor instance reports that some operators are not ready because they were never deployed. After the Redis and PostgreSQL operators are installed, Update asks for a storage class that a local-PV instance does not have.

## Root Cause

### Cause 1: the registry container is OOMKilled at its memory limit

The kernel kills the `registry` container when it reaches its memory limit. The container's last state shows reason `OOMKilled` and exit code `137` (`128 + 9`, the process ended by `SIGKILL`), and the registry log has no error because the process was killed from outside. Raising the resources of the Harbor instance stops the restarts. Because the operator owns the Deployment, the change must be made on the Harbor instance, not on the Deployment (see Cause 2).

### Cause 2: the Harbor operator owns the component resources and reverts Deployment edits

Harbor component resources are controlled by the `Harbor` custom resource. The Harbor operator reconciles the Deployments from it, so a manual edit of the Deployment limits is written back. With `spec.resourceAssign.type: GlobalAssign`, the operator derives per-component values from one global setting (for example cpu `"16"` and memory `16Gi`) and writes them to `status.helmValues`; those status values are what the Deployments get. The API group can be `operator.devops.alauda.io/v1alpha1` or `operator.alaudadevops.io/v1alpha1` depending on the Harbor line; `kubectl get harbor` works for both.

Two ways give a component its own size:

- **The Update form** on the instance details page, which switches from global to per-component assignment. It requires the Redis and PostgreSQL operators to be installed. On platform 3.18 it also moves Harbor's PostgreSQL and Redis to Data Services-managed instances on TopoLVM storage, which is why it asks for a storage class that an instance with `persistence.type: LocalPath` does not have. That is an upgrade path, not only a limit change.
- **Component resources in the Harbor resource** under `spec.helmValues`. For the registry container the path is `spec.helmValues.registry.registry.resources`: the outer `registry` is the Harbor registry component, the inner `registry` is its registry container, next to `controller` (the `registryctl` container). Other components, such as `core`, sit at the same level as the outer `registry`. This path works on a `LocalPath` instance without a storage migration. A common mistake is `spec.helmValues.registry.resources`, which the operator does not use for the registry container.

## Resolution

### Cause 1

1. Confirm the OOM kill and read the current values (Diagnostic Steps, steps 1 and 2).

2. Raise the memory of the container whose last state is `OOMKilled` on the Harbor resource: `registry` at `spec.helmValues.registry.registry.resources`, or `registryctl` at `spec.helmValues.registry.controller.resources`. Choose a limit above the current one in `status.helmValues` and above the usage seen just before the kills, and keep the request no higher than a node can schedule. You can also update the instance resources from the UI.

   > **Warning:** Only when the `OOMKilled` / `137` signature is confirmed. Impact: the operator reconciles the Harbor Deployments; `harbor-registry` Pods roll, and pushes and pulls are interrupted until they are Ready. Precondition: the backup below is saved and the new limit fits on the nodes. Rollback: `kubectl apply -f /tmp/harbor-before-oom.yaml`.

   ```bash
   kubectl -n <namespace> get harbor <name> -o yaml > /tmp/harbor-before-oom.yaml
   kubectl -n <namespace> edit harbor <name>
   ```

   Merge the block into the existing `spec.helmValues`; do not replace keys such as `externalURL`, `expose`, or `persistence`:

   ```yaml
   spec:
     helmValues:
       registry:
         registry:
           resources:
             limits:
               memory: <new-limit>
             requests:
               memory: <new-request>
   ```

3. Confirm the value reached the operator and the Deployment, and that the restart count stops growing under normal load:

   ```bash
   kubectl -n <namespace> get harbor <name> -o jsonpath='{.status.helmValues.registry.registry.resources}{"\n"}'
   kubectl -n <namespace> get deploy <harbor-registry-deployment> -o jsonpath='{.spec.template.spec.containers[*].resources}{"\n"}'
   kubectl -n <namespace> rollout status deployment <harbor-registry-deployment>
   kubectl get pods -A | grep harbor-registry
   ```

   If the new Pod is `Pending`, read its events for `Insufficient memory` and lower the request or free a node. If the Deployment does not change, the edit missed the field the operator reads.

If all Harbor Pods start cycling after the edit, check whether the registry PVC is larger than the size declared in the Harbor resource; see [Harbor core service unavailable or internal server error, stuck instance status, or Pods cycling after an edit](Harbor_core_service_unavailable_or_internal_server_error_stuck_instance_status_or_Pods_cycling_after_an_edit.md) (Cause 4).

### Cause 2

1. Save the resource and read how resources are assigned:

   ```bash
   kubectl get harbor -A
   kubectl -n <namespace> get harbor <name> -o yaml > /tmp/harbor-resources.yaml
   grep -n -E 'resourceAssign|GlobalAssign|currentVersion|LocalPath|persistence' /tmp/harbor-resources.yaml
   kubectl -n <namespace> get harbor <name> -o jsonpath='{.status.helmValues.registry}{"\n"}'
   ```

2. Choose the path:

   - Use the Update form only when the move of PostgreSQL and Redis to Data Services instances on TopoLVM is the change you intend. If Update says operators were never deployed, install the Redis and PostgreSQL operators first.
   - Otherwise, especially on a `LocalPath` instance, add component resources to the Harbor resource. Size them for your workload, comparing with the current value in `status.helmValues`. Example values for the registry container:

   > **Warning:** Impact: the operator reconciles the Harbor Deployments; `harbor-registry` Pods roll, and a limit that is still too small leaves the registry unavailable. Precondition: `/tmp/harbor-resources.yaml` is a complete copy of the object. Rollback: `kubectl apply -f /tmp/harbor-resources.yaml`.

   ```bash
   kubectl -n <namespace> edit harbor <name>
   ```

   ```yaml
   spec:
     helmValues:
       registry:
         registry:
           resources:
             limits:
               cpu: 300m
               memory: 800Mi
             requests:
               cpu: 150m
               memory: 400Mi
   ```

   Leave other components out unless you mean to resize them, or add them at the same level as `registry` (for example `spec.helmValues.core.resources`).

3. Confirm with the commands in Cause 1, step 3. Do not edit the Deployment again: that is the change the operator reverts. When `harbor-registry` is Ready, pull one known tag.

## Diagnostic Steps

1. Read the last termination state of each container in the registry Pod, its events, and the previous log:

   ```bash
   kubectl -n <namespace> get pod <harbor-registry-pod> -o jsonpath='{range .status.containerStatuses[*]}{.name}{" restarts="}{.restartCount}{" reason="}{.lastState.terminated.reason}{" exit="}{.lastState.terminated.exitCode}{"\n"}{end}'
   kubectl -n <namespace> get events --field-selector involvedObject.name=<harbor-registry-pod>
   kubectl -n <namespace> logs <harbor-registry-pod> -c registry --previous --tail=50
   ```

   `OOMKilled` with exit code `137` is Cause 1. Exit code `137` without `OOMKilled` is a SIGKILL from elsewhere: check the events for a failing liveness probe before changing memory. A storage, configuration, or permission error at the end of the previous log points at the registry storage instead.

2. Compare memory use with the limit, and look for the kernel OOM line on the node that ran the Pod. Usage that climbs to the limit before each restart confirms Cause 1 and gives the floor for the new limit:

   ```bash
   kubectl top pod -n <namespace> <harbor-registry-pod> --containers
   journalctl -k --since "1 hour ago" | grep -iE 'out of memory|oom-kill|killed process'
   ```

3. Check whether the operator owns the values:

   ```bash
   kubectl -n <namespace> describe deploy <harbor-registry-deployment> | grep -A8 -E 'Limits|Requests'
   kubectl -n <namespace> get harbor <name> -o yaml | grep -n -E 'resourceAssign|GlobalAssign|LocalPath'
   ```

   `GlobalAssign` and a reverted Deployment edit are Cause 2.

4. If the restarting component is `harbor-nginx` rather than `harbor-registry`, see [harbor-nginx or portal does not start or keeps restarting: IP address family unsupported or OOMKilled](harbor-nginx_or_portal_does_not_start_or_keeps_restarting_IP_address_family_unsupported_or_OOMKilled.md). If nodes cannot pull images after a Docker-to-containerd switch (`dial tcp <registry-ip>:80: i/o timeout`), see [Image registry or Harbor unreachable or slow because of firewall rules, blocked ports, or the network path](Image_registry_or_Harbor_unreachable_or_slow_because_of_firewall_rules_blocked_ports_or_the_network_path.md) (Cause 6).

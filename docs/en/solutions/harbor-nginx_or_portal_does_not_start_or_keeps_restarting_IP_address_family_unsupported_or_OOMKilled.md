---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "3.12"
  - "4.2"
  - "4.3"
---

# harbor-nginx or portal does not start or keeps restarting: IP address family unsupported or OOMKilled

## Issue

The Harbor web entry point is down or unstable because the `harbor-nginx` Pod (and sometimes the portal Pod) does not become Ready or keeps restarting:

- `harbor-nginx` and the portal Pod never become Ready, and their logs contain `IP address family was unsupported`.
- `harbor-nginx` keeps restarting, and `kubectl describe pod` shows `Last State: Terminated, Reason: OOMKilled`. The Harbor service looks unstable even though `harbor-core` is up.

Related articles: [Harbor core service unavailable or internal server error, stuck instance status, or Pods cycling after an edit](Harbor_core_service_unavailable_or_internal_server_error_stuck_instance_status_or_Pods_cycling_after_an_edit.md).

## Root Cause

### Cause 1: Harbor requires IPv6 on a cluster where IPv6 is disabled

The Harbor resource is configured with IPv6 enabled, so nginx and the portal try to listen on IPv6. On a cluster where IPv6 is disabled, the listen fails with `IP address family was unsupported` and the Pods never become Ready. Setting the Harbor resource to IPv4 only, under `spec.helmValues.ipFamily`, fixes it.

### Cause 2: the harbor-nginx memory limit is too low

`harbor-nginx` exceeds its memory limit and is OOMKilled. A change made directly on the `harbor-nginx` Deployment is overwritten by the operator's sync unless the Deployment carries the annotation `skip-sync: "true"`. Adding that annotation and raising the memory limit to twice the original value stops the restarts.

## Resolution

### Cause 1

1. Confirm the error in the nginx and portal logs, and that the nodes are IPv4-only (see Diagnostic Steps). Save the current `ipFamily` block if one is set:

   ```bash
   NS=<harbor-namespace>
   NAME=<harbor-name>
   kubectl -n "$NS" get harbor "$NAME" -o jsonpath='{.spec.helmValues.ipFamily}{"\n"}'
   ```

2. Set IPv4 only.

   > **Warning:** Only when the nginx and portal logs say the IP address family is unsupported and the cluster is IPv4-only. Impact: the operator reconciles and restarts Harbor components. Precondition: a short maintenance window and the previous `ipFamily` values saved. Rollback: patch the previous values back; on an IPv4-only cluster they are the failing configuration, so roll back only when moving to a cluster that provides IPv6.

   ```bash
   kubectl -n "$NS" patch harbor "$NAME" --type=merge -p \
     '{"spec":{"helmValues":{"ipFamily":{"ipv6":{"enabled":false},"ipv4":{"enabled":true}}}}}'
   kubectl -n "$NS" get pods | grep -E 'nginx|portal'
   ```

3. Wait until the nginx and portal Pods are Ready and check that their logs no longer contain the address-family error.

### Cause 2

1. Confirm OOMKilled and read the current memory limit:

   ```bash
   NS=<harbor-namespace>
   kubectl -n "$NS" describe pod <harbor-nginx-pod> | grep -A3 'Last State'
   DEP=$(kubectl -n "$NS" get deploy -o name | grep harbor-nginx | head -1)
   kubectl -n "$NS" get "$DEP" -o jsonpath='{.spec.template.spec.containers[0].resources.limits.memory}{"\n"}'
   ```

2. Mark the Deployment so the operator does not overwrite it, and double the memory limit (`512Mi` becomes `1Gi`, `1Gi` becomes `2Gi`).

   > **Warning:** Only when `harbor-nginx` is OOMKilled. Impact: `skip-sync: "true"` stops the operator from syncing this Deployment, so later changes from the Harbor resource no longer reach it until the annotation is removed; the Pod restarts once with the new limit and may use twice the previous memory on its node. Precondition: the node has that much allocatable memory. Rollback: set the limit back to the printed value and remove the annotation (`kubectl -n "$NS" annotate "$DEP" skip-sync-`); removing only the annotation lets the operator restore the old limit and the OOMKilled loop.

   ```bash
   kubectl -n "$NS" annotate "$DEP" skip-sync="true" --overwrite
   kubectl -n "$NS" set resources "$DEP" --limits=memory=<twice-the-printed-limit>
   kubectl -n "$NS" rollout status "$DEP"
   ```

3. Watch the Pod. Another OOMKilled means doubling was not enough for that workload.

For other Harbor components, such as `harbor-registry`, the limit is set on the Harbor resource instead; see [harbor-registry is OOMKilled with exit code 137, or a resource change on its Deployment is reverted](harbor-registry_is_OOMKilled_with_exit_code_137_or_a_resource_change_on_its_Deployment_is_reverted.md).

## Diagnostic Steps

```bash
NS=<harbor-namespace>
kubectl -n "$NS" get pods -o wide | grep -E 'nginx|portal'
NGINX=$(kubectl -n "$NS" get pods -o name | grep harbor-nginx | head -1)
kubectl -n "$NS" logs "$NGINX" --tail=80
kubectl -n "$NS" describe "$NGINX" | grep -A3 'Last State'
```

| What you see | Cause |
| --- | --- |
| `IP address family was unsupported` in nginx or portal logs, Pods never Ready | Cause 1 |
| `harbor-nginx` restarts, `Last State` `OOMKilled` | Cause 2 |
| `harbor-notary-server` restarts with `certificate has expired`, or the portal says the core service is unavailable | Related article above |

To confirm the cluster is IPv4-only for Cause 1, check the node addresses; only IPv4 entries are expected:

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.addresses[*].address}{"\n"}{end}'
```

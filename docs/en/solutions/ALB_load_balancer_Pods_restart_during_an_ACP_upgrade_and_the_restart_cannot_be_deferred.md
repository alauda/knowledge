---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# ALB load balancer Pods restart during an ACP upgrade and the restart cannot be deferred

## Issue

During an ACP upgrade the LB (ALB) Pods restart automatically, and business traffic through the load balancer is interrupted while they restart. Application owners ask:

- Is the LB restart during the upgrade necessary?
- Can the upgrade skip the restart, so that the LB Pods are restarted by hand later, in a business downtime window?

The question usually comes up after a test upgrade or an earlier upgrade window, once the impact on business continuity has been noticed.

## Root Cause

### Cause 1: The LB restart is part of the ACP upgrade and cannot be avoided

- The LB Pod restart, and the network interruption it causes during the ACP upgrade, cannot be avoided.
- The restart cannot be skipped during the upgrade and replaced by a manual restart later.
- The upgrade has to be performed inside a maintenance window coordinated with the business owners.

This restart comes from upgrading the cluster that runs the LB. A different case is a business-cluster ALB that rolls while only `global` is upgraded, because its Deployment no longer matches the HelmRequest on `global`. That drift-induced restart can be removed before the next global upgrade (see "Local overrides reverted or blocking an ACP upgrade: ResourcePatch, ALB ConfigMap, chart and feature gate changes", Cause 8), but removing it does not remove the restart described here.

## Resolution

### Cause 1: The LB restart is part of the ACP upgrade and cannot be avoided

Treat the LB interruption as an expected part of the upgrade and plan for it:

1. Agree on a maintenance window with the business owners before the upgrade. Tell them that traffic through the LB is interrupted while its Pods restart, for every domain and port served by those ALBs.
2. Inventory the ALB instances on the cluster being upgraded and the Pods behind each one, so the owners of every entry point can be notified.
3. Back up each `alb2` object and any overwrite ConfigMap before the upgrade, so custom nginx settings stay recoverable.
4. Agree how the interruption will be measured (for example with the probe loop in Diagnostic Steps), so the window can be closed on evidence.
5. Run the upgrade inside that window. There is no supported option to skip the LB restart and do it by hand afterwards.
6. After the upgrade, confirm that every ALB Pod is Running and Ready on the new image, and that custom settings are still rendered, before reopening business traffic.

Read-only commands for the inventory and the post-upgrade check:

```bash
kubectl get alb2.v2beta1.crd.alauda.io -A
kubectl -n <alb-namespace> get alb2.v2beta1.crd.alauda.io <alb-name> -o yaml > <alb-name>-alb2.yaml
kubectl -n <alb-namespace> get deploy,pods -o wide | grep <alb-name>
kubectl -n <alb-namespace> get pods -l service_name=alb2-<alb-name> \
  -o custom-columns=NAME:.metadata.name,START:.status.startTime,IMAGES:.spec.containers[*].image
```

If an ALB port conflict exists before the window, clear it first; otherwise the restart that the upgrade performs fails.

## Diagnostic Steps

1. Identify which cluster is being upgraded and on which cluster the restarted LB runs.
2. If the LB runs on the cluster being upgraded, this article applies: the restart is expected and cannot be deferred.
3. If the LB runs on a business cluster that was not being upgraded (only `global` moved), compare its Deployment with the HelmRequest on `global`; that is the drift case, not this one:

   ```bash
   kubectl get helmrequests.app.alauda.io -A
   ```

4. If the LB did not come back after the upgrade restarted it, check for an ALB port conflict.

During the upgrade, watch the ALB Pods restart and note when each one is Ready again:

```bash
kubectl -n <alb-namespace> get pods -l service_name=alb2-<alb-name> -w
```

Measure the interruption from a client outside the cluster with a probe against one business URL:

```bash
while true; do
  printf '%s ' "$(date +%T)"
  curl -sk -o /dev/null -m 3 -w '%{http_code}\n' https://app.example.com/<health-path> || echo fail
  sleep 1
done
```

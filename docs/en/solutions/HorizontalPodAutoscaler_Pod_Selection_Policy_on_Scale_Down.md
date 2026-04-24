---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

A common operator question for the Horizontal Pod Autoscaler: when the controller decides to shrink a workload, *which* pods does it remove? The expectation is sometimes that the oldest pods will be evicted first, on the theory that they have accumulated the most state, the most leaked memory, or the most ambient drift since the rollout. The actual behaviour is the opposite, and that behaviour cannot be tuned through the HPA's own API.

## Root Cause

The HPA controller does not pick pods directly. It writes a new `replicas` count onto the target's scale subresource (Deployment, StatefulSet, or a custom resource that exposes `/scale`) and the workload controller selects which pods to delete. For a Deployment, the ReplicaSet controller is the deletion gatekeeper, and it ranks candidate pods using a deterministic ordering:

1. Unassigned (no `nodeName`) before assigned.
2. `Pending`/`Unknown` phase before `Running`.
3. Not-ready before ready.
4. Lower pod-deletion-cost annotation before higher.
5. Higher container restart count before lower.
6. **Newer pods (by creation timestamp) before older.**
7. Older pods (in case of an exact tie on every other key).

Step 6 is the one that matters here. Newer replicas are removed first because they have presumably absorbed less of the workload's runtime state and are cheaper to discard. The HPA itself has no scale-down `policies` field that exposes "drop oldest first" — `behavior.scaleDown.policies` only controls the *rate* of scale-down (per-second or per-percent), not the per-pod ordering.

## Resolution

Treat scale-down ordering as a property of the controller that owns the pods, not of the autoscaler:

- **Influence ordering with the deletion-cost annotation.** The ReplicaSet controller respects `controller.kubernetes.io/pod-deletion-cost` (a signed 32-bit integer) when picking which pod to drop. Setting a *lower* cost on the pods that should be removed first reverses the default newer-first behaviour without touching the HPA.

  ```bash
  kubectl annotate pod <oldest-pod> \
    controller.kubernetes.io/pod-deletion-cost=-100 --overwrite
  ```

  An admission webhook or sidecar can stamp this annotation continuously based on pod age, runtime state, or any other signal the operator cares about.

- **Use a workload controller that exposes ordering controls when ordering is load-bearing.** For example, a `StatefulSet` always deletes pods in reverse ordinal order; this is intentional and forms part of the contract. If the workload truly needs deterministic "oldest first" eviction, model it as a StatefulSet rather than a Deployment.

- **Tune scale-down rate, not target pods, through the HPA.** When the goal is to slow down churn (rather than to choose specific pods), set `spec.behavior.scaleDown.policies` to cap the percentage or absolute number of pods removed per stabilisation window:

  ```yaml
  apiVersion: autoscaling/v2
  kind: HorizontalPodAutoscaler
  metadata:
    name: app
  spec:
    scaleTargetRef:
      apiVersion: apps/v1
      kind: Deployment
      name: app
    minReplicas: 2
    maxReplicas: 10
    behavior:
      scaleDown:
        stabilizationWindowSeconds: 300
        policies:
          - type: Percent
            value: 25
            periodSeconds: 60
    metrics:
      - type: Resource
        resource:
          name: cpu
          target:
            type: Utilization
            averageUtilization: 70
  ```

  This caps removal at 25% of the current pod set per minute and waits 5 minutes after the metric falls before scaling down at all — buying time for genuine traffic patterns rather than reacting to a single low-load sample.

- **Question the requirement.** If "remove the oldest first" is a workaround for a memory leak or accumulated state, the more stable fix is to harden the application (bounded caches, periodic restart via `lifecycle.preStop` + a `livenessProbe`, or a CronJob that performs rolling restarts). Co-opting the autoscaler to mask leaky state usually trades one problem for another.

## Diagnostic Steps

Confirm the HPA decisions and the ordering applied by the ReplicaSet:

```bash
kubectl describe hpa <hpa-name>
kubectl get rs -l app=<label> -o wide
kubectl get pod -l app=<label> --sort-by=.metadata.creationTimestamp
```

Cross-reference the pods that were deleted (`kubectl get events --field-selector involvedObject.kind=Pod | grep Killing`) against their creation timestamps. Newer-first deletion is the default and is **not** a bug.

If a deletion-cost annotation is in use, verify it is applied to every pod that should be biased and that the value range is sensible:

```bash
kubectl get pod -l app=<label> -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.controller\.kubernetes\.io/pod-deletion-cost}{"\n"}{end}'
```

Pods missing the annotation default to a cost of 0 and are ordered by the standard tiebreakers — including the newer-first rule.

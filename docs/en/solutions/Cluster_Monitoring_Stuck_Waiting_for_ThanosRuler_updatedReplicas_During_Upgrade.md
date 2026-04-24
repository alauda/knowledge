---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A platform upgrade stalls in the monitoring component. The cluster's monitoring operator goes `Available=False / Progressing=True / Degraded=True` and remains there until the rollout times out. The condition message points squarely at the user-workload `ThanosRuler` resource:

```text
status:
  conditions:
    - lastTransitionTime: "2026-02-26T07:08:09Z"
      message: 'UpdatingUserWorkloadThanosRuler: waiting for ThanosRuler object
                changes failed: waiting for Thanos Ruler
                <ns>/<name>: context deadline exceeded:
                expected 2 replicas, got 0 updated replicas'
      reason:  UpdatingUserWorkloadThanosRulerFailed
      status:  "False"
      type:    Available
```

`kubectl get pods` shows the `thanos-ruler-*` pods are running and ready. The Prometheus Operator that owns the `ThanosRuler` CRD is healthy. Reading the `ThanosRuler` status subresource reveals the contradiction:

```text
"replicas": 2,
"unavailableReplicas": 0,
"updatedReplicas": 0
```

`replicas=2`, `unavailableReplicas=0`, `updatedReplicas=0`. The pods are up and serving, but the controller's status field has never recorded the most recent rollout, so the upstream operator that watches the resource — the cluster monitoring operator — never sees the `updatedReplicas=replicas` signal it requires to mark the upgrade step complete.

## Root Cause

The `ThanosRuler` CRD is owned by Prometheus Operator. Its controller maintains the `.status` subresource through two cooperating paths:

1. The **change handler** updates status synchronously when it observes a spec or pod-state change (rollout in progress, pod becomes ready, etc.).
2. A **periodic reconciler** polls all managed objects and refreshes status when any of the per-resource conditions are not `True`. This is the safety net: even if a change event is missed, the periodic loop will eventually catch up.

The race observed here is that the rollout completed cleanly — every `thanos-ruler-*` pod reached `Ready` — but the change handler did not write the final `updatedReplicas=N` update before the periodic reconciler took its measurement. By the time the periodic loop ran, **all** managed conditions on the resource were already green, so the periodic loop's "skip if everything is healthy" optimisation kicked in and it did **not** rewrite status. The `updatedReplicas` field was therefore left at its prior value (`0`) indefinitely. From the cluster monitoring operator's perspective, the `ThanosRuler` rollout has been "stuck" since the upgrade began.

This is a known [upstream Prometheus Operator issue](https://github.com/prometheus-operator/prometheus-operator/issues) — the periodic reconciler should either always run or should be conditional on `updatedReplicas != replicas` rather than on the resource's overall health. Until that is fixed, the operational fix is to nudge the controller into running its change handler again, which causes status to be rewritten correctly.

Alauda Container Platform's monitoring surface (`observability/monitor`) bundles the same upstream Prometheus Operator and uses `ThanosRuler` for user-workload rule evaluation, so the same race can manifest the same way during platform upgrades.

## Resolution

Two equivalent triggers force the Prometheus Operator's change handler to run on the `ThanosRuler` object. Pick whichever has lower workload impact.

### Option 1 — Add and remove an annotation (least disruptive, preferred)

Annotation changes are observed by the watch as a generation-bumping spec event; they cause the controller to reconcile and rewrite status. They do **not** trigger a pod rollout, so user-workload rule evaluation is uninterrupted.

```bash
kubectl -n <user-workload-monitoring-namespace> annotate thanosruler <name> nudge=true
kubectl -n <user-workload-monitoring-namespace> annotate thanosruler <name> nudge-
```

Within a few seconds, re-read the status subresource and confirm `updatedReplicas` now equals `replicas`:

```bash
kubectl -n <user-workload-monitoring-namespace> get thanosruler <name> \
  -o jsonpath='{.status}' | jq
```

The cluster monitoring operator's `Available` condition should flip back to `True` shortly after, and the upgrade resumes:

```bash
kubectl get co monitoring
```

### Option 2 — Delete one of the ruler pods

Removing a single `thanos-ruler-*` pod forces a rollout step, which runs the change handler again. This is heavier (it pulls the deleted pod's slice of recording-rule evaluation onto its peer for the time it takes to recreate, briefly increasing the load on the surviving replica) and is the second-line option:

```bash
kubectl -n <user-workload-monitoring-namespace> delete pod <thanos-ruler-pod-0>
```

Watch the StatefulSet rebuild the pod and the status subresource update, then verify the cluster monitoring operator returns to `Available=True`.

### After recovery

The race itself is innocuous once unstuck — the rule evaluation never paused, only the status reporting did. There is no data loss. The upgrade can proceed normally from this point.

If the same upgrade restalls on the same resource later (next maintenance window, next minor bump), the periodic reconciler is still racing the change handler on this cluster. Re-applying Option 1 each time is the operational workaround until the upstream fix lands.

### Don't do this

- **Do not** re-create the `ThanosRuler` from scratch. The Prometheus Operator owns the resource through the rendered configuration of the monitoring stack — deleting it will be re-created by the operator with the same name and the same race window, *plus* a real interruption of rule evaluation while the new instance comes up.
- **Do not** scale the `ThanosRuler` replicas to zero and back up. Same reasoning: the rule-evaluation gap is real and the underlying race is unaffected.
- **Do not** disable user-workload monitoring to "skip" the upgrade step. That hides the symptom and leaves the cluster in a state where re-enabling user-workload monitoring later will hit the same condition.

## Diagnostic Steps

1. Confirm the cluster monitoring operator is the blocker and read the exact condition:

   ```bash
   kubectl get co monitoring
   kubectl get co monitoring -o jsonpath='{.status.conditions}' | jq
   ```

   The signature is `Available=False`, `Progressing=True`, `Degraded=True`, with a message that names a specific `ThanosRuler` and includes `expected N replicas, got M updated replicas` where `M < N`.

2. Read the `ThanosRuler` status subresource and confirm the inconsistency — pods report ready but `updatedReplicas` lags:

   ```bash
   kubectl -n <user-workload-monitoring-namespace> get thanosruler <name> \
     -o jsonpath='{.status}' | jq
   ```

3. Sanity-check the actual pods. They should be `Running` and `Ready=True` even though the controller status disagrees:

   ```bash
   kubectl -n <user-workload-monitoring-namespace> get pods -l app.kubernetes.io/name=thanos-ruler
   ```

4. Apply Option 1 (the annotation nudge), then re-read status. Within a few seconds:

   ```bash
   kubectl -n <user-workload-monitoring-namespace> annotate thanosruler <name> nudge=true
   kubectl -n <user-workload-monitoring-namespace> annotate thanosruler <name> nudge-
   sleep 5
   kubectl -n <user-workload-monitoring-namespace> get thanosruler <name> \
     -o jsonpath='{.status}' | jq '.replicas, .updatedReplicas'
   ```

   `updatedReplicas` should now equal `replicas`.

5. Confirm the cluster monitoring operator follows. The `Available` condition flips to `True` once the operator's reconcile sees the corrected `ThanosRuler` status:

   ```bash
   kubectl get co monitoring -w
   ```

6. If the operator does not recover within a minute, the issue is something else — re-read the operator condition message; a new failure (e.g. another component) may have appeared once the `ThanosRuler` blocker cleared.

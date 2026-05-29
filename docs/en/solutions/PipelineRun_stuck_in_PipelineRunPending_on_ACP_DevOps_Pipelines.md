---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500772
---

# PipelineRun stuck in PipelineRunPending on ACP DevOps Pipelines

## Issue

On Alauda Container Platform with the Alauda DevOps Pipelines operator (the platform-catalog `tektoncd-operator` bundle, version `v4.2.0`, `TektonConfig config` Ready at `v0.76.0-c46274a`), a `PipelineRun` that was created with `spec.status: PipelineRunPending` does not begin execution: its `.status.conditions` reports `reason: PipelineRunPending`, message `PipelineRun "<name>" is pending`, and no `TaskRun` is materialised for any of the pipeline's tasks while the gate is in place. The Pending PipelineRun's event stream is limited to the controller's bookkeeping (`Started`, `FinalizerUpdate`) — no scheduling, Pod, or TaskRun events appear until the pending state is cleared.

## Root Cause

`spec.status: PipelineRunPending` is the upstream Tekton mechanism for creating a PipelineRun in a "paused" state. The Tekton controller honours the gate by leaving the PipelineRun in its initial `PipelineRunPending` reason and refusing to materialise any `TaskRun` until `spec.status` is removed or the user re-submits a fresh PipelineRun without the gate. On ACP DevOps Pipelines the gate is implemented identically to upstream — the same controller image ships in the operator bundle and the `pipelineruns.tekton.dev` CRD validates and stores the field.

A PipelineRun can become stuck in this state when something else (an external watcher, a CI integration, or a Git-triggered controller) created the PipelineRun with `spec.status: PipelineRunPending` and then failed to clear the gate — for example because of an API timeout or a controller restart between the create call and the planned clear. From the operator's point of view there is nothing to reconcile: the PipelineRun is sitting in exactly the state Tekton's API contract requires for `PipelineRunPending`, so no `TaskRun` will appear until the gate is removed by hand.

## Resolution

Two interchangeable recovery paths apply, both proven on the running operator.

**Patch the affected PipelineRun to drop the pending gate.** Removing `.spec.status` with a JSON-patch causes the Tekton controller to pick the PipelineRun up on the next reconcile, transition its `Ready` condition to `Running`, and create the `TaskRun`s for its tasks:

```bash
kubectl patch pipelinerun <name> -n <namespace> \
  --type=json -p='[{"op":"remove","path":"/spec/status"}]'
```

After the patch, `kubectl get pipelinerun <name>` shows `spec.status` empty, the aggregate condition flips from `PipelineRunPending` to `Running`, and `kubectl get taskrun -n <namespace>` lists a TaskRun per task within a few seconds. The patch only clears the gate — it does not affect the pipeline definition, parameters, workspaces, or any owner references on the PipelineRun, so the run that proceeds is the same one whose history was already wired up by whoever submitted it.

**Manually re-submit the run.** If the stuck PipelineRun cannot be patched in place (for example its spec has already been observed by downstream tooling), creating a fresh PipelineRun for the same pipeline — without `spec.status: PipelineRunPending` — starts execution immediately: a `TaskRun` for the new run is created, the pod is scheduled, and the new PipelineRun progresses to its terminal condition independently of the original Pending PipelineRun, which stays paused until it too is patched or deleted.

In a parallel test on the operator, a fresh PipelineRun submitted alongside a still-Pending PipelineRun ran to a terminal `Ready=False` while the Pending PipelineRun's `.spec.status` remained `PipelineRunPending` and no `TaskRun` was ever created for it. Whichever path is used, the run that proceeds does not require any change to the pipeline definition, the cluster, or the operator's configuration — the recovery is purely on the PipelineRun resource.

## Diagnostic Steps

Confirm the PipelineRun is sitting on the upstream pending gate and not on some other Tekton condition:

```bash
kubectl get pipelinerun <name> -n <namespace> \
  -o jsonpath='{.spec.status}{" / "}{.status.conditions[*].reason}{" / "}{.status.conditions[*].message}{"\n"}'
```

The gate's exact signature is `spec.status: PipelineRunPending` combined with a `.status.conditions[*].reason` of `PipelineRunPending` and a message of the form `PipelineRun "<name>" is pending`. Any other condition reason (`Running`, `Failed`, `TaskRunImagePullFailed`, `Cancelled`, ...) is a different problem — the JSON-patch below only addresses runs that are still paused on the pending gate.

Confirm no `TaskRun` has been created for the pipeline's tasks (the second symptom from the issue): a paused PipelineRun never schedules its tasks, so `get taskrun` filtered by the PipelineRun's label returns no rows:

```bash
kubectl get taskrun -n <namespace> \
  -l tekton.dev/pipelineRun=<pipelinerun-name>
```

When the gate is in place the result is `No resources found in <namespace> namespace.`. Inspect the event stream for the same scope to confirm the controller has not given up — only the bookkeeping events (`Started`, `FinalizerUpdate`) should be present for a Pending PipelineRun:

```bash
kubectl get events -n <namespace> \
  --field-selector involvedObject.kind=PipelineRun,involvedObject.name=<name>
```

After the JSON-patch (or after manually re-submitting), re-run the same `get pipelinerun` and `get taskrun` commands to confirm the gate is gone, `.status.conditions[*].reason` has moved to `Running`, and a `TaskRun` per task has been created.

## Notes

- The pending-gate mechanism (`spec.status: PipelineRunPending`) and the JSON-patch recovery (`--type=json -p='[{"op":"remove","path":"/spec/status"}]'`) are upstream Tekton and work the same on the ACP operator bundle — `tektoncd-operator.v4.2.0`, `TektonConfig` at `v0.76.0-c46274a` — as they do on a vanilla Tekton install.
- This article covers the generic Pending-PipelineRun recovery. It does not cover Git-event-trigger watchers or per-repository queue managers that submit PipelineRuns with the pending gate on the user's behalf — those components are not part of the default `TektonConfig` install profile on the bundle tested here, and any queue-level "unsticking" behavior they may add belongs to that component's documentation rather than to the generic PipelineRun gate.

## Evidence

- ev:c1 — A PipelineRun created with `spec.status: PipelineRunPending` on the ACP DevOps Pipelines operator stays paused: `.spec.status` remains `PipelineRunPending`; `.status.conditions[*].reason=PipelineRunPending`; `.status.conditions[*].message='PipelineRun "pending-test" is pending'`.
- ev:c3 — While the gate is in place, `kubectl get taskrun -n <ns>` returns `No resources found`, and the only events emitted for the PipelineRun are `Started` and `FinalizerUpdate` — no scheduling or pod events.
- ev:c6 — A re-submitted PipelineRun (no `spec.status`) ran to a terminal state and produced a TaskRun; the parallel original PipelineRun with `spec.status=PipelineRunPending` stayed paused with no TaskRun.
- ev:c7 — `kubectl patch pipelinerun pending-test --type=json -p='[{"op":"remove","path":"/spec/status"}]'` cleared the gate; `.spec.status` became empty, `.status.conditions[*].reason` flipped to `Running`, and a TaskRun `pending-test-hello` was created within 5s.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A PipelineRun created in response to a Git event (push, pull-request open, comment) through Tekton **Pipelines-as-Code (PAC)** lands in the cluster with `spec.status: PipelineRunPending` and never advances. Symptoms:

- `kubectl get pipelinerun -n <ns>` shows the PipelineRun in `PipelineRunPending` reason; no `Succeeded` condition is set yet.
- No child `TaskRun` objects are created and no Tekton events are recorded against the PipelineRun.
- Manually re-submitting the same payload, or starting the PipelineRun by hand from the platform UI, kicks it into `Running` immediately and it completes normally.

The queue can stay wedged: while the first PAC PipelineRun for a repository is stuck pending, subsequent Git events for that same repository pile up behind it.

## Root Cause

The PAC watcher is the component that admits PipelineRuns into execution for a given repository. It does this by clearing the `spec.status: PipelineRunPending` marker once it has confirmed the PipelineRun is the next eligible candidate for that repository's queue. When the API server is slow or returns a transient error during that admission step, the watcher's status patch fails and is not retried aggressively enough; the PipelineRun stays in `PipelineRunPending` indefinitely, and the watcher's view of "what is admitted right now" no longer matches reality. Subsequent events for the same repository remain queued behind a PipelineRun that no controller will ever start.

This is a defect in the watcher's admission path rather than a Tekton-core bug — Tekton Pipelines itself honours the `PipelineRunPending` contract correctly; the watcher just never asks it to release.

## Resolution

ACP delivers Tekton through the **`devops`** capability area. PAC is part of that bundle. Until the watcher carries a fix for the lost-update path, manual remediation is the only way to unstick a queue.

### Preferred: clear the pending marker on the affected PipelineRun

The `PipelineRunPending` semantics say: if `spec.status` is unset (or set to anything other than `PipelineRunPending`), the controller is allowed to start the run. Removing the field is therefore enough to release a single stuck PipelineRun. Use a JSON-patch `remove` so the operation is idempotent and does not race with other writers:

```bash
NS=<namespace>
PR=<pipelinerun-name>

kubectl -n "$NS" patch pipelinerun "$PR" \
  --type=json \
  -p='[{"op": "remove", "path": "/spec/status"}]'
```

Within a few seconds the PipelineRun should transition to `Running` and the corresponding `TaskRun` objects should appear:

```bash
kubectl -n "$NS" get pipelinerun "$PR" -o jsonpath='{.status.conditions[].reason}{"\n"}'
kubectl -n "$NS" get taskrun -l tekton.dev/pipelineRun="$PR"
```

If multiple PipelineRuns for the same repository are pending, repeat the patch on each in chronological order (oldest first) — releasing them out of order can confuse the watcher's queue accounting and re-trigger the wedge.

### Fallback: re-create the PipelineRun from the captured manifest

Some installations restrict who may patch PipelineRun objects in PAC namespaces. In that case, scrape the spec, delete the stuck PipelineRun, and re-apply without `spec.status`:

```bash
kubectl -n "$NS" get pipelinerun "$PR" -o yaml \
  | yq 'del(.metadata.uid, .metadata.resourceVersion, .metadata.creationTimestamp,
            .metadata.generation, .status, .spec.status)' \
  > /tmp/pr.yaml

kubectl -n "$NS" delete pipelinerun "$PR"
kubectl apply -f /tmp/pr.yaml
```

This produces a fresh PipelineRun with the same spec but no admission marker, so the controller picks it up immediately. Note that this loses the original PAC correlation labels (the `pipelinesascode.tekton.dev/*` annotations linking the run back to the Git event) — manual re-creation should be a workaround, not standard practice.

### Operational mitigation

While the watcher fix is rolling out:

- **Alert on stuck pending PipelineRuns.** A simple Prometheus alert covers the case: `count(pipelinerun_pending{reason="PipelineRunPending"} > 0) by (namespace) > 0` for more than a few minutes is almost always a stuck queue.
- **Bound the queue length per repository.** PAC's `max-keep-runs` and concurrency settings on the `Repository` CR limit how many runs accumulate for one repo, which in turn limits how much fan-out a single wedge causes.
- **Drain the queue when re-running.** If repeated PipelineRuns for the same repo are pending, batch-list them and re-apply the patch in a loop rather than retriggering Git events, which only adds to the backlog.

## Diagnostic Steps

Confirm the PipelineRun is actually pending (and not failed or queued behind a missing dependency):

```bash
kubectl -n "$NS" get pipelinerun "$PR" -o jsonpath='{.spec.status}{"\n"}'
kubectl -n "$NS" get pipelinerun "$PR" -o jsonpath='{.status.conditions}{"\n"}' | jq .
```

A genuine wedge shows `spec.status: PipelineRunPending` and no `Succeeded` condition. If `spec.status` is empty but the PipelineRun is still not running, the issue is upstream of the watcher — check the PipelineRun's `status.conditions` for resolver or parameter errors instead.

Check the PAC watcher itself for the root admission failure (this is the smoking gun the patch above is working around):

```bash
kubectl -n tekton-pipelines logs deployment/pipelines-as-code-watcher --tail=200 \
  | grep -E "patch|conflict|timeout"
```

Repeated `Conflict` or `context deadline exceeded` errors on PipelineRun status patches confirm the API-server-slow / lost-update window. If the watcher is otherwise healthy, the patch fix above resolves the immediate symptom and the queue resumes draining. If the watcher logs are full of conflicts, also investigate API-server load and webhook latency on the cluster — the watcher is a symptom there, not the cause.

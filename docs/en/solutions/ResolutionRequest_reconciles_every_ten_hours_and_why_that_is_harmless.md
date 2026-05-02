---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# ResolutionRequest reconciles every ten hours — and why that is harmless
## Overview

A long-lived PipelineRun has a `ResolutionRequest` resource attached — that is the object the remote resolver creates to resolve a Pipeline reference (a git URL, a bundle, a hub reference) into the actual Pipeline definition. Operators sometimes notice the resolver pod waking up against very old `ResolutionRequest` objects on a regular cadence, and ask whether that interval can be raised (for example to 24 hours) to cut log noise.

This article explains why the resolver re-reconciles old objects, why the interval is not user-tunable like the Pipelines controller's `default-resync-period`, and why the answer in practice is "leave it alone".

## The behaviour

The ResolutionRequest reconciler runs inside each remote resolver pod (git, hub, bundles, cluster, etc., shipped together with the Pipelines runtime). Like every Knative-style controller it sets a *resync period* — a wall-clock interval after which the controller re-walks all objects of its kind even if nothing has changed. For the resolver pods that period is fixed at the framework default (around ten hours) and is **not** exposed as a flag the way the Pipelines controller's resync interval is. Setting it to 24 hours from outside is therefore not possible without modifying the resolver image.

The wake-up is what shows up in operator monitoring: every ten hours, the resolver iterates its existing `ResolutionRequest` objects — including ones from PipelineRuns that finished days or weeks ago.

## Why the resync is a NO-OP for completed requests

The reconciler short-circuits as the very first thing it does. The shape of the entry point in the resolver is:

```go
// ReconcileKind processes updates to ResolutionRequests, sets status
// fields on it, and returns any errors experienced along the way.
func (r *Reconciler) ReconcileKind(
        ctx context.Context, rr *v1beta1.ResolutionRequest,
) reconciler.Event {
    if rr == nil {
        return nil
    }
    if rr.IsDone() {
        return nil
    }
    // ...real work only happens for in-flight requests...
}
```

`IsDone()` is true once the request has either resolved successfully or recorded a terminal failure. Every old `ResolutionRequest` from a finished run satisfies that condition. So when the ten-hour resync fires:

- A no-op return for every completed request.
- No git fetch, no hub call, no bundle pull. No external traffic, no rate-limit pressure.
- A handful of CPU cycles per object on the resolver pod and an entry in its activity log.

The only `ResolutionRequest` objects that do real work in a resync are the ones whose original reconcile *missed* — never reached `Done` because the controller died, the pod restarted, or a transient API error left the request unfinished. The resync is precisely the failsafe that closes those gaps.

## What this means in practice

- There is no need to lower the cadence to 24 hours. The cost of the ten-hour pass is dominated by the in-flight requests, of which there are usually zero or close to zero on a steady cluster.
- Log noise from the resolver waking up can be filtered with a log-collector rule rather than by changing the controller behaviour. The events are predictable and harmless.
- If the resolver is genuinely doing work every cycle (real git/bundle fetches every ten hours), the issue is **not** the resync — it is `ResolutionRequest` objects that never reach `Done`. Investigate those objects directly:

  ```bash
  kubectl get resolutionrequest -A \
    -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,DONE:.status.conditions[?(@.type=="Succeeded")].status,REASON:.status.conditions[?(@.type=="Succeeded")].reason
  ```

  Anything where the `Succeeded` condition is missing, `Unknown`, or has been `False` for hours is a candidate for the failsafe path. Either fix the underlying resolver problem (git auth, hub reachability, bundle digest mismatch) or delete the stale `ResolutionRequest` and let the PipelineRun re-create it.

## Cleaning up stale ResolutionRequests

`ResolutionRequest` objects are owner-referenced from their PipelineRun, so deleting the PipelineRun deletes them. A retention policy on PipelineRuns (via the Pipelines pruning controller or a CronJob) keeps the resolver's working set small and removes the resync log noise as a side effect:

```bash
# delete completed PipelineRuns older than 30 days; ResolutionRequests follow
kubectl get pr -A -o json \
  | jq -r '.items[]
      | select(.status.completionTime?
               and (.status.completionTime | fromdateiso8601 < (now - 30*24*3600)))
      | "\(.metadata.namespace) \(.metadata.name)"' \
  | xargs -L1 kubectl -n
```

(Use the cluster's existing retention mechanism if there is one — the snippet above is illustrative.)

## Bottom line

The ten-hour resync on `ResolutionRequest` is a framework-level failsafe that returns immediately for completed requests. Raising it to 24 hours would only make the failsafe slower; it would not save any meaningful work, because there is no work to save in the steady state. Operators who want to suppress the wake-up logs should filter at the log layer or shrink the working set with a PipelineRun retention policy.

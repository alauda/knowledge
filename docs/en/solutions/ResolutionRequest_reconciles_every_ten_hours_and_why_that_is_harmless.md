---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# ResolutionRequest reconciles every ten hours and why that is harmless

## Issue

On Alauda Container Platform (kube `v1.34.5-1`) with the Alauda DevOps Pipelines operator installed (tektoncd-operator `v4.2.0`, TektonConfig `v0.76.0-c46274a` Ready), a `ResolutionRequest` (`resolution.tekton.dev/v1beta1`) that was completed days or weeks ago still shows up in the remote-resolvers controller log being reconciled roughly every ten hours, even when the `PipelineRun` that owns it is long-finished. The natural question is whether that periodic wake-up does anything — and whether the interval can be raised (for example to 24 hours) to quieten it.

## Root Cause

The ten-hour cadence is not a `ResolutionRequest`-specific setting. The Tekton remote-resolvers controller is built on the knative `controller` framework, whose `DefaultResyncPeriod` is the literal constant `10 * time.Hour`; the resolvers binary `cmd/resolvers/main.go` does not call `controller.WithResyncPeriod`, so its informer inherits that framework default verbatim and re-lists every `ResolutionRequest` on that interval. Because the cadence lives in the framework default and is not surfaced as an env var, container flag, or ConfigMap key on the resolvers `Deployment`, there is no first-class knob exposed by the controller to change the interval per-request or globally — on lab-base the live `deploy/tekton-pipelines-remote-resolvers` carries env names `{ARTIFACT_HUB_API, CONFIG_FEATURE_FLAGS_NAME, CONFIG_LEADERELECTION_NAME, CONFIG_LOGGING_NAME, CONFIG_OBSERVABILITY_NAME, KUBERNETES_MIN_VERSION, METRICS_DOMAIN, PROBES_PORT, SYSTEM_NAMESPACE, TEKTON_HUB_API}` with an empty `args` list, none of which name a resync period.

The reconcile of an already-resolved `ResolutionRequest` is structurally a no-op. The upstream `ReconcileKind` in `pkg/reconciler/resolutionrequest/resolutionrequest.go` returns immediately when `rr.IsDone()` is true (i.e. the `Succeeded` condition is no longer `Unknown`), so once a request has been resolved the periodic wake-up never re-enters the resolver code path — it exists only as a failsafe so the controller can recover any update its informer might have missed.

## Resolution

Leave the ten-hour cadence in place. Because the wake-up of a completed `ResolutionRequest` returns immediately from `ReconcileKind`, the periodic reconcile costs nothing measurable — on lab-base the post-resolution settle reconcile and an annotate-triggered re-reconcile of the same `ResolutionRequest` were observed at `duration=0.000030088` and `duration=0.000122599` (sub-millisecond) respectively, with no API-server write to the object. There is no per-`ResolutionRequest` lifetime knob worth tuning here, and the controller-side knob that would raise the framework default to twenty-four hours is not exposed by the resolvers binary.

To confirm the no-op shape on a specific cluster, force a fresh reconcile of a completed `ResolutionRequest` by annotating it (so the work-queue picks it up without waiting for the ten-hour resync), then read the resolvers controller log for the same `knative.dev/key`; the `Reconcile succeeded` line for that key should report a sub-millisecond `duration` field on the second and subsequent reconciles, which is the live signature of the `IsDone()` short-circuit on this cluster.

## Diagnostic Steps

List the `ResolutionRequest` objects on the cluster and pick one whose `SUCCEEDED` column is `True` — that is one where `IsDone()` is true and the periodic reconcile is a no-op:

```bash
kubectl get resolutionrequest -A
```

Read its `Succeeded` condition to confirm the resolver has finished with it:

```bash
kubectl -n <ns> get resolutionrequest <name> \
  -o jsonpath='{.status.conditions[*]}{"\n"}'
```

Tail the remote-resolvers controller log for that request's reconcile entries; entries are keyed by `knative.dev/key=<ns>/<rr-name>` and carry a `duration` field in seconds:

```bash
kubectl -n tekton-pipelines logs deploy/tekton-pipelines-remote-resolvers --tail=200 \
  | grep '<ns>/<rr-name>'
```

Force a fresh reconcile without waiting ten hours by annotating the request (any annotation change re-queues it); the next log entry for the same key should show a sub-millisecond `duration`, which is the live observable signature of the `IsDone()` short-circuit:

```bash
kubectl -n <ns> annotate resolutionrequest <name> \
  kb.resync/poke="$(date +%s)" --overwrite
```

If the `duration` field for that key is sub-millisecond and the request's `resourceVersion` and `Succeeded` condition do not change across the wake-up, the periodic ten-hour resync is doing exactly what the upstream code prescribes — running the framework's failsafe re-list and exiting without work — and no tuning is required.

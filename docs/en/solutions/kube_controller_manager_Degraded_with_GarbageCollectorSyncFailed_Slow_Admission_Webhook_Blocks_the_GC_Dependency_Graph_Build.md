---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The cluster's `kube-controller-manager` reports a degraded condition continuously, with an alert named `GarbageCollectorSyncFailed` firing:

```text
kube-controller-manager  True False True  GarbageCollectorDegraded: alerts firing: GarbageCollectorSyncFailed
```

The garbage collector itself is still active — pods with `DeletionTimestamp` eventually finalise, orphaned objects get cleaned up. But on the control-plane status view the alert never clears. Controller-manager logs repeat:

```text
E0122 13:36:34.998039 1 shared_informer.go:316] "Unhandled Error"
  err="unable to sync caches for garbage collector" logger="UnhandledError"
E0122 13:36:34.999234 1 garbagecollector.go:268] "Unhandled Error"
  err="timed out waiting for dependency graph builder sync during GC sync (attempt 10730)"
```

The attempt counter grows without bound (`attempt 10730` in this excerpt).

## Root Cause

The garbage collector in `kube-controller-manager` runs a **dependency-graph builder** that maintains a live view of owner-reference relationships across every API resource in the cluster. On startup and on every re-sync it must list every object of every resource kind — concretely, it issues a `list` on every Group/Version/Resource and waits for the response. When the graph is complete the GC proceeds; if the list for any resource does not complete within the sync timeout, the collector aborts that cycle and tries again.

Two failure modes cause the timeout:

1. **Very large total API object count.** A cluster with tens of thousands of CRDs and custom resources genuinely takes long enough to list that the per-cycle budget is exceeded. This is a capacity limit; the fix is either to reduce the CR fleet or to raise per-GC timeouts on the controller-manager.

2. **A slow admission webhook fronting an API resource.** Every list, watch, and side-effect write through `kube-apiserver` traverses the webhook chain. If one webhook's endpoint is slow (the pods behind it are missing, being OOMKilled, or stuck in CrashLoopBackOff) **every API call the controller-manager makes** pays that webhook's latency tax. The controller-manager's list calls slow down proportionally; the dependency graph build blows through its budget; GC sync fails.

The field-seen variant of this is a monitoring / APM agent's mutating webhook whose endpoint pods are unhealthy. Example: a `MutatingWebhookConfiguration` named `<apm-vendor>-webhook` registered as `failurePolicy: Ignore` with a `timeoutSeconds: 30`. Because the webhook is registered, every matching API operation still calls it; the `Ignore` failure policy means the request eventually succeeds — but only after the 30-second timeout expires. At scale this makes every list call 30+ seconds slow, which is far longer than the GC's per-resource budget.

The fix is to either remove the orphaned webhook (if the product that registered it is no longer installed) or restore the product pods so the webhook endpoint returns quickly.

## Resolution

### Step 1 — confirm the signature matches this cause

```bash
kubectl logs -n kube-system -l component=kube-controller-manager --tail=300 | \
  grep -E 'garbage collector|dependency graph builder sync' | head -20
```

A repeating `timed out waiting for dependency graph builder sync` with an ever-increasing `(attempt N)` is the match.

### Step 2 — list every webhook that could be slowing API calls

```bash
kubectl get mutatingwebhookconfiguration \
  -o=custom-columns='NAME:.metadata.name,TIMEOUT:.webhooks[*].timeoutSeconds,POLICY:.webhooks[*].failurePolicy,SERVICE:.webhooks[*].clientConfig.service.name'

kubectl get validatingwebhookconfiguration \
  -o=custom-columns='NAME:.metadata.name,TIMEOUT:.webhooks[*].timeoutSeconds,POLICY:.webhooks[*].failurePolicy,SERVICE:.webhooks[*].clientConfig.service.name'
```

Look for:

- Webhooks whose `service.name` points to a namespace / service you do not recognise or that belongs to a product your team has removed.
- High timeout values (10 s, 30 s). A healthy webhook returns in single-digit milliseconds; a multi-second timeout is space for something to go wrong.
- `failurePolicy: Ignore` combined with a high timeout — these are the silent ones, because requests still succeed, so no user-facing error is raised even while every request slows down.

### Step 3 — check the webhook's backend pods

For each suspect webhook, locate the Service it points to and check its endpoints:

```bash
SVC=<service-name>; NS=<namespace>

kubectl -n "$NS" get endpoints "$SVC" -o=jsonpath='{.subsets[*].addresses[*].ip}{"\n"}'

# Correlate with the pods behind that selector:
kubectl -n "$NS" get pod -l <webhook-pod-label> -o=custom-columns='NAME:.metadata.name,STATUS:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount,REASON:.status.containerStatuses[0].lastState.terminated.reason'
```

Missing endpoints (empty address list) or repeated `OOMKilled` / `CrashLoopBackOff` status are the confirmation. The webhook is registered but its backend cannot answer.

### Step 4 — restore or remove the webhook

**If the product is required** and should be running: fix the pods. Usually this means checking the deployment's image pull (if the registry is unreachable), raising memory limits (if OOM-killed), or repairing the namespace's config (if the pods are crashing on startup).

**If the product is not required**, the clean action is to remove the webhook configuration rather than leaving an orphan:

```bash
kubectl delete mutatingwebhookconfiguration <name>
kubectl delete validatingwebhookconfiguration <name>
```

Removing the webhook immediately unblocks the slow API path — the next `kube-apiserver` request that would have traversed this webhook returns in milliseconds.

### Step 5 — verify the GC recovers

Within 1–2 minutes the next GC sync cycle runs. On a healthy cluster the sync completes well under its budget and the degraded condition clears:

```bash
kubectl logs -n kube-system -l component=kube-controller-manager --tail=200 | \
  grep -c 'timed out waiting for dependency graph builder sync'
```

The line count should stop incrementing. Re-run the same grep 5 minutes later — a cluster that is still producing new timeout lines has another slow webhook or a genuine scale issue (jump to Step 6).

### Step 6 — if the cluster is genuinely large and no orphan webhooks were found

A cluster with millions of CRs across thousands of namespaces can run into this error without any orphan webhook. Validate by measuring a list call directly:

```bash
time kubectl get --raw='/apis/apiextensions.k8s.io/v1/customresourcedefinitions' >/dev/null
```

On a healthy cluster this returns in well under 1 second. Multi-second response time indicates either a still-slow webhook chain or a genuine scale issue.

If genuinely scale-bound:

- Raise the controller-manager's `--concurrent-gc-syncs` (default 20) — a higher value parallelises the list calls.
- Consider `--leader-elect-retry-period` and the sync timeout adjustments if you administer the binary yourself.
- Audit your CRD inventory — clusters with thousands of CRDs often have generated resources (per-user, per-tenant) that could be consolidated. Each CRD is one list call per sync cycle.

## Diagnostic Steps

Confirm the dependency-graph build is specifically the failing stage:

```bash
kubectl logs -n kube-system -l component=kube-controller-manager --tail=500 | \
  grep -E 'dependency graph|caches to sync|GC sync' | tail -20
```

A healthy output shows `Waiting for caches to sync for garbage collector` followed by `Caches are synced for garbage collector` within a few seconds. A broken cluster shows the `Waiting` line followed by multiple `timed out waiting for dependency graph builder sync` lines before another `Waiting` line — the collector keeps retrying.

Measure per-webhook latency by capturing webhook admission duration from the apiserver's metrics:

```bash
kubectl get --raw='/metrics' 2>/dev/null | \
  grep -E 'apiserver_admission_webhook_admission_duration_seconds_bucket' | \
  awk -F'[{}]' '/le="([0-9]+\.[0-9]+|\+Inf)"/ {print $2}' | \
  sort -u | head
```

The histogram by name + URL shows you which webhook is slow. For affected clusters one webhook dominates.

Check the specific error text — the GC error should name "dependency graph builder", not a different controller's sync issue. Other controller-manager syncs (e.g. deployment, replicaset) can also fail caches-sync, but those have different remediations:

```bash
kubectl logs -n kube-system -l component=kube-controller-manager --tail=500 | \
  awk '/Unhandled Error/ {print $NF}' | sort | uniq -c | sort -rn
```

`dependency graph builder sync` should be the dominant error when this runbook applies.

Finally, verify that after removing a suspect orphan webhook the `kube-controller-manager` recovery holds for at least 10 minutes. Intermittent GC failures can be caused by a webhook whose endpoint is healthy in short windows but slow under load; if the degraded condition returns, repeat Step 3 at the next event to find the flaky service.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

An Argo CD Application refuses to progress past the sync/refresh step. The Application sits in `Unknown` state in the UI; the application-controller logs repeat an error of the form:

```
failed to sync cluster https://<api-server>/...:
failed to load initial state of resource:
The provided continue parameter is too old to display a consistent list result.
You can start a new list without the continue parameter,
or use the continue token in this response to retrieve the remaining results.
```

Or, when triggered from the UI manually:

```
failed to list resources:
The provided continue parameter is too old to display a consistent list result.
```

The cluster itself is otherwise healthy — other clients (kubectl, other controllers) succeed eventually. The failure is specific to Argo CD, and it recurs every time the application-controller tries to refresh its cache for this destination cluster.

## Root Cause

When Argo CD refreshes an Application, it lists every resource of every Kind the Application references (for example, every `Pod`, `ConfigMap`, or custom resource) in every destination namespace. The Kubernetes API paginates list responses: the server returns a page of items plus a `continue` token; the client passes that token on the next call to fetch the next page.

The `continue` token is backed by an etcd snapshot / revision. If the client cannot walk the full pagination set before etcd compacts the referenced revision (the "too old" condition — by default the compaction window is 5 minutes), the next call fails with the error above. The client must then restart the listing from scratch.

Two independent causes make Argo CD run out of time:

1. **Cluster-side slowness.** The kube-apiserver responds slowly to list requests — etcd is overloaded, the apiserver is CPU-constrained, or a LIST of the target kind is expensive (many fields, large objects, secrets cluster-wide).
2. **Argo CD-side slowness.** The application-controller's page buffer is small relative to the resource count, forcing it to call LIST many times. Each additional page-turn extends the wall-clock time and raises the odds of exceeding the compaction window.

The fix is to shorten the total walk time. That can be done by reducing the number of resources on the cluster side, by raising Argo CD's pagination buffer so fewer calls are needed, or (as a last resort) by speeding up the apiserver. On ACP, the GitOps plugin runs Argo CD as a managed operator; the relevant tuning is exposed on the `ArgoCD` custom resource as environment variables on the application-controller.

## Resolution

### Step 1 — characterise the failure

Confirm which destination cluster and which kind is hitting the limit:

```bash
NS=<argocd-namespace>
# Recent application-controller errors:
kubectl -n "$NS" logs sts/argocd-application-controller --tail=500 | \
  grep -E 'continue parameter|failed to list|failed to sync'
```

Each log line names the kind and the cluster URL. Pick the one failing most frequently.

Measure how big the list is and how long it takes to walk:

```bash
# How many objects of the slow kind exist cluster-wide?
kubectl get <kind> -A --no-headers | wc -l

# How long does a full LIST take?
time kubectl get <kind> -A -o=name >/dev/null
```

Rule of thumb: if this command takes more than ~3 minutes, or if the kind count is above ~50 000 cluster-wide, Argo CD's default settings will not keep up.

### Step 2 — reduce resource count (preferred when feasible)

Argo CD only needs to track the resources it manages. If the cluster has a large volume of kinds unrelated to GitOps (Kubernetes-owned `Event` objects, auto-generated `TokenRequest` resources, debug `Pod`s), the inventory is unnecessarily large.

Two ways to narrow scope:

**2a. Exclude heavy kinds in the ArgoCD CR:**

```yaml
apiVersion: argoproj.io/v1beta1
kind: ArgoCD
metadata:
  name: gitops
  namespace: <ns>
spec:
  resourceExclusions: |
    - apiGroups: [""]
      kinds: [Event]
    - apiGroups: ["events.k8s.io"]
      kinds: [Event]
    - apiGroups: ["authentication.k8s.io"]
      kinds: [TokenReview, TokenRequest]
    - apiGroups: ["authorization.k8s.io"]
      kinds: [SubjectAccessReview, LocalSubjectAccessReview, SelfSubjectAccessReview, SelfSubjectRulesReview]
```

These are examples — add any kind that Argo CD has no business tracking for your fleet. On ACP specifically, consider excluding cluster-internal bookkeeping kinds owned by the platform.

**2b. Partition Applications by namespace (not cluster-wide):**

Large Applications that use `project: '*'` or a wildcard destination namespace force a global list. Scope each Application to a smaller set of namespaces where practical:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
spec:
  destination:
    server: https://kubernetes.default.svc
    namespace: my-team-ns    # not '*'
  sources:
    - ...
```

This is a refactor, not a toggle — schedule it with the application owners.

### Step 3 — increase the application-controller's page size and buffer

If the resource count genuinely cannot go down, raise the pagination settings so fewer round-trips are needed. The application-controller exposes two environment variables:

- `ARGOCD_CLUSTER_CACHE_LIST_PAGE_SIZE` — items requested per LIST call (default 500 on newer versions; check your deployment).
- `ARGOCD_CLUSTER_CACHE_LIST_PAGE_BUFFER_SIZE` — number of pages the controller holds in memory concurrently (default 1).

On ACP, patch the `ArgoCD` CR to expose these on the application-controller:

```bash
kubectl -n <ns> patch argocd <name> --type=merge -p '{
  "spec": {
    "controller": {
      "env": [
        {"name": "ARGOCD_CLUSTER_CACHE_LIST_PAGE_SIZE",   "value": "2000"},
        {"name": "ARGOCD_CLUSTER_CACHE_LIST_PAGE_BUFFER_SIZE", "value": "4"}
      ]
    }
  }
}'
```

Raise the page size first (e.g., 500 → 2000). Each call now returns four times the items, so four times fewer pages to walk. If that alone is not enough, raise the buffer (1 → 4) so the controller can hold multiple pages in flight without serializing the LIST rounds.

Keep in mind: raising these values trades memory for resilience. A controller caching 2000-item pages for many Kinds can consume multiple GB of RAM. Bump the controller's memory limits in the ArgoCD CR at the same time:

```yaml
spec:
  controller:
    resources:
      requests: {cpu: "1", memory: "2Gi"}
      limits:   {cpu: "2", memory: "4Gi"}
```

The operator will roll the statefulset. Wait for rollout:

```bash
kubectl -n <ns> rollout status sts/argocd-application-controller
```

### Step 4 — fix apiserver / etcd slowness (last resort)

If Steps 2 and 3 do not resolve the issue, the underlying cluster is simply too slow at serving lists. This is a bigger investigation:

- **etcd latency**: check the etcd Prometheus metrics (`etcd_server_proposals_failed_total`, `etcd_disk_backend_commit_duration_seconds`). Slow commits (p99 > 100 ms) indicate disk, network, or DB-size pressure.
- **etcd compaction / defrag**: oversized etcd databases exacerbate the window. Confirm etcd periodic defrag is running and the DB is well below the 8 GiB hard limit.
- **kube-apiserver CPU**: on the apiservers, `top` during an Argo refresh — if CPU saturates at 100% handling the list, the node is undersized.

Any of these require cluster-admin-level remediation. Open a ticket with the platform team with the measurements above.

### Step 5 — verify and monitor

After the change, trigger a manual refresh of the problem Application and watch the controller logs:

```bash
kubectl -n "$NS" logs sts/argocd-application-controller -f | grep -E 'sync cluster|continue parameter'
```

Expected: no more `continue parameter is too old` lines. Application state resolves to `Synced` / `OutOfSync` within a normal refresh cycle (default 3 minutes).

Add a Prometheus alert that fires if the error ever returns:

```yaml
- alert: ArgoCDClusterListPaginationTooOld
  expr: |
    increase(argocd_cluster_events_total{server_type="cluster",reason="ListFailed"}[15m]) > 0
  for: 5m
  labels: {severity: warning}
  annotations:
    summary: "Argo CD cluster cache repeatedly failing to list resources"
    description: "The application-controller is hitting continue-token timeouts; check page size / resource count."
```

## Diagnostic Steps

Dump Argo CD's view of a destination cluster's cache size:

```bash
kubectl -n <ns> exec sts/argocd-application-controller -- \
  wget -qO- http://localhost:8082/metrics | \
  grep -E '^argocd_cluster_cache_(resources|api_resources)'
```

`argocd_cluster_cache_resources{server="<url>"}` is the total object count Argo CD is tracking. Cross-reference with cluster-wide object counts:

```bash
kubectl api-resources --verbs=list -o=name | \
  while read k; do
    echo "$k: $(kubectl get "$k" -A --no-headers 2>/dev/null | wc -l)"
  done | sort -k2 -t: -n | tail -20
```

The kinds at the top of that sorted-by-count list are the candidates for exclusion in Step 2a.

Time how long a single LIST takes per kind, from the Argo CD namespace:

```bash
for k in pods secrets configmaps events; do
  t=$( { time kubectl get "$k" -A -o=name >/dev/null; } 2>&1 | grep real )
  echo "$k: $t"
done
```

A `real` time above 60s per kind means the apiserver is the bottleneck; address Step 4.

If the application-controller keeps hitting the error after all changes, capture a page-level timing trace (application-controller logs with `--loglevel=debug`) and compare the timestamp between the first page and the failing page. A gap wider than the apiserver's `--min-request-timeout` (default 1800s with jitter to ~900s) confirms the apiserver, not Argo CD, is slow.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Vertical Pod Autoscaler recommender crashloops with "fatal error: concurrent map writes"
## Issue

After a platform upgrade, the Vertical Pod Autoscaler recommender pod
enters `CrashLoopBackOff`. The pod log carries a Go runtime panic:

```text
fatal error: concurrent map writes
```

The recommender restarts dozens of times, the panic recurs, and the
admission/updater components remain `Running` but produce no new
recommendations because the recommender is the source of truth.

## Root Cause

The recommender's processing loop was changed to spin up multiple worker
goroutines that share an internal in-memory map. The map's reconciliation
is not goroutine-safe in this revision: two workers attempting to update
the same entry simultaneously trigger the Go runtime's
`fatal: concurrent map writes` check, which is non-recoverable and forces
the process to exit.

The race is timing-dependent — small clusters with few VPA-managed
workloads may go a long time between hits, larger clusters with many
recommendations under contention hit it within minutes. The fix is a
backport of the upstream patch that serialises the writes; until the
backport lands the workaround is to drop the worker count back to one,
which removes the concurrency that exposes the bug.

## Resolution

Edit the recommender Deployment and pin the worker count to `1`:

```bash
kubectl edit deploy vpa-recommender-default -n <vpa-ns>
```

Add the `--update-worker-count=1` argument to the recommender container's
`args` list:

```yaml
spec:
  template:
    spec:
      containers:
        - name: recommender
          args:
            - --v=4
            - --stderrthreshold=info
            - --update-worker-count=1
```

Save and exit; the new pod rolls out and stops crashing because there is
no longer concurrent access to the shared map.

The trade-off is throughput: the recommender now processes one
recommendation update at a time, which can lengthen the time between when
a workload's resource use changes and when the VPA emits a new
recommendation for it. On a cluster with a small number of VPA-managed
workloads the impact is negligible. On a cluster with hundreds, expect
some lag in recommendation freshness until the upstream concurrency fix
ships in a future operator release; remove the override at that time and
let the default worker count (which scales with available CPUs) come back
into effect.

## Diagnostic Steps

1. Confirm the panic is the cause of the crash and not something else
   (image pull, RBAC, resource quota):

   ```bash
   kubectl get pod -n <vpa-ns> -l app=vpa-recommender
   kubectl logs -n <vpa-ns> <recommender-pod> --previous \
     | grep -i "concurrent map writes"
   ```

2. Verify the Deployment template has the override after the edit:

   ```bash
   kubectl get deploy vpa-recommender-default -n <vpa-ns> -o yaml \
     | yq '.spec.template.spec.containers[0].args'
   ```

3. Confirm the new pod stays `Running` for a sustained period (at least
   long enough to outlive the previous crash interval):

   ```bash
   kubectl get pod -n <vpa-ns> -l app=vpa-recommender -w
   ```

4. Confirm recommendations continue to be produced. Pick a representative
   `VerticalPodAutoscaler` resource and watch its `status.recommendation`
   for updates:

   ```bash
   kubectl get vpa <name> -n <ns> -o jsonpath='{.status.recommendation}' | jq .
   ```

   The values should refresh within the recommender's normal cadence (the
   default checkpoint interval is one minute).

5. After the upstream patch lands and the operator is updated, remove the
   `--update-worker-count=1` argument and confirm the recommender remains
   stable under the default concurrency.

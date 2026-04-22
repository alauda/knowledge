---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A pod lingers in `Pending` state, another pod lands on an unexpected node, or a Deployment scales up without distributing replicas as intended. `kubectl describe pod` only shows the last scheduling failure reason, which is often too coarse to explain why one node was preferred over another. To answer "why did the scheduler make this choice?" you need the scheduler's own log output at a higher verbosity than the default.

## Root Cause

`kube-scheduler` runs at log level `v=2` by default. At that level it reports binding events and basic errors but not the per-predicate / per-score breakdown. Raising verbosity to `v=4` (or higher) exposes:

- **filter / predicate** results — which nodes were excluded and why,
- **scoring** — the score each surviving node received from each plugin,
- **binding** — the final selection and API call.

These lines make scheduler behaviour legible. They are also noisy, so the change should be temporary: reset verbosity once you have the traces you need.

On ACP, the scheduler runs as a static pod on each control-plane node. Its command-line flags are produced from the platform's scheduler configuration, not edited on the node directly — any change made on disk is reverted by the next reconcile. Raise the level through the platform surface.

## Resolution

1. **Identify the current leader.** Multiple scheduler pods run in active-passive mode with lease-based election; only the leader emits scheduling decisions. Find it before collecting logs:

   ```bash
   NS=kube-system   # platform-specific; adjust if the scheduler runs elsewhere
   kubectl -n "$NS" get lease kube-scheduler -o jsonpath='{.spec.holderIdentity}{"\n"}'
   ```

   The holder identity usually contains the leader pod name; if not, correlate with pod logs as shown in the diagnostic steps.

2. **Raise the log level** via the platform scheduler customisation (`configure/clusters/...` surface). Set `logLevel: Debug` (or the platform's equivalent of `--v=4`). The platform rolls new scheduler pods with the elevated verbosity; watch for the rollout to finish:

   ```bash
   kubectl -n "$NS" get pod -l component=kube-scheduler --watch
   ```

3. **Collect the decision trace for the event you care about.** Create or scale the pod, then dump the leader's log:

   ```bash
   LEADER=$(kubectl -n "$NS" get lease kube-scheduler \
              -o jsonpath='{.spec.holderIdentity}' \
            | awk -F'_' '{print $1}')
   kubectl -n "$NS" logs "$LEADER" -c kube-scheduler --tail=2000 \
     | grep -E 'About to try|Attempting to bind|filter|score|Binding|unschedulable'
   ```

   Representative lines to look for:

   ```text
   About to try and schedule pod  ns/foo
   Plugin "NodeResourcesFit" filtered out 3/7 nodes
   Plugin "InterPodAffinity" scored node-2: 80, node-3: 40
   Attempting to bind pod ns/foo to node-2
   Successfully bound pod ns/foo to node-2
   ```

4. **Restore the default verbosity.** Scheduler debug output is substantial; leaving it on long-term impacts log storage and can mask other issues. Set `logLevel: Normal` once the traces are captured.

5. **Escalate to `Trace` only when necessary.** `Trace` (equivalent to `--v=6` or higher) adds per-plugin intermediate state and can produce megabytes of log per pod. Use it for reproducible issues with a narrow trigger; never leave a production scheduler there.

## Diagnostic Steps

Confirm the effective log level is in force:

```bash
LEADER=$(kubectl -n "$NS" get lease kube-scheduler \
           -o jsonpath='{.spec.holderIdentity}' | awk -F'_' '{print $1}')
kubectl -n "$NS" get pod "$LEADER" \
  -o jsonpath='{.spec.containers[?(@.name=="kube-scheduler")].args}' | tr ',' '\n' | grep -E '^--v|^-v'
```

If no `--v=N` flag is present the pod is still on the default; the platform's scheduler customisation has not been applied, or the pod has not rolled yet.

If the decision trace is absent even at `v=4`, verify you are reading the leader's log:

```bash
for p in $(kubectl -n "$NS" get pod -l component=kube-scheduler -o name); do
  echo "=== $p"
  kubectl -n "$NS" logs "$p" -c kube-scheduler --tail=20 | grep -E 'acquired lease|started leading' || echo '(no lease activity)'
done
```

If pods stay pending with no corresponding "About to try and schedule" line in the leader logs, the pod is failing admission **before** reaching the scheduler — check `kubectl describe pod` for admission webhook errors and `kubectl get events --field-selector type=Warning` for admission controller denials.

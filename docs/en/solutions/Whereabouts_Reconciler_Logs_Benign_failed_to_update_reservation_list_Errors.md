---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Operators of a cluster that uses Multus with the Whereabouts IPAM plugin notice error-level entries in the `whereabouts-reconciler` pod logs. The reconciler pods run as a DaemonSet in the Multus-control namespace, and their purpose is to periodically reclaim leaked IP reservations left behind by crashed or force-deleted pods.

Every reconcile tick the logs on multiple nodes emit a message resembling:

```text
[error] failed to update the reservation list:
        the server rejected our request due to an error in our request
[error] failed to clean up IP for allocations:
        failed to update the reservation list:
        the server rejected our request due to an error in our request
[verbose] reconciler failure:
          failed to update the reservation list:
          the server rejected our request due to an error in our request
```

The messages look alarming, but closer inspection shows that the IP reservation list (the `ippools.whereabouts.cni.cncf.io` custom resource) is actually up-to-date and that pods on the affected NetworkAttachmentDefinitions continue to get IPs without interruption. No workload has reported failed IPAM, no stuck reservations accumulate, and the periodic reclaim is still happening.

## Root Cause

The reconciler runs as a DaemonSet, so there is one instance per node — meaning every reconcile tick starts several concurrent passes over the same `IPPool` resource. Each pass reads the current reservation list, computes which entries are orphaned, and then submits a `Update` to remove them.

When two or more reconciler instances try to update the same pool at the same instant:

1. The fastest instance wins the race. Its `Update` lands, the orphan is cleared, and the object's `resourceVersion` is bumped.
2. The slower instances, which did their read against the old `resourceVersion`, submit their `Update` milliseconds later.
3. The API server rejects those slower `Update` calls — the reservation list they are trying to set has already been set, so the request is either a `Conflict` (`resourceVersion` mismatch) or a validation rejection because the orphaned reservation they want to remove is no longer in the list.

The rejection is exactly the correct behaviour by the API server, and from the cluster's point of view the cleanup is done. But the reconciler's Go code logs the rejection at `error` level without distinguishing "lost the race" from "a real failure". Hence the message — benign, but noisy.

The upstream fix is to classify "lost the race" as a debug-level event rather than an error, or to coordinate the DaemonSet instances with a lease so only one reconciler actually performs the update each cycle. Until that lands, the log is a false positive.

## Resolution

1. **Ignore the messages.** As long as IP allocations on Whereabouts-backed attachments continue to succeed and the `ippools.whereabouts.cni.cncf.io` objects do not accumulate orphaned reservations over time, the cluster is operating normally. Do not scale the DaemonSet down, do not disable the reconciler — that would turn a false alarm into a real IP leak.

2. **Suppress the alert** if a log-based monitor is firing on the pattern. In the downstream observability pipeline, add a filter that drops this specific error signature from alert routing (but keeps it in the long-term log store so future investigations still have the data). An example filter in a collector config:

   ```yaml
   # conceptual; adapt to the actual collector in use
   transforms:
     - type: filter
       condition: >-
         !contains(.message,
           "failed to update the reservation list")
   ```

   Make sure the filter is scoped to the reconciler's pod selector (e.g. `app=whereabouts-reconciler` in the Multus namespace), not to all log streams, otherwise a genuine reservation-update error from an unrelated workload will be silently dropped.

3. **Track the upstream tracker.** The noisy logging is known to the Whereabouts maintainers; the remediation will come as a bump of the Multus / Whereabouts images shipped with the cluster's CNI stack. Once that version is deployed, the log line is reduced to `debug` level and the alert can be removed.

4. **If, contrary to the benign case, pods actually fail IPAM**, then this article does *not* apply and the errors are pointing at a real problem. Go to the diagnostic steps and check the pool's accumulation pattern: a healthy cluster has a stable count of reservations; a broken one has monotonically-growing orphaned entries.

## Diagnostic Steps

Use the following to confirm the error is in fact benign and not masking a real IPAM failure:

1. **IP allocation is still working on pods that use the plugin.** New pods on a `NetworkAttachmentDefinition` backed by a Whereabouts pool are receiving an IP on their secondary interface:

   ```bash
   kubectl run -n <test-ns> whereabouts-smoketest \
     --image=registry.k8s.io/pause:3.9 --restart=Never \
     --overrides='{"metadata":{"annotations":{"k8s.v1.cni.cncf.io/networks":"<net-attach-def>"}}}'
   kubectl -n <test-ns> get pod whereabouts-smoketest -o jsonpath='{.metadata.annotations.k8s\.v1\.cni\.cncf\.io/network-status}{"\n"}'
   ```

2. **Reservation count is stable.** Count the active entries in each pool once, wait a scheduled reconcile cycle (typically 5 minutes with Whereabouts defaults, but whatever the cluster is configured for), and count again. The number should be proportional to live pods on that attachment — if it grows without bound, the reconciler is genuinely failing and this article does not describe your case:

   ```bash
   kubectl get ippools.whereabouts.cni.cncf.io -A \
     -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"\t"}{.spec.allocations}{"\n"}{end}' | \
     awk '{print $1, NF-1}'
   ```

3. **One reconciler succeeds per cycle.** At debug verbosity (or simply in aggregate across all instances), exactly one `successfully reconciled` event shows up per pool per cycle; the others produce the noisy error. That is the expected pattern for the race:

   ```bash
   kubectl -n <multus-ns> logs -l app=whereabouts-reconciler --tail=200 | \
     grep -E 'successfully reconciled|failed to update the reservation list'
   ```

4. **Escalate only if allocation actually fails.** Genuine IPAM failures surface as pod-creation errors on the workload, not as reconciler log noise. A pod stuck in `ContainerCreating` with a `FailedCreatePodSandBox` event referencing `Whereabouts` or `IPAM` is a real failure and needs to be investigated:

   ```bash
   kubectl -n <ns> describe pod <stuck-pod>
   ```

If the smoketest pod gets an IP and the pool allocation count is stable, the reconciler errors can be treated as expected noise and filtered out of the alerting path.

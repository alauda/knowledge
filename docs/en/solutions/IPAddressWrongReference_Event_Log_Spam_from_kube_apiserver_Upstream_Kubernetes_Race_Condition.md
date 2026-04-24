---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Cluster-wide Events and the `kube-apiserver` log fill with repeated warnings about `IPAddress` objects whose reference does not match the Service they supposedly belong to:

```text
IPAddress: 10.128.42.17 for Service <ns>/rook-ceph-mgr has a wrong reference; cleaning up
IPAddress: 10.128.42.18 for Service <ns>/rook-ceph-exporter has a wrong reference; cleaning up
IPAddress: 10.128.42.19 for Service <ns>/rook-ceph-mon-a has a wrong reference; cleaning up
IPAddress: 10.128.9.3   for Service <nfd-ns>/nfd-controller-manager-metrics-service has a wrong reference; cleaning up
```

The corresponding `kube-apiserver` log carries matching `repairip.go` unhandled-error lines and a follow-up `ipallocator.go` complaint that the IP it tried to release no longer exists:

```text
repairip.go:523] "Unhandled Error"
  err="the IPAddress: 10.128.42.17 for Service rook-ceph-mgr/<ns> has a wrong reference
       &v1.ParentReference{...}; cleaning up"
  logger="UnhandledError"
...
ipallocator.go:374] error releasing ip 10.128.42.17:
  ipaddresses.networking.k8s.io "10.128.42.17" not found
```

The cluster is functionally fine — Services keep serving traffic, pods keep scheduling, new resources get IPs — but event history, alerting that counts events per unit time, and log aggregation systems are flooded. On busy clusters the signal-to-noise ratio on `kubectl get events -A` drops to the point where genuine issues are hard to spot.

## Root Cause

Kubernetes 1.33 and 1.34 introduced a dedicated `IPAddress` object type (in `networking.k8s.io`) as part of the new Service-IP allocator. Each Service is expected to have a matching `IPAddress` whose `spec.parentRef` points back at the Service. The apiserver's `repairip` controller periodically reconciles the two and cleans up mismatches.

A race condition between two goroutines inside the controller can momentarily see an `IPAddress` whose `parentRef` appears to name the Service fields transposed (the namespace in the `Name` slot and vice versa). The controller flags this as a "wrong reference", emits the event, and calls the allocator to release the IP — but by the time the release runs, another reconcile has already cleaned it up, so the allocator's release itself logs "not found". The IP is fine, the Service is fine, the log just pollutes.

The race was introduced along with the new allocator and has been fixed upstream. Clusters running a Kubernetes version older than the fix see the event/log noise; clusters on the fixed version see clean logs.

Because the issue is entirely in the apiserver's controller, no workload or user configuration change resolves it. The only real fix is to run a patched apiserver.

## Resolution

### Preferred — upgrade to a Kubernetes version that carries the fix

The fix lands in **Kubernetes 1.33.6** and **1.34.0+**. Any platform build whose apiserver version is at or above one of those lines stops emitting the noise. Upgrade the platform through its normal upgrade channel; the next kube-apiserver rollout picks up the fix.

Verify:

```bash
kubectl version -o json | jq '.serverVersion.gitVersion'
# "v1.33.6" or "v1.34.x" or later
```

After the upgrade settles for a few minutes, the `IPAddressWrongReference` events stop accruing:

```bash
kubectl get events -A --field-selector reason=IPAddressWrongReference | wc -l
# should trend to 0 within an event-retention window (typically 1 hour).
```

### While the upgrade is pending — silence downstream effects, not the source

The race does not cause any functional problem, so the cost is monitoring noise. Two ways to keep the noise from destabilising downstream tooling without touching the apiserver:

**Filter the event at the log-collection layer.** Drop events / log lines whose reason field is exactly `IPAddressWrongReference` or whose text matches the `ipallocator.go:374] error releasing ip` pattern. Your log forwarder's filter stage is the right place — it keeps the events out of dashboards and alerts without disabling the underlying reconcile.

Example filter (pseudo-shape; match to whichever collector the cluster uses):

```yaml
- drop:
    match:
      reason: IPAddressWrongReference
- drop:
    match:
      component: kube-apiserver
      message_substring: "has a wrong reference; cleaning up"
- drop:
    match:
      component: kube-apiserver
      message_substring: "error releasing ip"
```

Keep the drop conditional on the exact pattern — a broader filter risks suppressing legitimate `kube-apiserver` errors.

**Exempt the specific event reason from alerting rules.** If the monitoring stack alerts on high event rates in specific namespaces, add an exception for `reason=IPAddressWrongReference` so the noise does not trigger pages.

### Do not

- **Do not delete the `IPAddress` objects by hand.** The apiserver owns them and recreates them on reconcile. Hand-deletion at best is churn; at worst it briefly disconnects the Service from its IP until the next reconcile.
- **Do not scale the apiserver replicas down or restart them.** The restart does not clear the race — the same condition reappears as soon as reconcile resumes. Apiserver restarts also have operational risk out of proportion to the noise this bug causes.

## Diagnostic Steps

Confirm the exact events and their accumulation rate:

```bash
kubectl get events -A --field-selector reason=IPAddressWrongReference \
  -o custom-columns='NS:.involvedObject.namespace,SVC:.involvedObject.name,MSG:.message' | head -20
kubectl get events -A --field-selector reason=IPAddressWrongReference | wc -l
```

A non-trivial count (hundreds in a few minutes) confirms the bug is actively producing noise.

Inspect the kube-apiserver log on one of the control-plane pods:

```bash
KAS_POD=$(kubectl -n kube-system get pod -l component=kube-apiserver \
           -o jsonpath='{.items[0].metadata.name}')
kubectl -n kube-system logs "$KAS_POD" -c kube-apiserver --tail=2000 | \
  grep -E 'repairip\.go:523|ipallocator\.go:374|has a wrong reference' | head -20
```

The log lines should pair up: a `repairip.go:523` line naming a Service and a follow-up `ipallocator.go:374` line saying the IP is "not found" (because reconcile cleaned it up in between the two controller steps).

Check the cluster's kube-apiserver version to know whether the fix is already available:

```bash
kubectl version -o json | jq '.serverVersion.gitVersion'
```

Below the fix line → upgrade schedules and the filter workaround are both appropriate. At or above → investigate separately; the noise should not be present.

After the upgrade, zero events with `reason=IPAddressWrongReference` should accrue across a representative observation window. Clean up any temporary log-forwarder filters so future, real issues with the `repairip` controller are not suppressed.

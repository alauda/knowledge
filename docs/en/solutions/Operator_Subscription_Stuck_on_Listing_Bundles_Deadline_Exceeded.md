---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Operator Subscription Stuck on "Listing Bundles" Deadline Exceeded
## Issue

An operator install initiated through the lifecycle layer (the `extend` surface) does not progress. The Subscription's status condition reports a gRPC deadline against the catalog source, of the form:

```text
error using catalogsource <namespace>/<catalog-name>: error encountered while
listing bundles: rpc error: code = DeadlineExceeded desc = context deadline exceeded
```

The catalog pod is still running, the registry image was previously reachable, and other Subscriptions against the same catalog may or may not be affected. The InstallPlan never gets created and the operator is never rolled out.

## Root Cause

The lifecycle manager's catalog flow has three moving parts:

1. **The catalog source pod** — a long-running pod that serves bundle metadata over gRPC from a registry image.
2. **The catalog operator** — the controller that watches Subscriptions, queries each catalog source for the appropriate bundle, and creates the matching InstallPlan.
3. **The Subscription's `status.conditions`** — the durable record of the last query attempt, including any failure mode.

`DeadlineExceeded` on `listing bundles` means the catalog operator's gRPC call to the catalog source pod timed out. The most common reasons are:

- **The catalog source pod is wedged** — alive from the kubelet's perspective but not serving the registry endpoint (slow disk, blocked DNS, expired internal TLS, image-loading hang during cold-start).
- **The catalog operator itself is in a bad state** — its informer or its gRPC client got stuck on a stale connection and never retried.
- **The Subscription's `status.conditions` cached a terminal failure** — a previous error left a sticky condition that the controller does not clear on its own. New reconcile attempts read the stale condition, surface the same message, and never re-execute the bundle listing.

The fix is to push all three components back to a clean reconcile in order: catalog pod, catalog operator, and Subscription status.

## Resolution

Work the three layers in order; each step is independent, and stopping after the first one is enough if the catalog pod alone was the problem.

### 1. Restart the catalog source pod

Find the catalog and recycle its pod. Pods carry a label that identifies the owning catalog source; matching on that label avoids guessing the pod name.

```bash
NS=<catalog-namespace>            # e.g. the namespace that hosts the catalog source
CAT=<catalog-source-name>         # e.g. operators-catalog
kubectl -n "$NS" delete pod -l olm.catalogSource="$CAT"
kubectl -n "$NS" get pod -l olm.catalogSource="$CAT" -w
```

A new pod should reach `Running` within a minute and re-open its gRPC endpoint. If it stays `ContainerCreating` or `CrashLoopBackOff`, the underlying image pull is the real failure — chase that first.

### 2. Restart the catalog operator

The lifecycle manager's catalog operator runs in its own namespace. Recycle that pod so any stale gRPC connections are dropped.

```bash
LCM_NS=<lifecycle-manager-namespace>     # the namespace running OLM (catalog-operator)
kubectl -n "$LCM_NS" delete pod -l app=catalog-operator
kubectl -n "$LCM_NS" logs -l app=catalog-operator --tail=200 -f
```

Watch the new pod's logs for the next reconcile of the affected Subscription; it should re-query the catalog source within a few seconds.

### 3. Clear the stuck Subscription status

If the Subscription still shows `DeadlineExceeded` after step 2, its `status.conditions` field is sticking. Remove it via a status subresource patch so the controller writes a fresh state on the next reconcile:

```bash
SUB_NS=<subscription-namespace>
SUB=<subscription-name>
kubectl -n "$SUB_NS" patch subscription "$SUB" \
  --subresource=status --type=json \
  -p '[{"op":"remove","path":"/status/conditions"}]'
```

When the patch is rejected (`subresource not supported`), fall back to deleting and recreating the Subscription. Capture the spec first so the new object is identical:

```bash
kubectl -n "$SUB_NS" get subscription "$SUB" -o yaml > /tmp/sub.yaml
kubectl -n "$SUB_NS" delete subscription "$SUB"
# Optionally also delete the half-built CSV/InstallPlan if they exist:
kubectl -n "$SUB_NS" delete csv,installplan -l operators.coreos.com/$SUB.$SUB_NS=
kubectl apply -f /tmp/sub.yaml
```

After the Subscription comes back, an InstallPlan should appear within a minute. If it does not, return to step 1 and check whether the catalog pod is actually serving:

```bash
kubectl -n "$NS" exec deploy/<catalog-deploy-or-pod> -- \
  grpcurl -plaintext localhost:50051 list 2>/dev/null | head
```

A healthy catalog responds with a list of registry services; a wedged one returns nothing or hangs.

## Diagnostic Steps

Read the Subscription's current status to confirm which message the controller is publishing:

```bash
kubectl -n "$SUB_NS" get subscription "$SUB" -o json \
  | jq '.status.conditions[] | {type,status,reason,message}'
```

Inspect the catalog operator's recent reconcile errors:

```bash
LCM_NS=<lifecycle-manager-namespace>
kubectl -n "$LCM_NS" logs -l app=catalog-operator --tail=300 \
  | grep -iE 'deadline|listing bundles|catalogsource'
```

If the same `DeadlineExceeded` continues after restarting both pods and clearing the Subscription status, capture pod-network egress and resolve-time from the catalog operator's pod toward the catalog source service:

```bash
kubectl -n "$LCM_NS" exec deploy/catalog-operator -- \
  sh -c 'time getent hosts <catalog-svc>.<catalog-ns>.svc.cluster.local'
kubectl -n "$LCM_NS" exec deploy/catalog-operator -- \
  sh -c 'nc -vz <catalog-svc>.<catalog-ns>.svc.cluster.local 50051'
```

A DNS or TCP failure here points back at the cluster network rather than the lifecycle manager itself; in that case, remediate at the networking layer (Kube-OVN logs, NetworkPolicy that excludes the lifecycle namespace) before retrying the install.

---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

A `Deployment` configured with a RollingUpdate strategy expresses its surge / unavailable budgets as either a fixed count (`2`) or a percentage (`25%`). When percentages are used and the computed value does not land on a whole number, the rounding direction is not symmetric:

- **`maxSurge` is rounded up.**
- **`maxUnavailable` is rounded down.**

Both rules are deliberate — they favour **availability** at every step:

- Rounding `maxSurge` up means the rollout is slightly more willing to bring an extra new pod online than strict math would permit — the cluster has to absorb one more running pod briefly, and the rollout can proceed.
- Rounding `maxUnavailable` down means the rollout is slightly less willing to take old pods offline than strict math would permit — the cluster keeps more capacity serving during the transition.

The net effect on a percentage-configured rollout is "prefer more capacity, fewer outages". This note walks through the concrete numbers and how to verify.

## Concrete Examples

A Deployment with 10 replicas and `maxSurge: 25%, maxUnavailable: 25%` looks like:

- `25% × 10 = 2.5`
- `maxSurge` rounds up → **3** additional pods may be brought up during rollout (max total during rollout = 13).
- `maxUnavailable` rounds down → **2** pods may be unavailable at any time (min ready = 8).

Contrast with 10 replicas and `maxSurge: 25%, maxUnavailable: 10%`:

- `25% × 10 = 2.5` → `maxSurge = 3`.
- `10% × 10 = 1` (whole number, no rounding needed) → `maxUnavailable = 1`.

Edge cases worth knowing:

- `maxSurge: 1%` on a 5-replica Deployment: `0.05` → rounds up to `1`. Any non-zero percentage on a small Deployment produces `maxSurge = 1`.
- `maxUnavailable: 10%` on a 5-replica Deployment: `0.5` → rounds down to `0`. `maxUnavailable = 0` means the rollout runs under strict availability; each new pod must be fully Ready before an old pod is removed.
- Both zero: `maxSurge: 0, maxUnavailable: 0` is rejected at admission — the rollout would have no way to make progress.

## Why This Matters in Practice

For most Deployments, the default percentages (`maxSurge: 25%, maxUnavailable: 25%`) produce the right behaviour: rollouts are aggressive on small Deployments (few replicas → `1` for both after rounding) and proportional on large Deployments.

Two situations to keep in mind:

### 1 — Small Deployments with strict availability requirements

A Deployment with few replicas where `maxUnavailable` rounds down to zero forces serial rollout: one new pod up → wait until Ready → take one old pod down → repeat. On a 3-replica Deployment with `maxUnavailable: 25%`, rounding produces `0`. If the workload tolerates a brief capacity dip (2 of 3 pods serving), set `maxUnavailable: 1` explicitly so the rollout is not unnecessarily serialised.

### 2 — Large Deployments with capacity budgets

A 100-replica Deployment with `maxSurge: 25%` creates up to 25 extra pods during rollout — 125 pods concurrent. If the cluster does not have the headroom (node capacity, service-account quotas, database connection limits), tune the surge percentage down. Also consider whether `maxSurge: 25, maxUnavailable: 0` (high concurrency, zero pod dip) is better than `maxSurge: 10%, maxUnavailable: 10%` (modest concurrency, some tolerated outage) for the specific workload.

### 3 — Percentages on auto-scaling Deployments

If an HPA sizes the Deployment dynamically, the effective `maxSurge` / `maxUnavailable` values change with the replica count. A `25%` surge on a 4-replica Deployment is `1`; on a 40-replica Deployment it is `10`. Reason about rollout behaviour at the replica counts the HPA actually produces, not at the default.

## Verify the Rounding on a Specific Deployment

`kubectl rollout` does not directly expose the computed surge / unavailable values, but they can be inferred from the Deployment's status during a rollout:

```bash
# Start a rollout (dummy annotation bump):
kubectl -n <ns> patch deployment <name> --type=merge \
  -p '{"spec":{"template":{"metadata":{"annotations":{"test-rollout":"'$(date +%s)'"}}}}}'

# Watch the pod count and ready count during the rollout:
kubectl -n <ns> get deployment <name> -w
# NAME    DESIRED CURRENT UP-TO-DATE AVAILABLE
# <name>  10      12      5          8
```

The transient `CURRENT - DESIRED` peak equals `maxSurge` (rounded up). The minimum `AVAILABLE` across the rollout equals `DESIRED - maxUnavailable` (rounded down).

Alternatively, compute the values ahead of a rollout:

```bash
# Python one-liner — use the actual values from your Deployment.
python3 -c '
import math
desired = 10
max_surge_pct      = 25
max_unavail_pct    = 25
max_surge      = math.ceil(desired * max_surge_pct / 100)
max_unavailable = math.floor(desired * max_unavail_pct / 100)
print(f"maxSurge={max_surge}, maxUnavailable={max_unavailable}")
'
```

The printed values match what the Deployment controller will use.

## Diagnostic Steps

Read the Deployment's actual strategy to confirm percentages vs absolute counts:

```bash
kubectl -n <ns> get deployment <name> -o json | \
  jq '.spec.strategy.rollingUpdate'
# {
#   "maxSurge": "25%",
#   "maxUnavailable": "25%"
# }
```

Percentages appear as strings with `%`; absolute counts appear as numbers.

Compute the effective values using the rounding rules above. Confirm by triggering a rollout and watching pod counts. If observations do not match the math, check for a PodDisruptionBudget on the Deployment's label selector — PDBs constrain rollouts tighter than the Deployment's own strategy and can make rollouts appear to honour a lower effective `maxUnavailable`.

No action is required; the rounding behaviour is deliberate and correct for availability-preserving rollouts.

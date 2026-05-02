---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Migration Plan NetworkMap Fails When the NAD Lives in a Different Namespace
## Issue

A VM migration plan authored through the virtualization migration toolkit fails to become ready. The `Plan` carries a critical condition `NetworkMapNotReady`, and the companion `NetworkMap` object itself reports that the destination `NetworkAttachmentDefinition` (NAD) cannot be found — despite the NAD existing on the cluster and being the intended destination network:

```yaml
# Plan status
status:
  conditions:
    - category: Critical
      type: NetworkMapNotReady
      status: "True"
      message: Map.Network does not have Ready condition.

# NetworkMap status
status:
  conditions:
    - category: Critical
      type: DestinationNetworkNotValid
      status: "True"
      reason: NotFound
      message: Destination network (NAD) not found.
```

`kubectl get network-attachment-definitions -n <ns-where-nad-actually-lives>` confirms the NAD is there. The problem is not the NAD's existence; it is the **namespace** the NAD lives in relative to the migration plan.

## Root Cause

The migration toolkit's controller validates, for each entry in a `NetworkMap`, that the destination NAD is reachable from the migration plan's security context. In certain versions of the toolkit, that validation is narrower than the documented cross-namespace feature implies: the controller asserts the destination NAD sits in the **same namespace** as the migration plan, and rejects the mapping otherwise — even when the NAD is a legitimate cluster-wide resource kept in a shared namespace like `default`.

The regression manifests specifically as `DestinationNetworkNotValid / NotFound` on the `NetworkMap`, because the controller bails out of the lookup before it would otherwise succeed. Manually patching the `NetworkMap` after the fact does not help — the same check runs on every reconcile, and the `Ready` condition stays `False` regardless of the patched content.

The durable fix is in a newer toolkit build. Until the cluster can be upgraded, two workarounds are available that move the NAD and the plan into a combination the check accepts.

## Resolution

### Option 1 — upgrade the migration toolkit (preferred)

Upgrade the migration toolkit operator through the cluster's operator-management surface to a release that has restored cross-namespace NAD support. After the upgrade reconciles, delete and re-create the failing `Plan` so a fresh `NetworkMap` is generated; the status should reach `Ready=True` within one or two reconcile cycles.

Verify:

```bash
kubectl -n <migration-ns> get plan <plan-name> \
  -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
```

No `Critical` conditions with `status=True` — the plan is migratable again.

### Option 2a — co-locate the NAD with the migration plan

The quickest workaround is to place the destination NAD in the same namespace as the migration plan. Copy the existing NAD's `spec.config` into a new NAD manifest in the plan's namespace, give it a fresh `metadata.name` if required to avoid a collision, and update the migration plan's NetworkMap to point at the new NAD:

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: my-destination-network
  namespace: migration-plans     # same namespace as the migration plan
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "name":       "my-destination-network",
      "type":       "ovn-k8s-cni-overlay",
      "netAttachDefName": "migration-plans/my-destination-network",
      "topology":   "localnet",
      "vlanID":     1044,
      "ipam":       {}
    }
```

Then edit the plan's `NetworkMap` so every mapping's `destination.namespace` points at `migration-plans` (the plan's own namespace). The controller's cross-namespace check is bypassed by construction — source and destination are in the same namespace — and the plan reconciles to `Ready=True`.

This workaround duplicates the NAD definition. Document that both copies need to be kept in sync until the upgrade path is taken.

### Option 2b — run the migration plan from a trusted namespace

The controller treats its own namespace as a trusted administrative location. Creating the migration plan inside the toolkit's system namespace (`forklift` / whichever the operator reserves on installation) exempts it from the same-namespace NAD check. The destination NAD can then stay in `default` (or wherever a cluster-wide network is hosted) and the mapping resolves:

```bash
kubectl -n <forklift-system-ns> apply -f migration-plan.yaml
```

This path requires elevated permissions to create resources in the system namespace, and mixes user-owned migration objects with operator-owned ones. It is acceptable as a time-boxed workaround but not a durable pattern; move back to a user namespace once the upgrade is complete.

### Which workaround to pick

| Situation | Choose |
|---|---|
| The NAD is unique to this migration and can be duplicated | **Option 2a** |
| The NAD is a shared cluster resource referenced by many plans | **Option 2b** |
| The upgrade path is available within the relevant maintenance window | **Option 1** — skip workarounds |

Options 2a and 2b are reversible — after the upgrade, delete the duplicated NAD (2a) or move the plan back to the user namespace (2b) and confirm the migration still reconciles.

## Diagnostic Steps

Confirm the failure is specifically the cross-namespace NAD validation (rather than an unrelated `NetworkMap` defect):

```bash
kubectl -n <migration-ns> get plan <plan-name> -o yaml | \
  yq '.status.conditions[] | select(.type=="NetworkMapNotReady")'
```

`status: "True"` and a `Map.Network does not have Ready condition` message points at the network map side. Then read the `NetworkMap`:

```bash
kubectl -n <migration-ns> get networkmap <map-name> -o yaml | \
  yq '.status.conditions[] | select(.type=="DestinationNetworkNotValid")'
```

`reason: NotFound` with `message: Destination network (NAD) not found.` is the regression signature. If the NAD exists on the cluster — check with:

```bash
kubectl get network-attachment-definitions -A -o \
  custom-columns='NS:.metadata.namespace,NAME:.metadata.name'
```

— and it is **not** in the migration plan's namespace, the cross-namespace check has rejected the mapping.

Read the controller logs to confirm which validation step rejected the mapping:

```bash
CONTROLLER_POD=$(kubectl -n <forklift-system-ns> get pod \
  -l app=forklift,service=forklift-controller \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n <forklift-system-ns> logs --tail=500 "$CONTROLLER_POD" | \
  grep -E 'NetworkMap|DestinationNetworkNotValid|NetworkAttachmentDefinition'
```

Look for lines that mention the NAD's name or the plan's namespace. The controller logs the specific reason it rejected the lookup — if the reason is `namespace mismatch` or similar wording, the workarounds above apply. If the reason is different (for example, the NAD's `spec.config` is malformed), the problem is not this regression and a different fix is needed.

After applying the workaround or the upgrade, re-read the plan's status and confirm `NetworkMapNotReady` has disappeared. Trigger a migration run and verify VMs move between hypervisors as expected before closing the investigation.

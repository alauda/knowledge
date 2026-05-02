---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The Compliance Service has automatically applied a remediation for a scan rule that, in retrospect, should not be applied to this cluster — for example a banner template that conflicts with an internal policy, or a sysctl change that breaks an in-house workload. The cluster needs the remediation reverted, the rule kept on the scan profile (so it still produces a finding for visibility), and future re-runs of the scan should not re-apply it automatically.

The remediation status reports `applied`, the underlying node-level change is in place, and a plain `kubectl delete` on the ComplianceRemediation object only deletes the bookkeeping resource — the change remains on the node.

## Root Cause

A ComplianceRemediation is the controller's record of "this scan rule produced a fix and the fix is currently applied". Two flags drive its behaviour:

- `spec.apply` — when `true`, the controller renders the fix and pushes it through node configuration; when `false`, the controller withdraws the fix.
- `status.applicationState` — observed state, mirrors what is currently on the nodes.

Deleting the object without first toggling `apply` to `false` leaves the rendered change in place because the controller doesn't garbage-collect node configuration on remediation-object deletion (the parent `ComplianceCheckResult` may recreate the remediation on the next scan and the cycle repeats). The clean way to undo is to set `apply: false` and let the controller reconcile the change off the nodes.

## Resolution

Patch the remediation to mark it unapplied:

```bash
kubectl -n compliance patch \
  complianceremediation/<rule-name> \
  --type=merge \
  --patch '{"spec":{"apply":false}}'
```

The controller picks up the change, renders the inverse, and pushes it through the cluster's node-configuration mechanism. Nodes that carried the rendered fix will pick up the new node config in the next pool roll and the on-disk change is reverted.

Once the controller has reconciled, `status.applicationState` flips from `Applied` to `NotApplied` and the rule appears as a finding on the next scan instead of being silently fixed.

If the remediation was wrong for the entire cluster (not just one pool), also detach the rule from the scan profile so the scanner stops re-creating the remediation on every cycle. Edit the relevant `TailoredProfile` and add the rule to `disableRules`. Without this step, the next scan will recreate a fresh ComplianceRemediation object — still with `apply: false` because of the new default if you wired one — but the noise of seeing the rule re-evaluated may not be wanted.

For a per-cluster approval workflow (do not auto-apply anything; let the operator pick), set the parent `ScanSetting` so `autoApplyRemediations: false`. New remediations from future scans will then materialise as proposals only and never enter the `Applied` state until an operator flips `apply` to `true` explicitly.

## Diagnostic Steps

Confirm the remediation is currently applied:

```bash
kubectl -n compliance get \
  complianceremediation/<rule-name> \
  -o jsonpath='{.status.applicationState}{"\n"}'
```

`Applied` means the change is on the nodes; `NotApplied` means the controller has withdrawn it (or it was never applied).

Inspect the rendered content so you know exactly what is being reverted. The remediation embeds the node-configuration object it would create:

```bash
kubectl -n compliance get \
  complianceremediation/<rule-name> -o yaml \
  | grep -A50 'spec.current.object'
```

After patching `apply: false`, watch the node-configuration roll. Each affected pool drains and reboots serially:

```bash
kubectl get nodepool -w
```

Once the roll is complete, verify on a target node that the file or sysctl introduced by the remediation is no longer present. For a banner-style remediation:

```bash
kubectl debug node/<node> -it --image=busybox -- \
  cat /host/etc/issue.d/legal-notice 2>/dev/null \
  || echo 'file removed as expected'
```

If `applicationState` stays `Applied` for more than one pool roll, check the controller log for reconcile errors — the most common failure is a rendered change that no longer fits the current node-configuration schema (for example a path that has moved). The log will name the offending object and the controller will hold the remediation in the previous state until the conflict is resolved.

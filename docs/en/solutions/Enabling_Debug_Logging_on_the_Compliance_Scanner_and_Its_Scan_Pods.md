---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Enabling Debug Logging on the Compliance Scanner and Its Scan Pods
## Issue

The default log volume from the in-cluster compliance scanner — the OpenSCAP-based scanner that backs the Compliance Service extension on ACP — is deliberately quiet. Each scan pod prints a short summary of the profile it ran, the host it targeted, and the rule-pass/rule-fail rollup; it does not print the per-rule probe steps, the OpenSCAP CLI invocation, or the intermediate filesystem queries that produced each result.

That summary is enough to spot a wholesale failure (a profile that did not bind, a node that the scanner could not reach), but it is not enough to diagnose subtle issues such as:

- a single rule that always returns `unknown` on otherwise-healthy nodes;
- a profile that takes much longer to run than expected and times out partway through;
- inconsistent results between two nodes that look identical in `kubectl describe node`.

Increasing the verbosity so each scan pod logs the probe-by-probe execution path turns every scan pod into a self-contained trace, which is what the ticket is really asking for.

## Root Cause

The scanner stack exposes a single `debug` boolean on two CRs:

- `ScanSetting` — the recurring-schedule object. A `debug: true` here propagates into every scan that the setting drives. Use this when "any scan run by this schedule" needs the extra logs.
- `ComplianceScan` — an individual scan instance. A `debug: true` here applies only to that one scan and persists through reruns of the same instance. Use this when only one specific scan is misbehaving and the rest of the schedule is fine.

The flag is consumed by the operator that creates each scan pod. When `debug: true` is set, the operator passes the OpenSCAP CLI a higher verbosity level and instructs the scanner image to log the probe-level execution. When `debug: false` (or unset), the operator passes the default verbosity. There is no in-pod environment variable that overrides the CR setting — the flag must be on one of the two CRs.

A second behaviour matters for the workflow: changing `debug` on either CR does not retroactively re-emit logs for the *previous* scan pods, because those pods have already exited and their stdout has been captured. The change takes effect on the **next** scan pod the operator creates. A re-run is therefore part of the procedure, not an optional step.

## Resolution

### Method 1 — flip debug at the schedule level (`ScanSetting`)

Use this when the recurring scan that backs a profile (for example, the standard daily/weekly schedule that every node in the cluster is bound to) needs to start producing verbose logs across the board.

Edit the relevant `ScanSetting` in the namespace where the compliance components live:

```bash
kubectl -n compliance edit scansetting <scansetting-name>
```

Add `debug: true` at the top level of the spec — it sits alongside `roles`, `scanTolerations`, and `schedule`:

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: ScanSetting
metadata:
  name: <scansetting-name>
  namespace: compliance
debug: true
roles:
  - master
  - worker
scanTolerations:
  - operator: Exists
schedule: "0 1 * * *"
```

Apply the change and trigger a re-run of any binding that uses this `ScanSetting`. The simplest way is to delete the bound `ComplianceScan` instances so the operator recreates them:

```bash
kubectl -n compliance delete compliancescan -l compliance.alauda.io/suite=<binding-name>
```

The operator detects the deletion, schedules new scan pods for each role, and the new pods produce verbose logs.

### Method 2 — flip debug on a single instance (`ComplianceScan`)

Use this when only one scan instance (out of several driven by the same schedule) is misbehaving, and turning verbosity on across the schedule would produce more log volume than the cluster's log pipeline wants.

Edit the specific `ComplianceScan` CR:

```bash
kubectl -n compliance edit compliancescan <compliancescan-name>
```

Set `debug: true` in the spec:

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: ComplianceScan
metadata:
  name: <compliancescan-name>
  namespace: compliance
spec:
  debug: true
```

Trigger a re-run of just this instance. The operator-supported way is the `ComplianceSuite` rerun annotation, which causes the operator to recreate the scan pods for this instance only:

```bash
kubectl -n compliance annotate compliancescan <compliancescan-name> \
  compliance.alauda.io/rescan="" --overwrite
```

The recreated scan pods inherit the new debug flag.

### Reverting

Once the troubleshooting question is answered, set the flag back to `false` (or remove the field) on the same CR — leaving it on long-term inflates log storage costs and makes the per-scan log harder to scan visually:

```bash
kubectl -n compliance patch scansetting <scansetting-name> --type=merge \
  -p '{"debug":false}'
```

Or for a single scan:

```bash
kubectl -n compliance patch compliancescan <compliancescan-name> --type=merge \
  -p '{"spec":{"debug":false}}'
```

The next scan run reverts to the default verbosity.

### Fallback: upstream OpenSCAP-based Compliance Operator on a raw Kubernetes cluster

When running the open-source Compliance Operator directly on a plain Kubernetes cluster (not through the platform's Compliance Service extension), the same two-CR pattern applies and the field names are identical — only the API group prefix and the install namespace differ per the upstream defaults. The flag `debug: true` lives at the top level of the `ScanSetting` and at `spec.debug` of the `ComplianceScan`, and a rescan is still required for the new pods to pick up the change. The behavioural contract is the same: the operator regenerates scan pods with elevated OpenSCAP verbosity, the new pods log probe-by-probe, and `false`-then-rescan returns to the quiet default.

## Diagnostic Steps

Confirm which CR is currently driving the scan in question — verbose logging is wasted effort if the misbehaving scan is bound to a different `ScanSetting` than the one being edited:

```bash
kubectl -n compliance get scansettingbinding -o yaml \
  | grep -E 'name:|settingsRef:|profiles:'
```

Each binding lists the `ScanSetting` it points at via `settingsRef.name`. The `ComplianceScan` instances created for a binding are labelled with the binding name, which lets a single grep map scan → binding → `ScanSetting`.

After the flag is applied and the rescan is triggered, watch the new scan pods come up:

```bash
kubectl -n compliance get pod -l workload=scanner -w
```

When a new pod is `Running`, sample its log to confirm the verbosity is actually elevated. The default (non-debug) log is short and ends with a result summary. The debug log shows probe-level execution and OpenSCAP-internal messages:

```bash
kubectl -n compliance logs <new-scan-pod> --tail=100
```

If the new pod's log volume looks the same as before, the operator did not pick up the flag — usually because the rescan was triggered against a stale `ComplianceScan` (the operator regenerated the same pods without observing the CR edit). Re-issue the rescan annotation, or delete the `ComplianceScan` outright and let the binding recreate it from the updated `ScanSetting`.

To confirm the operator itself observed the flag change, inspect its log:

```bash
kubectl -n compliance logs deploy/compliance-operator --tail=200 \
  | grep -E 'debug|reconcile|ScanSetting|ComplianceScan'
```

A successful reconcile prints the resolved `debug` value when it generates the next scan pod spec.
</content>
</invoke>
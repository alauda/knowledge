---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# OLM `InstallPlanStepAppliedWithWarnings` Alerts — Triage by Warning Category
## Issue

After installing an operator through OLM, the cluster fires an `InstallPlanStepAppliedWithWarnings` alert against the new `InstallPlan`. The event text names the operator and one of its bundled CRDs with a warning that OLM captured while applying the CRD to the API server:

```text
Event:
  Kind:        InstallPlan
  Namespace:   operators
  Name:        install-vrgkn
  APIVersion:  operators.coreos.com/v1alpha1
  Type:        Warning
  Reason:      AppliedWithWarnings
  Message:     1 warning(s) generated during installation of operator
               "servicemeshoperator3.v3.1.0" (CustomResourceDefinition
               "virtualservices.networking.istio.io"):
               unrecognized format "binary"
```

The operator itself reaches `Succeeded` and workloads using its CRs function normally — the warning is informational about the CRD's OpenAPI schema, not an actual install failure. The question is how to triage: which `AppliedWithWarnings` entries can be safely dismissed and which deserve follow-up.

## Root Cause

Starting in newer Kubernetes / platform releases, the API server validates CustomResourceDefinition schemas more strictly at apply time. Two categories of warning commonly surface:

1. **Schema strictness warnings** — `unrecognized format "<name>"`, `unrecognized format "date-time-with-timezone"`, etc. The CRD author used an OpenAPI format string that the API server does not recognise; the server accepts the CRD but records the warning so operators and maintainers know the schema is not fully conformant.

2. **Deprecation warnings** — `<group>/<old-version> <Kind> is deprecated; use <group>/<new-version>`. The CRD carries a version annotated as deprecated in the operator's own schema; the warning is a proactive notice that a future operator release will remove it.

Both are emitted by OLM at apply time and relayed as Events on the `InstallPlan`. The alert firing on top is simply the monitoring stack surfacing the event.

OLM does not write the CRD content — operator maintainers do. The warning is therefore not resolvable by the cluster operator; it has to be fixed upstream (in the operator bundle) and reach the cluster through an operator upgrade. Until then, the event categorisation determines how to respond.

## Resolution

### Category 1 — schema strictness warning

A warning like `unrecognized format "binary"` is safe to ignore at the cluster-operator level. The CRD works, the operator runs, and no downstream functionality depends on the specific format string the API server failed to recognise.

**Action**: silence / ignore the alert, but open an issue against the operator's maintainers so the CRD's next revision uses a valid format string.

Example — `binary` is often replaced by `byte` (the OpenAPI-compliant format for base64-encoded data). The operator's maintainers update the CRD, ship a new version, and the warning disappears when the operator upgrades on the cluster.

### Category 2 — deprecation warning

A warning like:

```text
sailoperator.io/v1alpha1 ZTunnel is deprecated; use sailoperator.io/v1 ZTunnel
```

is a proactive notice with a real future action: when the operator removes the deprecated version, any CR of that type still using the old version will become invalid. Triage this more carefully.

**Action**: audit all CRs of the named type to confirm none are on the deprecated version:

```bash
kubectl get ztunnels.v1alpha1.sailoperator.io -A
```

Migrate any to the new version as documented by the operator's upgrade notes. Do this before the deprecated version is actually removed in a future upgrade; once removed, the old CRs cannot even be read without API-server help.

### Category 3 — any other message

Warnings outside of the two common patterns above deserve a one-off read. The `AppliedWithWarnings` machinery is a generic catch-all; vendors can attach custom messages that indicate specific configuration or environment issues. Read the message, check the operator's release notes and known-issues list, and act accordingly.

### What OLM cannot fix for you

OLM is a delivery mechanism; it does not edit the CRD content it delivers. There is no `--ignore-warnings` flag or similar knob on `Subscription` or `InstallPlan`. Reducing the noise requires either:

- The operator maintainer ships an updated CRD that the API server accepts without warnings, delivered through an operator upgrade.
- The cluster silences the specific alert in the monitoring stack's alert routing (only appropriate for Category 1 warnings; deprecation warnings should not be silenced permanently).

### Silencing the alert in the monitoring stack

For a Category 1 warning that you want to quiet while the upstream fix makes its way through operator releases:

```yaml
# In Alertmanager's silence configuration.
matchers:
  - name: alertname
    value: InstallPlanStepAppliedWithWarnings
    isRegex: false
  - name: namespace
    value: operators
    isRegex: false
startsAt:  <now>
endsAt:    <now + 30d>
createdBy: "ops-team"
comment: "Silenced schema-strictness warning in <operator-name>'s CRD.
          Tracked upstream at <issue-url>. Revisit after operator upgrade."
```

Keep the silence time-boxed so the issue does not fall out of sight once the operator upgrades.

## Diagnostic Steps

Enumerate all `AppliedWithWarnings` events across namespaces to see the full picture before silencing:

```bash
kubectl get events -A --field-selector reason=AppliedWithWarnings \
  -o custom-columns='NS:.involvedObject.namespace,KIND:.involvedObject.kind,NAME:.involvedObject.name,MSG:.message'
```

Read each message. Most will be schema-strictness; occasionally a deprecation slips in.

Read the specific `InstallPlan` to see which step carried the warning and which CRD it applied:

```bash
kubectl -n <ns> get installplan <name> -o json | \
  jq '.status.plan[] | select(.status == "AppliedWithWarnings") | {resource, resolving, conditions}'
```

The `resolving` field names the CRD; the `conditions` field captures the warning text. Cross-reference with the operator's upstream release notes to know whether the warning is on the maintainer's fix list.

After an operator upgrade, re-run the event query. Warnings that were in Category 1 should disappear. Warnings that persist after the upgrade mean either the CRD's schema issue has not been fixed yet (open an issue upstream) or the warning is Category 2/3 and needs additional action beyond upgrading.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A cluster with the Compliance Operator installed reports `audit-log-forwarding-enabled` as **FAIL** in its latest `ComplianceScan`, even though audit logs are being forwarded correctly through a multi-instance `ClusterLogForwarder` (CLF) configuration. Running the same check by hand against the live CLF shows the expected pipelines, inputs, and outputs — the forwarding is working.

The failing rule is part of the shipped CIS content:

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: Rule
description: |-
  Ensure that Audit Log Forwarding Is Enabled. The cluster logging stack
  can forward API-server audit logs to an external sink through the
  ClusterLogForwarder resource.
instructions: |-
  Check that a ClusterLogForwarder exists with an `audit` input ref:
  kubectl get clusterlogforwarders instance -n cluster-logging -o json \
    | jq -r '.spec.pipelines[].inputRefs | contains(["audit"])'
  The output should return true.
```

The `instructions:` field hard-codes the name `instance` and the namespace `cluster-logging`. On a cluster that uses the newer multi-CLF shape — where multiple `ClusterLogForwarder` objects can coexist under any name in any namespace — the rule's `jq` probe cannot find a CLF by that specific name and reports non-compliance, regardless of whether audit forwarding is in fact configured.

The same false-positive shape can appear for any rule that probes output types in the CLF spec — `cloudwatch`, `elasticsearch`, `googleCloudLogging`, `http`, `kafka`, `loki`, `lokistack`, `otlp`, `splunk`, `syslog` — when the rule's instructions were authored against the single-CLF naming convention but the cluster now runs a multi-instance topology.

## Root Cause

Older revisions of the CIS compliance content bundled with the Compliance Operator were written when `ClusterLogForwarder` admitted at most a single instance per cluster, conventionally named `instance` in the `cluster-logging` namespace. The rule's inline `instructions` encoded that assumption.

The multi-CLF feature, shipped with the v6-series logging stack, removed the single-instance restriction: any number of CLF objects, any namespace, any name. Rule revisions published before that feature landed continue to look for `instance` specifically, so the probe fails on clusters that have adopted the new shape — **regardless** of whether audit forwarding is actually enabled.

The Compliance Operator's scan reports what its content says it sees, so the rule result is a faithful reflection of the probe's literal outcome rather than a defect in forwarding. The cluster audit pipeline is fine; the rule is not.

## Resolution

Two paths are available, and both are safe to combine.

### Update the Compliance Operator content

The preferred fix is to run a rule revision that understands multi-CLF. Content bundled with Compliance Operator **v1.7 and later** drops the hard-coded `instance` name and walks every `ClusterLogForwarder` on the cluster before concluding. Upgrade the operator through the platform's operator-management surface; on the next scheduled scan the rule evaluates the actual CLF inventory and passes.

### Tailor the rule out until the content is updated

If the operator cannot be upgraded yet (cluster is at a pinned version, maintenance window not scheduled, or the update has to wait on change control), tailor the affected rule out of the active profile. A `TailoredProfile` extends a base profile, keeps the rest of its rule set, and disables the specific rule:

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: TailoredProfile
metadata:
  name: cis-node-audit-tailored
  namespace: compliance
  annotations:
    compliance.alauda.io/product-type: Platform
spec:
  extends: cis-node            # base profile to start from
  title: CIS node profile excluding audit-log-forwarding false positive
  description: >-
    Disables the audit-log-forwarding rule while the bundled CIS content
    still assumes a single `instance` ClusterLogForwarder. The actual
    audit pipeline is verified separately through the ClusterLogForwarder
    status and the downstream log-collection sink.
  disableRules:
    - name: audit-log-forwarding-enabled
      rationale: >-
        Bundled CIS content predates multi-CLF. Forwarding is confirmed
        through the CLF's own Ready condition and sink-side receipts.
```

Bind the tailored profile to the scheduled scan with a `ScanSettingBinding`:

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: ScanSettingBinding
metadata:
  name: cis-node-tailored-binding
  namespace: compliance
profiles:
  - apiGroup: compliance.alauda.io/v1alpha1
    kind: TailoredProfile
    name: cis-node-audit-tailored
settingsRef:
  apiGroup: compliance.alauda.io/v1alpha1
  kind: ScanSetting
  name: default
```

The next scheduled scan uses the tailored profile and no longer reports the false positive. Track the tailored entry so the rule can be re-enabled once the operator is upgraded — a growing `disableRules` list erodes the value of the scan.

### Confirm audit forwarding independently

Neither path above actually verifies that audit logs are being shipped. Do that separately so the scan result is not the only signal in the loop:

```bash
# 1. Every ClusterLogForwarder on the cluster has a Ready condition.
kubectl get clusterlogforwarders -A \
  -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status'

# 2. At least one CLF pipeline carries the `audit` input ref.
kubectl get clusterlogforwarders -A -o json | \
  jq -r '.items[] | select(.spec.pipelines[]?.inputRefs[]? == "audit")
         | "\(.metadata.namespace)/\(.metadata.name)"'
```

If step 1 returns Ready for every CLF and step 2 lists at least one CLF, audit forwarding is enabled in effect and the scan failure is a content issue — not a forwarding issue.

## Diagnostic Steps

Inspect the specific `ComplianceCheckResult` the rule produced to confirm the false-positive shape:

```bash
kubectl get compliancecheckresult -A \
  -l compliance.alauda.io/scan-name=<scan-name> \
  -o custom-columns='NAME:.metadata.name,STATUS:.status'

kubectl -n compliance get compliancecheckresult \
  <scan-name>-audit-log-forwarding-enabled -o yaml
```

The `instructionsMessage` field contains the exact probe the rule ran. If it references a CLF name that does not exist (`instance` in the default content) while `kubectl get clusterlogforwarders -A` returns one or more CLFs under different names, the FAIL is the false positive this note describes.

Cross-check the Compliance Operator version to decide whether to upgrade or tailor:

```bash
kubectl -n compliance get subscription compliance-operator \
  -o jsonpath='{.status.installedCSV}{"\n"}' 2>/dev/null || \
kubectl -n compliance get csv \
  -o jsonpath='{range .items[?(@.spec.displayName=="Compliance Operator")]}{.metadata.name}{"\n"}{end}'
```

Operator versions before v1.7 ship the affected rule content; v1.7 and later carry the multi-CLF-aware revision.

After applying the upgrade or the `TailoredProfile`, trigger a re-scan by patching the `ComplianceSuite` or waiting for the next scheduled interval. Confirm the rule now returns `PASS` (upgrade path) or `SKIPPED` (tailored-out path) in the next `ComplianceCheckResult`.

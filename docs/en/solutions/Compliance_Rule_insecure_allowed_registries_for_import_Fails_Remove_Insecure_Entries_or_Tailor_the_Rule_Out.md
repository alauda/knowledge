---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Compliance Rule `insecure-allowed-registries-for-import` Fails — Remove Insecure Entries or Tailor the Rule Out
## Issue

The Compliance Operator's CIS profile reports `insecure-allowed-registries-for-import` as **FAIL**:

```text
NAME                                                      STATUS  SEVERITY
cis-1-7-insecure-allowed-registries-for-import   FAIL    medium
```

The cluster's image configuration explicitly allows one or more registries to be imported **over plaintext HTTP** — the rule is specifically checking that no registry listed under `allowedRegistriesForImport` carries `insecure: true`. On a compliant cluster, every entry in that list should be `insecure: false` (or omit the field entirely, which defaults to secure).

The CIS content treats any `insecure: true` entry as a deviation from secure-by-default posture and marks the rule as failing regardless of business context.

## Root Cause

The image-configuration CR (at `.spec.allowedRegistriesForImport`) enumerates every registry host that users may import images from. Each entry takes a `domainName` and a boolean `insecure`:

```yaml
spec:
  allowedRegistriesForImport:
    - domainName: quay.io
      insecure: false
    - domainName: internal-registry.svc
      insecure: true          # <-- the trigger
```

The CIS rule walks every entry. One `insecure: true` anywhere → the rule reports `FAIL`. The rule does not grade how many entries are insecure; it is a binary "all secure or nothing".

Two legitimate situations lead here:

1. **An internal or development registry genuinely cannot serve TLS** — bootstrapping environments, air-gapped disconnected mirrors during migration, labs without a PKI. The `insecure: true` is intentional.
2. **A historical entry was never cleaned up** — a registry decommissioned long ago still appears in the list with `insecure: true`. Removing the entry is a pure cleanup.

The rule cannot distinguish between the two; only the operator who owns the cluster's registry policy knows which applies.

## Resolution

Either remove the insecure entries (preferred for production), or tailor the rule out if the insecure setting is genuinely required.

### Path A — remove insecure entries (preferred)

If any entry with `insecure: true` is not actually needed, edit the image-configuration CR:

```bash
kubectl edit image.config.alauda.io/cluster
```

Remove the offending entries entirely, or change `insecure: true` to `insecure: false` if the registry now serves TLS:

```yaml
spec:
  allowedRegistriesForImport:
    - domainName: quay.io
      insecure: false
    - domainName: internal-registry.svc
      insecure: false            # was true
```

Save and exit. The next compliance scan evaluates against the updated configuration and the rule transitions to `PASS`.

If the removed registry is legitimately needed but now serves TLS, make sure to first point it at a valid certificate. Testing the TLS handshake before changing the `insecure` flag:

```bash
echo Q | openssl s_client -connect internal-registry.svc:443 -servername internal-registry.svc < /dev/null 2>/dev/null | \
  grep -E 'subject|issuer|notAfter'
```

If the handshake fails, the registry is not actually ready for `insecure: false`; finish the TLS rollout first.

### Path B — tailor the rule out for unavoidable insecure registries

If the insecure registry is genuinely required (a bootstrapping or air-gapped scenario), `PASS` can be restored by tailoring the rule out of the active profile. A `TailoredProfile` extends the base CIS profile and disables the specific rule:

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: TailoredProfile
metadata:
  name: cis-1-7-insecure-registries-tailored
  namespace: compliance
spec:
  extends: cis-1-7
  title: CIS 1.7 profile tolerating one known-insecure registry
  description: >-
    internal-registry.svc serves HTTP only; documented and accepted in
    runbook <link>. This tailoring records the exception so scheduled
    scans do not re-flag it on every run.
  disableRules:
    - name: cis-1-7-insecure-allowed-registries-for-import
      rationale: >-
        Scenario has a documented insecure registry; tracked separately
        from the compliance scan.
```

Then bind the tailored profile through a `ScanSettingBinding`:

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: ScanSettingBinding
metadata:
  name: cis-1-7-tailored-binding
  namespace: compliance
profiles:
  - name: cis-1-7-insecure-registries-tailored
    kind: TailoredProfile
    apiGroup: compliance.alauda.io/v1alpha1
settingsRef:
  name: default
  kind: ScanSetting
  apiGroup: compliance.alauda.io/v1alpha1
```

The next scan against the tailored profile marks the rule as `SKIP` / `NOT-APPLICABLE` and the overall scan reaches `PASS` again. Keep the tailoring scope tight — a tailored profile should be a short-ish-lived concession, not a permanent escape hatch.

### Document the exception

Whichever path is chosen, record the decision in the cluster's runbook / compliance documentation. Path A resolves to a clean CIS-compliant state; Path B is an accepted deviation that auditors will ask about. Both are defensible with the right paper trail.

## Diagnostic Steps

Inspect the image configuration:

```bash
kubectl get image.config.alauda.io/cluster -o yaml | \
  yq '.spec.allowedRegistriesForImport'
```

Any entry with `insecure: true` is the trigger. Remove them (Path A) or document them (Path B).

Read the failing compliance check result for full context:

```bash
kubectl -n compliance get compliancecheckresult \
  | grep -i 'insecure-allowed-registries-for-import'

kubectl -n compliance get compliancecheckresult \
  <suite-name>-insecure-allowed-registries-for-import -o yaml | \
  yq '.status'
```

The `status` field echoes the observed value and the expected one; useful for showing in an audit that the specific entries were flagged.

After applying Path A, trigger a rescan rather than waiting for the next scheduled interval:

```bash
kubectl -n compliance annotate compliancesuite <suite-name> \
  compliance.alauda.io/rescan="" --overwrite
kubectl -n compliance get compliancecheckresult -w | \
  grep -i 'insecure-allowed'
```

The rule should transition to `PASS` within one scan cycle (typically 1-2 minutes). For Path B, the rule reports `SKIPPED` / `NOT-APPLICABLE` — which is the expected post-tailoring state.

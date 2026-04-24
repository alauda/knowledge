---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The Compliance Operator's CIS profile reports the `cis-insecure-registries` rule as **FAIL**:

```text
NAME                               STATUS  SEVERITY
cis-1-7-insecure-registries        FAIL    medium
```

The rule checks the `spec.registrySources.insecureRegistries` list on the cluster's image-configuration CR and fails when the list is non-empty — regardless of which specific entries it contains. One or more domains listed there puts the cluster in the "allows plaintext registry traffic" posture the CIS profile does not accept.

This is a sibling rule of `insecure-allowed-registries-for-import`; they check adjacent but distinct fields on the same CR and have the same triage shape.

## Root Cause

The image-configuration CR has two related fields that control which registries the cluster will accept insecure connections from:

```yaml
apiVersion: config.alauda.io/v1
kind: Image
metadata:
  name: cluster
spec:
  # Per-entry list with explicit insecure flag; covered by a different rule.
  allowedRegistriesForImport:
    - domainName: quay.io
      insecure: false

  # Global list — ANY entry here is flagged by this rule.
  registrySources:
    insecureRegistries:
      - internal-registry.svc:5000      # <-- the trigger
```

`registrySources.insecureRegistries` is a flat list; there is no per-entry `insecure` flag to tune. Presence of any domain name puts the rule into `FAIL`. The rule's CIS logic is "secure registries only, no exceptions in the list".

Legitimate reasons the list has entries include:

- An in-cluster self-hosted image registry that serves plaintext inside the cluster network.
- A lab / development registry without TLS.
- A disconnected-install bootstrap registry used before the full PKI rolls out.

Each of those is a valid operational choice; none of them matches the CIS profile's blanket requirement.

## Resolution

### Path A — empty the list (preferred for production)

If the entries are not strictly needed, remove them:

```bash
kubectl edit image.config.alauda.io/cluster
```

Delete the `registrySources.insecureRegistries` list entirely (or set it to `[]` explicitly). Other registry sources (`containerRuntimeSearchRegistries`, `blockedRegistries`, `allowedRegistries`) continue to apply independently:

```yaml
spec:
  registrySources:
    allowedRegistries:
      - quay.io
      - registry.example.com
    # insecureRegistries removed.
```

After saving, re-trigger the compliance scan (see Diagnostic Steps). The rule transitions to `PASS`.

If the list held an internal registry that needs to stay reachable, front it with TLS first — issue a certificate from the cluster's trust chain and move the registry from the insecure list to either `allowedRegistries` (restricted allowlist) or omit it from the insecure list and let the cluster reach it normally.

### Path B — tailor the rule out with a rationale

If the insecure registry is genuinely required and the operational decision is to accept the deviation, tailor the CIS profile to disable this specific rule:

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: TailoredProfile
metadata:
  name: cis-1-7-insecure-registries-tailored
  namespace: compliance
spec:
  extends: cis-1-7
  title: CIS 1.7 tailored for an in-cluster insecure mirror
  description: >-
    An in-cluster image registry serves plaintext on the cluster network
    by design; documented in runbook <link>.
  disableRules:
    - name: cis-1-7-insecure-registries
      rationale: >-
        In-cluster mirror cannot serve TLS; traffic stays on the pod
        network and does not transit untrusted networks.
```

Bind through a `ScanSettingBinding`:

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

After the tailored suite runs, the rule reports `SKIPPED` / `NOT-APPLICABLE` and the overall scan reaches `PASS`.

### Document the decision

Either path must be documented alongside the cluster's compliance evidence. Auditors accept tailored deviations when the rationale is clear and revisited periodically; they object when the deviation is undocumented or left behind after the justifying condition has ended.

### If you disable the rule, also monitor the list separately

A tailored-out CIS rule does not fire when entries are added to the list. Set up a separate alert on the image-configuration CR's `registrySources.insecureRegistries` changes — the auditing value of the CIS rule is restored by the alert even though the CIS rule itself is suppressed.

## Diagnostic Steps

Read the current list:

```bash
kubectl get image.config.alauda.io/cluster -o yaml | \
  yq '.spec.registrySources.insecureRegistries'
```

Non-empty output is the trigger. Remove all entries (Path A) or document them (Path B).

Inspect the specific compliance check for the details the rule captured:

```bash
kubectl -n compliance get compliancecheckresult \
  | grep -i 'insecure-registries'

kubectl -n compliance get compliancecheckresult \
  <suite-name>-insecure-registries -o yaml | \
  yq '.status'
```

After applying the fix, rescan rather than waiting for the next scheduled interval:

```bash
kubectl -n compliance annotate compliancesuite <suite-name> \
  compliance.alauda.io/rescan="" --overwrite
```

Watch the result:

```bash
kubectl -n compliance get compliancecheckresult -w | \
  grep -i 'insecure-registries'
```

`PASS` (Path A) or `SKIPPED` (Path B) confirms the fix is in effect.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Compliance Scan `oauth-or-oauthclient-token-maxage` Keeps Failing — Set the Profile Variable via TailoredProfile
## Issue

A `ComplianceScan` keeps flagging `ocp4-moderate-oauth-or-oauthclient-token-maxage` as **FAIL**, even though the cluster's OAuth (or OAuthClient) configuration **has** been tuned to the intended token lifetime. The rule's own description says the token max-age should match a documented value, and the cluster does in fact use a custom `accessTokenMaxAgeSeconds`:

```text
NAME                                                          STATUS   SEVERITY
ocp4-moderate-oauth-or-oauthclient-token-maxage               FAIL     medium
```

The failure is not caused by a misconfigured OAuth object. It is caused by the rule's expected value defaulting to 24 hours (86400 seconds) while the cluster's `accessTokenMaxAgeSeconds` is set to something else. The rule's check compares the observed lifetime against a **variable** that the compliance content defines, and that variable carries its default until overridden.

## Root Cause

The shipped rule does not embed a hard-coded threshold. It reads its expected value from a compliance **variable** named `ocp4-var-oauth-token-maxage`, which the content pack defaults to 86400 seconds. Any cluster whose actual token lifetime diverges from 86400 fails the rule until the variable is told what the new intended value is.

Compliance variables cannot be edited on a shipped profile (the operator reconciles the profile back to the content pack). Overriding a variable means creating a `TailoredProfile` that extends the base profile and sets the variable to the new value — a standard tailoring pattern for compliance content where the rule logic is fine but a threshold or list needs to be adjusted for the environment.

## Resolution

Author a `TailoredProfile` that extends `ocp4-moderate` (or whichever base profile carries the rule) and sets `ocp4-var-oauth-token-maxage` to the cluster's actual value in seconds. Then bind the tailored profile through a `ScanSettingBinding` so scheduled scans evaluate against the new expected value.

### Create the TailoredProfile

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: TailoredProfile
metadata:
  name: moderate-oauth-tuned
  namespace: compliance
spec:
  extends: ocp4-moderate
  title: Moderate profile with OAuth token max-age tuned to the cluster value
  description: >-
    Overrides the ocp4-var-oauth-token-maxage variable so the
    oauth-or-oauthclient-token-maxage rule evaluates against the cluster's
    actual accessTokenMaxAgeSeconds (43200 = 12 hours), matching the
    documented policy for this environment.
  setValues:
    - name: ocp4-var-oauth-token-maxage
      rationale: >-
        Cluster policy is 12 hours, not the content's 24-hour default.
      value: "43200"
```

Replace `43200` with the cluster's actual policy value in seconds. Document the rationale in the `rationale` field — compliance reviewers will see it when auditing the tailoring.

Apply:

```bash
kubectl apply -f tailored-profile-oauth.yaml
```

### Bind the TailoredProfile through a ScanSettingBinding

The `TailoredProfile` alone does not schedule a scan. Pair it with an existing `ScanSetting` (the `default` setting is a common starting point) through a `ScanSettingBinding`:

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: ScanSettingBinding
metadata:
  name: moderate-oauth-tuned-binding
  namespace: compliance
profiles:
  - name: moderate-oauth-tuned
    kind: TailoredProfile
    apiGroup: compliance.alauda.io/v1alpha1
settingsRef:
  name: default
  kind: ScanSetting
  apiGroup: compliance.alauda.io/v1alpha1
```

Apply:

```bash
kubectl apply -f scansettingbinding-oauth.yaml
```

The binding triggers the Compliance Operator to reconcile a `ComplianceSuite` that runs the tailored profile on the next scheduled scan. Watch:

```bash
kubectl -n compliance get compliancesuite -w
```

Once the suite completes a run, the `ComplianceCheckResult` for the tuned rule should flip from `FAIL` to `PASS` (assuming the cluster's OAuth config actually matches the value you set).

### Verify the new result

```bash
kubectl -n compliance get compliancecheckresult \
  | grep -i 'oauth-or-oauthclient-token-maxage'
```

The row that previously read `FAIL medium` should now read `PASS medium` (or `SKIPPED` if the rule does not apply to the tailored profile's scope).

Read the full result to confirm which value the rule observed on the cluster:

```bash
kubectl -n compliance get compliancecheckresult \
  <tailored-suite-name>-oauth-or-oauthclient-token-maxage -o yaml
```

The `instructionsMessage` field records what the rule actually saw — matching it against the variable confirms the tailoring took effect.

### If the cluster's OAuth value was the one needing fixing

If the variable **is** 86400 and it is the cluster's `accessTokenMaxAgeSeconds` that should be reduced instead, adjust the platform's authentication / OAuth configuration to the documented policy value. The compliance scan will then `PASS` against the shipped variable without any tailoring. Tailoring is the right answer only when the cluster's policy legitimately differs from the content's default.

## Diagnostic Steps

Read the current compliance variable value — without a tailoring, it carries its default:

```bash
kubectl -n compliance get variables -o \
  custom-columns='NAME:.metadata.name,VALUE:.value' \
  | grep oauth-token-maxage
```

`value:` equal to `86400` and a `ComplianceCheckResult` of `FAIL` for the rule confirms the default-vs-actual mismatch this note addresses.

Read the cluster's actual OAuth token lifetime from whichever configuration surface the platform exposes:

```bash
# The exact field path depends on the auth subsystem's CR.
# For OIDC/OAuth2-style configurations exposed through an operator CR:
kubectl get <oauth-cr-kind> cluster -o jsonpath='{.spec.tokenConfig.accessTokenMaxAgeSeconds}{"\n"}'
# For OAuthClient objects per application:
kubectl get oauthclient <name> -o jsonpath='{.spec.accessTokenMaxAgeSeconds}{"\n"}'
```

Compare the observed lifetime with the variable. Set the `TailoredProfile.spec.setValues[0].value` to the observed lifetime to match, or bring the OAuth config back to the variable's default. Either direction fixes the rule's `FAIL` outcome; the choice depends on which side reflects the intended policy.

After applying the tailoring, trigger an immediate re-scan instead of waiting for the next scheduled interval:

```bash
kubectl -n compliance annotate compliancesuite <suite-name> \
  compliance.alauda.io/rescan="" --overwrite
```

The suite reconciles, the scan runs, and the `ComplianceCheckResult` reflects the new outcome within the length of a scan cycle (typically one to two minutes for a moderate profile).

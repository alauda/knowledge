---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Compliance scan against the Kubernetes CIS Benchmark on Alauda Container Platform reports a 5.1.3 violation:

> Minimize wildcard use in Roles and ClusterRoles

The flagged objects are not user-authored; they are ClusterRoles installed automatically by Operator Lifecycle Manager (OLM) when an operator is subscribed. Their `rules[*].verbs` contain `*` (or `apiGroups`/`resources` use `*`), which is exactly the pattern CIS 5.1.3 forbids. The compliance dashboard shows the cluster as failing the benchmark even though no operator-author wrote the wildcard by hand.

## Root Cause

OLM generates a permissions-aggregating ClusterRole for every installed operator that participates in an `OperatorGroup`. The synthesised ClusterRole grants the operator full reach over the CRDs it owns, expressed with `*` verbs because the operator's `ClusterServiceVersion` (CSV) does not enumerate every verb the operator will need against its own CRDs.

The CIS Benchmark rule treats every wildcard `verbs` field as a finding regardless of provenance, so OLM-managed ClusterRoles trip the check on every cluster where any operator has been installed. The finding is technically accurate but operationally noise — it never goes away as long as OLM is in the picture and CSV authors continue to declare wildcard owns over their CRDs (which is the normal pattern).

The right long-term fix lives in the operator authoring side: CSVs should enumerate explicit verbs (`get`, `list`, `watch`, `create`, `update`, `patch`, `delete`) instead of `*`. Until that has propagated through every operator on the cluster, the benchmark cannot pass without an exception.

## Resolution

Use the platform's compliance solution's tailoring mechanism to suppress the rule for OLM-generated ClusterRoles only — keep the rule active for everything else (this is the value of the rule, after all).

### 1. Identify OLM-generated ClusterRoles

OLM stamps a recognisable `olm.owner` (or operator-name) label on the ClusterRoles it creates:

```bash
kubectl get clusterrole -l 'olm.owner!=,olm.owner.kind=ClusterServiceVersion' \
  -o name
```

A typical name pattern is `<operator>-<bundle>-<csv-version>`. These are the entries the CIS rule should not flag.

### 2. Author a TailoredProfile that excludes them

Add a tailoring CR (the exact CRD name varies by the compliance solution shipped on the cluster — `Kyverno ClusterPolicy` exception, OpenSCAP `TailoredProfile`, or the platform's compliance-service tailoring API). The pattern is:

```yaml
apiVersion: compliance.example.com/v1
kind: TailoredProfile
metadata:
  name: cis-with-olm-exception
spec:
  extends: cis-kubernetes
  disableRules:
    # Override CIS 5.1.3 globally — the CustomRule below replaces it
    - name: rule-clusterrole-wildcard-verbs
      rationale: Replaced by tailored rule that ignores OLM-generated roles
  customRules:
    - name: rule-clusterrole-wildcard-verbs-non-olm
      severity: medium
      check: |
        # any ClusterRole that has '*' in verbs / resources / apiGroups
        # AND does NOT carry an OLM owner label
        kind == "ClusterRole"
          and (
            rules[*].verbs[*]      contains "*" or
            rules[*].resources[*]  contains "*" or
            rules[*].apiGroups[*]  contains "*"
          )
          and not metadata.labels["olm.owner"]
```

(Adjust the schema to whatever the compliance scanner on the cluster uses; the substantive logic is "wildcard AND not OLM-owned".)

### 3. Re-scan

Trigger a fresh scan against the tailored profile:

```bash
kubectl apply -f cis-with-olm-exception.yaml
kubectl get scansetting,scanresult -A
```

The 5.1.3 finding should now be absent for OLM-managed ClusterRoles and present for any user-authored ClusterRole that still uses wildcards (which is the actual exposure you want flagged).

### 4. Push the fix upstream where you can

For operators built in-house, edit the CSV's `spec.install.spec.clusterPermissions[*].rules` to enumerate verbs explicitly. Once a CSV no longer generates wildcards, the OLM ClusterRoles it creates also lose the wildcards and the exception above stops applying to them.

## Diagnostic Steps

1. Locate the failing rule and the objects it points at:

   ```bash
   kubectl get scanresult -A -o json | jq -r '
     .items[] | select(.status.result == "FAIL")
     | .status.findings[]?
     | select(.rule | contains("clusterrole") and contains("wildcard"))
     | "\(.target.kind)/\(.target.name)"' | sort -u
   ```

2. For each flagged ClusterRole, confirm it really is OLM-owned:

   ```bash
   kubectl get clusterrole <name> -o jsonpath='
     {.metadata.labels.olm\.owner}{"\n"}
     {.metadata.labels.olm\.owner\.kind}{"\n"}'
   ```

   A non-empty `olm.owner` plus `olm.owner.kind=ClusterServiceVersion` confirms it.

3. After applying the tailored profile, re-run the scan and verify the failures drop:

   ```bash
   kubectl get scanresult -A | grep -c FAIL
   ```

4. Periodically audit the tailoring exception itself — if you ever onboard a non-OLM mechanism that also auto-creates wildcard ClusterRoles, broaden the exception with intent rather than letting the new source slip past unnoticed.

---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Why There Is No Separate PCI-DSS 4.0.1 Profile in the Compliance Operator — The v4.0 Profile Covers Both
## Overview

Auditors or internal compliance teams that are aligned against PCI-DSS **4.0.1** sometimes look for a dedicated `pci-dss-4-0-1` profile in the Compliance Operator and do not find one. The catalog stops at `pci-dss-4-0`:

```bash
kubectl get profiles.compliance.alauda.io -A | grep -i pci
# NAME                                         AGE
# pci-dss-4-0 (or similar, version-specific)   <age>
# pci-dss-node-4-0                             <age>
# (no separate *-4-0-1 entries)
```

The question this note answers is whether the absence is an oversight, a roadmap gap, or intentional — and what a 4.0.1-aligned audit should use.

## Why the v4.0 Profile Is the Authoritative Scanner for Both v4.0 and v4.0.1

PCI-DSS 4.0.1 is a **limited revision** of PCI-DSS 4.0 published by the PCI Security Standards Council. The scope of that revision is explicit in the PCI SSC's own release notes:

- No new requirements were added.
- No existing requirements were removed.
- No requirement numbering or structure changed.
- Changes are **editorial clarifications and errata** to existing requirements — wording tweaks that remove ambiguity, fix cross-references, and update examples.

From the perspective of automated scanning — which looks at each requirement's technical check — the rule set for 4.0 and 4.0.1 is **identical**. A profile that implements every technical check for 4.0 passes or fails identically when evaluated against 4.0.1. Creating a separate `4.0.1` profile with the same rules would be duplicated content with no additional coverage.

The Compliance Operator's PCI-DSS v4 profile therefore stands as the authoritative scanning tool for both versions. A compliance report produced against that profile satisfies the technical-evidence requirement for a 4.0.1 audit (subject to the usual caveat that an automated scan is one component of the overall audit, not the whole thing).

## What This Means for an Audit

### Scheduling and evidence collection

Use the existing v4 profile on a scheduled `ComplianceSuite`:

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: ScanSettingBinding
metadata:
  name: pci-dss-audit
  namespace: compliance
profiles:
  - name: pci-dss-4-0
    kind: Profile
    apiGroup: compliance.alauda.io/v1alpha1
  - name: pci-dss-node-4-0       # companion node-level profile
    kind: Profile
    apiGroup: compliance.alauda.io/v1alpha1
settingsRef:
  name: default
  kind: ScanSetting
  apiGroup: compliance.alauda.io/v1alpha1
```

The resulting `ComplianceSuite` runs both the cluster-level and the node-level PCI-DSS v4 profiles. The same evidence package supports either a 4.0 or 4.0.1 audit.

### Communicating with auditors

If an auditor specifically asks "where is the 4.0.1 profile", the cleanest answer is the PCI SSC's own one: 4.0.1 is editorial; the technical rule set is unchanged; the existing v4 profile's scan results are the authoritative technical evidence. Point them at the PCI SSC's release notes for 4.0.1 if necessary.

If the audit artifact template **requires** a label specifying "PCI-DSS 4.0.1", create a `TailoredProfile` that extends `pci-dss-4-0` and sets a distinguishing title / description:

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: TailoredProfile
metadata:
  name: pci-dss-4-0-1-labeled
  namespace: compliance
spec:
  extends: pci-dss-4-0
  title: "PCI-DSS 4.0.1 (technical ruleset identical to v4.0)"
  description: >-
    Scanning profile for PCI-DSS 4.0.1. Per PCI SSC, 4.0.1 is a limited
    revision of 4.0 containing editorial clarifications only; technical
    requirements are unchanged. This TailoredProfile reuses the v4.0
    ruleset verbatim while surfacing the 4.0.1 version label in reports.
```

The generated ComplianceSuite reports the same checks under the `pci-dss-4-0-1-labeled` name, satisfying strict audit templates.

### If the auditor's 4.0.1 checklist includes rules the operator does not implement

PCI-DSS, like most regulatory standards, covers more than a scanner can verify. Network segmentation audits, physical-security controls, personnel training documentation, and incident-response procedures are out of scope for any automated tool. The Compliance Operator's scan evidence covers only the automatable subset of technical requirements. The remainder of the audit is handled by the same process used for any previous PCI-DSS cycle — policy review, interviews, runbook inspection.

## Diagnostic Steps

List the PCI-DSS-related profiles the operator has installed on the cluster:

```bash
kubectl get profiles.compliance.alauda.io -A -o \
  custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,TITLE:.title' | \
  grep -iE 'pci|Title'
```

Inspect the `pci-dss-4-0` profile's rule count and a few sample rules to confirm it matches the technical requirements expected:

```bash
kubectl get profile.compliance.alauda.io -n compliance pci-dss-4-0 -o json | \
  jq '.rules | length, (.[:5])'
```

A non-trivial rule count (typically dozens to low hundreds) and recognisable rule names indicate the profile is complete. If it is, the v4 profile is what should be bound into any PCI-DSS 4.0 or 4.0.1 audit run.

If the audit is still in planning, document the rationale for why the v4.0 profile is used in place of a specific v4.0.1 profile. PCI SSC release notes and this explanation together form sufficient auditor-ready documentation.

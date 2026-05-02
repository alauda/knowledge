---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Compliance Report Export Lacks Scan-Execution Timestamp in Report Body
## Issue

When the Container Security extension produces a compliance report and an operator exports it from the console, the resulting archive carries a UTC timestamp embedded in the *filename* — for example `compliance-report-2026-03-31T22_56_39Z.zip`. The contents inside the archive (CSVs, summary spreadsheets, evidence files) carry the rule, the result, and the cluster identification, but they do **not** carry a column or metadata field that records *when the underlying compliance scan actually ran*.

Two practical pains follow:

- as soon as a report is renamed (or unzipped, or copied into a centralised audit folder, or stored in an evidence-retention system that rewrites filenames), the only piece of timing information disappears;
- when many reports are merged into a single review document, every row looks the same — there is no way for an auditor to tell which rows came from which scan run, or whether a particular finding is from this morning's scheduled scan or last week's manual rerun.

The expectation is that the report body itself should carry a "Scan Execution Time" field per row (or at minimum a header timestamp inside the archive), so the timing context survives any file-system handling.

## Root Cause

This is a product-side gap, not a misconfiguration. The export pipeline in the in-cluster compliance-reporting flow (the StackRox-derived runtime that backs the Container Security extension on ACP) renders one report per scan and emits the report archive with the scan timestamp embedded in the filename. The renderer does **not** stamp the same timestamp inside the archive contents, because the report template predates the use case where reports are aggregated outside the console.

There is no scanner-side or operator-side configuration that adds the field — the data model the renderer reads from does include the scan's execution time (it has to, to construct the filename), but the report templates do not surface it. Until the renderer is updated to include it, exported archives carry the timestamp only in metadata that is fragile to file handling.

This has been raised upstream as a feature request against the open-source code base; there is no in-cluster workaround that makes the renderer add the field today.

## Resolution

For now, treat the filename timestamp as the canonical scan-execution time and capture it before the file is renamed or moved. Two practical patterns:

**Capture the timestamp at export, separate from the file.** When pulling reports for an audit run, record the export filename verbatim into the same evidence index that catalogues the report content. The filename pattern is fixed (`compliance-report-<RFC3339-ish>.zip`) and the timestamp portion is the scan's UTC execution time, so a single regex extracts it:

```bash
# Index reports as they arrive in the audit-evidence directory.
for f in compliance-report-*.zip; do
  ts=$(printf '%s\n' "$f" \
        | sed -E 's/^compliance-report-([0-9T_Z:-]+)\.zip$/\1/' \
        | tr '_' ':')
  printf '%s\t%s\n' "$ts" "$f"
done > scan-timestamps.tsv
```

Anything downstream that consumes the report body can join on `scan-timestamps.tsv` to recover the timing.

**Wrap the export with a manifest.** Before handing the archive to a downstream consumer, add a small `manifest.json` next to it (or rezip the report with the manifest included) that carries the scan name, the scan execution timestamp, and the cluster identifier. This puts the timing on a footing that survives renaming:

```bash
unzip -d work/ compliance-report-2026-03-31T22_56_39Z.zip
cat > work/manifest.json <<JSON
{
  "scanExecutionTime": "2026-03-31T22:56:39Z",
  "scanName": "<scan-name>",
  "cluster": "<cluster-id>"
}
JSON
( cd work && zip -r ../compliance-report-with-manifest.zip . )
```

Both patterns are workarounds for the missing in-archive field; neither requires any change to the scanner or report-renderer configuration. The render-side fix (a `Scan Execution Time` column inside the report itself) is tracked as a feature request against the upstream code base — once it lands, the workarounds can be retired.

There is no equivalent issue in the open-source compliance-scanning path that the Compliance Service extension uses (`ComplianceScan` → `ComplianceCheckResult` CRDs): each `ComplianceCheckResult` carries its scan reference and the scan carries timing metadata directly on the CR, so any report built off the CR data inherits the timestamp without needing a separate manifest.

## Diagnostic Steps

Confirm the gap is the missing in-archive timestamp and not, for example, a stripped filename:

```bash
unzip -l compliance-report-2026-03-31T22_56_39Z.zip
unzip -p compliance-report-2026-03-31T22_56_39Z.zip <csv-or-spreadsheet> \
  | head -n 5
```

The listing shows the entries inside the archive; the second command prints the first few rows of one of them. If the rows lack a timestamp column and the archive lacks a top-level `manifest.json` (or equivalent), the gap is real and the workaround above applies.

To check whether the running build of the Container Security extension has already adopted an upstream fix, list the running pods of the central component and inspect the image tag — newer builds may carry the patched renderer once it lands upstream:

```bash
kubectl -n stackrox get pods -l app=central \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}'
```

If the export still emits archives without an in-archive timestamp on the latest available build, the upstream change has not landed yet — keep the wrapper-manifest workaround in place.
</content>
</invoke>
---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Why Container Security Scanners Report Different CVSS Scores for the Same CVE
## Overview

Container vulnerability scanners on ACP — whether built-in or a third-party product integrated via webhook / API — pull CVE data from multiple upstream sources and present a single score to the operator. The exact score for a given CVE can differ between scanners, or even between two consecutive scans of the same image on the same scanner, because the underlying data sources do not always agree.

A common question: why does the scanner report CVSS `9.8` for a particular CVE on one image but CVSS `7.5` for the same CVE on a different image (sometimes the same image scanned in a different context)? The scanner is not contradicting itself. It is picking between source datasets that legitimately carry different scores for the same advisory.

## Root Cause

The major CVE data sources differ in scope and methodology:

- **NVD (NIST National Vulnerability Database)** — the canonical CVE catalog. Scores are assigned by NIST analysts from the CVE description and reference material; the score is product-agnostic and represents the worst plausible exposure of the underlying flaw.
- **OSV (Open Source Vulnerability database, hosted by Google / OSV.dev)** — aggregates advisories specifically for open-source ecosystems (Go, Python, JavaScript, Java/Maven, Rust, Ruby, etc.). Scores track the upstream project's own rating and frequently diverge from NVD for language-specific packages.
- **Vendor VEX (Vulnerability Exploitability eXchange)** — a vendor's authoritative statement about whether a specific CVE affects a specific product under specific configurations. Scores reflect exploitability as that vendor's product actually ships: a vendor may score a CVE lower if their build is patched, or higher if their distribution's usage pattern is more exposed than the upstream average.
- **Language-ecosystem advisories** (GitHub Security Advisories, PyPI advisories, RustSec, etc.) — narrower still, often the earliest to publish for language packages and usually the closest to upstream authoritative.

A scanner therefore has to pick which source to trust for a given (image, package, CVE) triple. The choice depends on:

1. **The image's base**. For images built on a specific Linux distribution, the distribution's VEX data (when available) is usually preferred because it reflects that distribution's actual back-ported patches. For a base-less image or a non-vendor image, VEX data often does not exist for the CVE and the scanner falls through to NVD or OSV.
2. **The package type**. Language packages (Go modules, Python wheels, Java JARs, npm packages) are typically scored against OSV or the ecosystem's own advisory because VEX data rarely covers middleware built from generic upstream sources.
3. **Scanner configuration**. Most scanners expose a knob to restrict the source set — for example, a flag that forces VEX-only scoring for recognised distribution images, or one that disables OSV lookups entirely. These toggles change the visible score for a CVE without changing the underlying vulnerability.

The net effect is that two scanners (or one scanner with different configuration) can report different CVSS scores for the same CVE and both be "correct" given their source-priority rules.

## Resolution

Three things to check before concluding the scanner is wrong.

### Identify which data source a specific finding comes from

Most scanners expose per-finding provenance. In the finding's details pane or the raw JSON payload, look for fields named `data_source`, `score_source`, `advisory_id`, or similar. Typical values:

- `nvd`, `nist`, or a URL under `nvd.nist.gov` — NVD score.
- `osv`, `osv.dev`, or a URL under `osv.dev` — OSV score.
- A vendor-specific ID (e.g. `GHSA-…`, `RUSTSEC-…`, a distribution-specific advisory ID) — language-ecosystem advisory.
- A vendor VEX document reference — VEX score from that vendor.

Knowing the source for a finding disambiguates why the score differs from a different scanner's result.

### Decide which source is appropriate for the image at hand

The fundamental question is: *is the data source authoritative for this image?*

- If the image is based on a distribution that publishes VEX data and the scanner's VEX source is enabled, the VEX score is the most accurate reflection of actual exposure. The NVD score may be higher because NVD cannot know about the distribution's back-patches.
- If the image is base-less (Alpine-stripped, distroless, built from scratch) or a language-only image, VEX data rarely applies. OSV / ecosystem advisories are the authoritative source because they track the upstream package directly.
- If the CVE sits in a language package shipped inside a distribution image (for example a Java JAR vendored into an RPM-installed application), the scanner often reports both: a VEX score for the OS-level package and an OSV score for the embedded JAR. The two can differ by several CVSS points; both are relevant because they describe different aspects of the same image's exposure.

### Configure the scanner's source priority explicitly

Most scanners expose knobs to restrict or reorder their data sources. Common patterns:

- **VEX-only mode for recognised distribution images**. A flag that forces the scanner to ignore OSV / NVD for layers that carry distribution metadata and fall back to VEX only. Example environment variable shape (name varies by scanner — consult the specific scanner's documentation):

  ```bash
  # Pseudo-example; real variable name depends on the scanner installed.
  ROX_SCANNER_V4_RED_HAT_LAYERS_RED_HAT_VULNS_ONLY=true
  ```

  Enabling this quiets the "why does VEX say X but OSV say Y" question but risks suppressing a legitimate CVE when a package is not covered by VEX at all — the scanner may report **no** finding for a package that would have been flagged by OSV.

- **Source whitelist / blacklist**. A list of allowed sources per scanner policy. Useful when a particular source is known to be noisy for the environment or is delayed in publishing relative to others.

- **Per-image scan profile**. Some scanners let an image be tagged to use a particular source priority — appropriate when the cluster runs a heterogeneous set of images (distribution + language + custom) and one-size-fits-all source priority is too coarse.

Choose the configuration based on what the cluster actually ships:

- Mostly distribution-based images with VEX data available → lean toward VEX as the primary source, but **keep OSV enabled** for language packages embedded inside those images (middleware JARs, Python wheels in a Python-based image, etc.).
- Mostly language / distroless images → OSV-first, NVD as fallback. VEX rarely applies.
- Mixed fleet → per-image scan profiles are worth the configuration cost.

After changing source priority, re-scan a known-vulnerable image and confirm the output matches expectation. Compare against an independent reference (NVD's web UI for the CVE ID) to sanity-check that findings are neither over-suppressed nor over-reported.

## Diagnostic Steps

Pick a concrete (image, CVE) pair that has been questioned. Extract the finding's raw data:

```bash
# Example query path — adapt to the scanner's own API.
kubectl get vulnerabilityreport -n <ns> <image-report-name> -o json | \
  jq '.report.vulnerabilities[] | select(.id == "CVE-YYYY-NNNNN")'
```

The output lists the finding's source, score, and whatever enrichment the scanner attached (VEX statement, advisory URL, fix version). Cross-reference with:

- The CVE's NVD page (`https://nvd.nist.gov/vuln/detail/CVE-YYYY-NNNNN`) — authoritative NVD score and references.
- An OSV query (`curl https://api.osv.dev/v1/vulns/CVE-YYYY-NNNNN`) — OSV score and affected-package list.
- The vendor's VEX feed (if the image is distribution-based).

Three common conclusions:

1. **NVD and OSV agree; the scanner reports a third score.** Check whether the image ships a patched version of the package — vendor VEX data may have downgraded the CVE for this specific build.
2. **NVD is high; the scanner reports low.** The image's distribution has issued a VEX statement saying the package is not affected by the CVE (for example, the relevant code path is not compiled in, or a mitigation is applied). The scanner is correct to suppress; verify by reading the VEX document.
3. **NVD is low; the scanner reports high.** The scanner is enriching with OSV or an ecosystem advisory that scored the CVE more severely than NIST did. Upstream maintainers often have earlier visibility into real-world exploitability and score accordingly.

For scanner-level drift (same image, different score on consecutive scans), check the scanner's update cadence. CVE data sources update independently, and a CVE that was only in NVD last week may have picked up an OSV or VEX entry since — the scanner's score changes as new sources become available, not because the image changed.

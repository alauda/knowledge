---
kind:
   - KnownIssue
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Alertmanager 0.27+ UTF-8 matchers parser warning for custom routing rules

## Issue

On Alauda Container Platform the Prometheus monitoring stack ships an Alertmanager binary built from upstream `v0.32.1`, packaged as `registry.alauda.cn:60080/3rdparty/prometheus/alertmanager:v0.32.1-v4.3.4` and run by the `cpaas-system/kube-prometheus` Alertmanager CR. Because this version is well above `0.27`, the binary uses the new UTF-8-capable matchers parser introduced upstream in `0.27`, which has a number of backwards-incompatible changes relative to the classic matchers parser used by earlier versions.

The visible symptom is a warning emitted on Alertmanager configuration load, even when no configuration change has been made on the cluster — the behavior is keyed to the parser version, not to a configuration edit. On the `v0.32.1` build the line is emitted by the alertmanager container in its standard `slog` format with the `source=parse.go:176` field:

```text
time=2026-05-29T12:59:11.225Z level=WARN source=parse.go:176 msg="Alertmanager is moving to a new parser for labels and matchers, and this input is incompatible. Alertmanager has instead parsed the input using the classic matchers parser as a fallback. To make this input compatible with the UTF-8 matchers parser please make sure all regular expressions and values are double-quoted and backslashes are escaped. If you are still seeing this message please open an issue." input="alertname = Optimize- Route existiert nicht" origin=config err="22:27: unexpected Route: expected a comma or close brace" suggestion="alertname=\"Optimize- Route existiert nicht\""
```

Each warning line carries the offending matcher in the `input=` field, a parse-error position in the `err=` field (column and a short reason such as `unexpected Route: expected a comma or close brace`), and a corrected matcher in the `suggestion=` field with the value already double-quoted.

## Root Cause

When the UTF-8 matchers parser receives a matcher string it cannot parse, it does not fail the configuration. Instead it re-parses the string with the classic matchers parser and accepts the result, then logs the `parse.go:176` warning so the operator can fix the input before the next behavior change. The fallback path is announced by an adjacent debug line on the same load: `source=parse.go:154 msg="Parsing with UTF-8 matchers parser, with fallback to classic matchers parser" input=... origin=config`. The warning itself is the operator-visible signal that the fallback ran.

The warning is scoped to matcher strings that pass through the alertmanager matcher syntax parser. Concretely that is every entry in a `matchers:` list under a route or inhibit rule, plus matchers handed to `amtool`. The deprecated `match:` key/value map form goes through YAML and never reaches the matchers parser, so map-form matchers do not trigger the warning regardless of the value content.

The shipped ACP route tree in `Secret cpaas-system/alertmanager-kube-prometheus` is entirely the `match:` map form (for example `match: {severity: Critical}` and `match: {alert_repeat_interval: 5m}`), and every value is a single alphanumeric token with no spaces or special characters. On the platform cluster the live alertmanager container log therefore contains zero `parse.go` warnings even though the binary contains the strict UTF-8 parser. The warning appears only when an operator (or an integration controller) adds custom matchers in the `matchers:` list form with values that contain whitespace, hyphens that the parser would interpret as token boundaries, or non-ASCII characters — for example `alertname = Optimize- Route existiert nicht`.

## Resolution

Custom routing rules added on top of the shipped configuration must be updated manually to use the double-quoted form for any non-trivial value. The shipped ACP rules already comply and need no changes.

For each non-compliant `matchers:` list entry, wrap the value in double quotes (and escape any embedded backslashes). Using the example from the warning text, the original entry:

```yaml
route:
  routes:
  - matchers:
    - alertname = Optimize- Route existiert nicht
    receiver: default
```

is rewritten to the parser-compliant form:

```yaml
route:
  routes:
  - matchers:
    - alertname="Optimize- Route existiert nicht"
    receiver: default
```

After this change the same `v0.32.1` Alertmanager loads the configuration with no `parse.go` warning and no fallback at all — the configuration parses cleanly on the first pass through the UTF-8 parser.

Two extra notes on scope:

- A matcher whose value is a single alphanumeric token (for example `severity=Critical` or `alert_repeat_interval=5m`) parses cleanly under the UTF-8 parser without quoting; quoting is only required when the value contains whitespace, special characters, or non-ASCII text.
- A matcher written in the deprecated `match:` map form does not trigger the warning, because YAML already carries the value as a string. Pre-existing map-form entries continue to work as-is and do not need to be migrated to clear the warning.

Applying the double-quoted fix now produces no behavior change for compliant inputs and clears the warning for the non-compliant ones; the same `v0.32.1` binary then loads the route tree without any `parse.go` line or warning at all.

## Diagnostic Steps

Read the live alertmanager container log and filter for the `parse.go` warning to enumerate which matchers are tripping the fallback:

```bash
kubectl -n cpaas-system logs alertmanager-kube-prometheus-0 -c alertmanager --tail=2000 \
  | grep 'source=parse.go'
```

If the grep returns no lines, every matcher currently loaded by Alertmanager is UTF-8-parser-compliant and no action is needed. If lines are returned, each line's `input=` field identifies the exact offending matcher and the `suggestion=` field gives the corrected double-quoted form to copy back into the configuration.

To validate a planned configuration before rolling it out, run `amtool` from inside the Alertmanager container — it ships in the same image at the same version (`amtool, version 0.32.1`) and reproduces the parser warning during `check-config`, so a misshapen matcher can be caught without rotating the pod:

```bash
kubectl -n cpaas-system exec alertmanager-kube-prometheus-0 -c alertmanager -- \
  /bin/amtool check-config /etc/alertmanager/config_out/alertmanager.env.yaml
```

A `SUCCESS` line with no preceding `parse.go:176 WARN` indicates the configuration is fully compliant with the UTF-8 matchers parser; a `SUCCESS` line preceded by one or more `parse.go:176 WARN` lines means the configuration is currently accepted only because of the classic-parser fallback and must be updated before the next Alertmanager upgrade.

---
kind:
   - KnownIssue
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500867
---

# Custom matchers with whitespace trigger Alertmanager UTF-8 parser fallback warning

## Issue

On Alauda Container Platform the Prometheus monitoring stack ships an Alertmanager binary built from upstream `v0.32.1`, packaged as `registry.alauda.cn:60080/3rdparty/prometheus/alertmanager:v0.32.1-v4.3.4` and run by the `cpaas-system/kube-prometheus` Alertmanager CR. Because this version is well above `0.27`, the binary uses the new UTF-8-capable matchers parser introduced upstream in `0.27`, which is strict about how matcher values are quoted.

When the configured route tree contains a `matchers:` list entry whose value carries whitespace (or other special characters) but is not double-quoted — for example `region=production EU` — the parser cannot consume the value as a single token, falls back to the classic matchers parser, and emits a `parse.go:176` WARN line that identifies the offending input. On the `v0.32.1` build the line is emitted by the alertmanager container in its standard `slog` format with the `source=parse.go:176` field:

```text
time=2026-05-29T14:56:00.665Z level=WARN source=parse.go:176 msg="Alertmanager is moving to a new parser for labels and matchers, and this input is incompatible. Alertmanager has instead parsed the input using the classic matchers parser as a fallback. To make this input compatible with the UTF-8 matchers parser please make sure all regular expressions and values are double-quoted and backslashes are escaped. If you are still seeing this message please open an issue." input="region=production EU" origin=config err="18:20: unexpected EU: expected a comma or close brace" suggestion="region=\"production EU\""
```

Each warning line carries four identifying fields: `input=` (the exact offending matcher string), `origin=config`, `err=` (a column position and a short reason such as `unexpected EU: expected a comma or close brace`), and `suggestion=` (the corrected matcher with the value already double-quoted).

The `parse.go:176` line is a WARN, not a fatal error: Alertmanager keeps running on the offending config because the parser falls back to the classic matchers parser rather than rejecting the load. In a lab reproduction the probe pod with the matcher above loaded the configuration and reached `Phase=Running` with `restartCount=0`, and the dispatcher and gossip cluster started normally — the upstream signal on `v0.27`-`v0.32+` for this class of input is a parser warning plus a classic-parser fallback, not a process crash.

## Root Cause

When the UTF-8 matchers parser receives a matcher string it cannot parse, it does not fail the configuration. Instead it re-parses the string with the classic matchers parser and accepts the result, then logs the `parse.go:176` warning so the operator can fix the input before the next behavior change. The fallback path is announced by an adjacent DEBUG line on the same load — `source=parse.go:154 msg="Parsing with UTF-8 matchers parser, with fallback to classic matchers parser" input=... origin=config` (visible at `--log.level=debug`) — and the WARN at `parse.go:176` is the operator-visible signal that the fallback actually ran.

The warning is keyed to the alertmanager binary version, not to any configuration edit: the `v0.32.1` binary checks every matcher string against the UTF-8 parser on every config load, so a misshapen `matchers:` entry warns on the first load and on every reload thereafter until the value is rewritten.

For the article's literal input `region=production EU` the parser stops at column 20 because the bare word `EU` after the whitespace cannot be a value or a comma-separated continuation; the `err=` field reports `18:20: unexpected EU: expected a comma or close brace` and the `suggestion=` field shows the syntactically correct form `region="production EU"`.

## Resolution

For each non-compliant `matchers:` list entry, wrap the value in double quotes (and escape any embedded backslashes). Using the example from the warning text, the original entry:

```yaml
route:
  routes:
  - matchers:
    - region=production EU
    receiver: default
```

is rewritten to the parser-compliant form:

```yaml
route:
  routes:
  - matchers:
    - region="production EU"
    receiver: default
```

After this change the same `v0.32.1` Alertmanager loads the configuration with no `parse.go:176` WARN line and without invoking the classic-parser fallback at all — the `parse.go:154` DEBUG line still announces that the two-pass parser engaged, but the value now parses cleanly on the first pass through the UTF-8 parser and no fallback runs.

Applying the double-quoted fix produces no behavior change for already-compliant inputs and clears the warning for the non-compliant ones; the same `v0.32.1` binary then loads the route tree cleanly.

## Diagnostic Steps

Read the live alertmanager container log and filter for the `parse.go:176` warning to enumerate which matchers are tripping the fallback:

```bash
kubectl -n cpaas-system logs alertmanager-kube-prometheus-0 -c alertmanager --tail=2000 \
  | grep 'source=parse.go:176'
```

If the grep returns no lines, every matcher currently loaded by Alertmanager is UTF-8-parser-compliant and no action is needed. If lines are returned, each line's `input=` field identifies the exact offending matcher and the `suggestion=` field gives the corrected double-quoted form to copy back into the configuration.

To validate a planned configuration before rolling it out, run `amtool` from inside the Alertmanager container — it ships in the same image at the same version (`amtool, version 0.32.1`) and reproduces the parser warning during `check-config`, so a misshapen matcher can be caught without rotating the pod:

```bash
kubectl -n cpaas-system exec alertmanager-kube-prometheus-0 -c alertmanager -- \
  /bin/amtool check-config /etc/alertmanager/config_out/alertmanager.env.yaml
```

A `SUCCESS` line with no preceding `parse.go:176 WARN` indicates the configuration is fully compliant with the UTF-8 matchers parser; a `SUCCESS` line preceded by one or more `parse.go:176 WARN` lines means the configuration is currently accepted only because of the classic-parser fallback and must be updated before the next Alertmanager upgrade.

## See Also

- `Alertmanager 0.27+ UTF-8 matchers parser warning for custom routing rules` — same root cause, broader walk-through of UTF-8-parser back-compat changes.

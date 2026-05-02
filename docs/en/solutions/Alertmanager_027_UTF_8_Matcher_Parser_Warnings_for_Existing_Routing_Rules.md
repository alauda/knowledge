---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Alertmanager 0.27+ UTF-8 Matcher Parser Warnings for Existing Routing Rules
## Issue

After the platform's monitoring stack rolls Alertmanager to version `0.27` or later, the `alertmanager` container starts logging warnings for routing or inhibit rules that previously worked without complaint:

```text
ts=2026-01-08T13:03:19.023Z caller=parse.go:176 level=warn
msg="Alertmanager is moving to a new parser for labels and matchers, and this
 input is incompatible. Alertmanager has instead parsed the input using the
 classic matchers parser as a fallback. To make this input compatible with
 the UTF-8 matchers parser please make sure all regular expressions and
 values are double-quoted. If you are still seeing this message please
 open an issue."
input="alertname = Optimize- Route existiert nicht"
origin=config
err="21:22: unexpected-: expected a comma or close brace"
suggestion="alertname=\"Optimize- Route existiert nicht\""
```

Alerts still fire and routes still match — for now — because Alertmanager falls back to the classic parser. The warning is the warning shot: once the classic parser is removed (two releases out per upstream), the same configuration will be a hard parse error and the Alertmanager pod will refuse to start.

Nothing changed in the user's `AlertmanagerConfig` or `Alertmanager` CR, so the signal looks spontaneous and the root cause is not obvious from Alauda Container Platform release notes alone.

## Root Cause

Upstream Alertmanager `0.27` introduced a new matcher grammar that accepts UTF-8 in label values and is stricter about quoting. From the upstream notes:

> *"Alertmanager versions 0.27 and later have a new parser for matchers that has a number of backwards incompatible changes. Alertmanager will make UTF-8 strict mode the default in the next two versions, so it's important to transition as soon as possible."*

The new parser rejects three patterns that the classic parser tolerated:

1. **Unquoted values with special characters.** Spaces, dashes mid-token (`Optimize- Route`), non-ASCII letters (`existiert`, umlauts) — the new parser requires double quotes around the full value.
2. **Unquoted regex alternations** — values that look like `foo|bar` without quotes.
3. **Leading / trailing whitespace inside the value** — classic parser trimmed silently, new parser rejects.

In every case the `suggestion=` field of the warning log line shows the exact fixed form: wrap the right-hand side of the matcher in `"..."`.

The platform-managed monitoring rules shipped by Alauda Container Platform already use the quoted form. Warnings surface only for **custom** `AlertmanagerConfig` objects or `Alertmanager` spec entries authored by the cluster operator or by tenant teams. The fix is therefore owned by whoever wrote the custom config — the monitoring stack itself does not need any change.

Alauda Container Platform's monitoring surface (`observability/monitor`) uses the same upstream Prometheus Operator + Alertmanager project, so this behaviour is inherited directly from upstream and the fix is identical regardless of whether the object sits in-core or under the extended monitoring stack.

## Resolution

Walk all custom Alertmanager configuration objects and double-quote every matcher value. Start from the warning log — each `suggestion=` field is the corrected form to paste back in.

### Fix `AlertmanagerConfig` matchers

`AlertmanagerConfig` objects expose matchers as a structured list; the value is the `value` field. Update any entry where the value contains spaces, punctuation, non-ASCII characters, or looks like a regex:

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: team-a
  namespace: team-a
spec:
  route:
    groupBy: ["alertname"]
    receiver: team-a
    matchers:
      - name: alertname
        value: "Optimize- Route existiert nicht"   # was: Optimize- Route existiert nicht
        matchType: "="
      - name: severity
        value: "warning|critical"                   # was: warning|critical
        matchType: "=~"
```

The `value` in YAML is already a string, but Alertmanager parses the rendered string at config-load time — so the **literal** double quotes must be part of the stored value when the config is expressed in Alertmanager's native grammar (e.g. the flat `matchers:` array on the inhibit-rule or mute-time side). When in doubt, use the structured `name / value / matchType` triple rather than the flat string form — the operator renders it into the canonical quoted shape for you.

### Fix flat-string matchers in the `Alertmanager` CR

If the root `Alertmanager` CR uses inhibit rules or mute-time intervals with the flat string form, the quotes must be written explicitly:

```yaml
inhibitRules:
  - sourceMatchers:
      - 'alertname="Watchdog"'
    targetMatchers:
      - 'severity="critical"'
    equal: ["namespace"]
```

Single quotes around the YAML scalar, double quotes around the matcher value — this survives the two parsers and is forward-compatible with UTF-8 strict mode.

### Fix custom `PrometheusRule` templates that render matchers

A less common but trickier case is `PrometheusRule` entries whose `annotations` or routing hints embed a matcher-formatted string. Those strings are handed to Alertmanager verbatim and follow the same quoting rule.

### Roll out and verify

After the edits, the Prometheus Operator picks up the change on its next reconcile (usually within 30 seconds). No pod restart is required for `AlertmanagerConfig` updates. Confirm the warnings stop by tailing the `alertmanager` container log:

```bash
kubectl -n <monitoring-namespace> logs -l app.kubernetes.io/name=alertmanager -c alertmanager --tail=200 | grep -i "UTF-8 matchers parser"
```

An empty result after the reconcile means every matcher now parses cleanly under the new grammar. It is worth running this check once per custom namespace after the upgrade, and once more ahead of the next Alertmanager minor bump.

### Why there was no prior warning

The classic parser accepted the loose syntax silently, so neither `kubectl apply` nor the operator's validation webhook rejected the object at write time. Only after `0.27` ships does Alertmanager emit the deprecation warning at parse time. Treat the absence of warnings today as a regression signal, not as proof of correctness.

## Diagnostic Steps

1. Enumerate Alertmanager pods and pull recent parser warnings:

   ```bash
   kubectl -n <monitoring-namespace> logs -l app.kubernetes.io/name=alertmanager \
     -c alertmanager --tail=500 | grep -E "UTF-8 matchers parser|classic matchers parser"
   ```

2. Extract the `input=` and `suggestion=` fields — these tell you exactly which matcher string is at fault and what the fixed form is:

   ```bash
   kubectl -n <monitoring-namespace> logs -l app.kubernetes.io/name=alertmanager \
     -c alertmanager --tail=500 \
     | grep -oE 'input="[^"]+" origin=[a-z]+ .*suggestion="[^"]+"'
   ```

3. Find the source configuration for each flagged matcher. The `origin=` field on the warning tells you whether it came from `config` (the Alertmanager CR) or from one of the `AlertmanagerConfig` objects:

   ```bash
   kubectl get alertmanagerconfig -A
   kubectl get alertmanager -A -o yaml | grep -A1 -E 'matchers|sourceMatchers|targetMatchers'
   ```

4. After correcting and re-applying, tail the log again and verify the warning count drops to zero. Track the fix per namespace to avoid missing a custom config under a rarely-touched tenant:

   ```bash
   for ns in $(kubectl get ns -o name | sed 's|namespace/||'); do
     count=$(kubectl -n <monitoring-namespace> logs -l app.kubernetes.io/name=alertmanager \
               -c alertmanager --tail=500 2>/dev/null \
             | grep "UTF-8 matchers parser" | grep -c "$ns" || true)
     [ "$count" -gt 0 ] && echo "$ns: $count warnings"
   done
   ```

5. For regression prevention, add a pre-merge check on `AlertmanagerConfig` authors: any matcher `value` that contains whitespace, `|`, `-`, or non-ASCII must be wrapped. The `promtool check config` binary (shipped with Prometheus) accepts the same grammar and can be run in CI against rendered config.

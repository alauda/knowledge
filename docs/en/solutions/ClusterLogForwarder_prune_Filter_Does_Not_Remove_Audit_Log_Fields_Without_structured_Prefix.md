---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The platform's logging-collector pipeline (Vector-based, driven by a `ClusterLogForwarder` custom resource) is configured with a `prune` filter that lists several Kubernetes API audit fields to remove before forwarding. After applying the configuration, the audit-log stream shipped to the destination still contains the fields the prune was supposed to drop:

- `.requestReceivedTimestamp`
- `.apiVersion`
- `.requestURI`
- `.userAgent`
- `.user.uid`
- `.stage`
- `.stageTimestamp`

Curiously, **`.hostname`** *is* removed as expected. Every other field declared under `prune.in` is ignored.

The configured filter and pipeline:

```yaml
filters:
  - name: remove-unwanted-fields
    type: prune
    prune:
      in:
        - .requestReceivedTimestamp
        - .apiVersion
        - .requestURI
        - .userAgent
        - .stage
        - .stageTimestamp
pipelines:
  - name: audit-logs
    inputRefs:
      - audit
    filterRefs:
      - remove-unwanted-fields
    outputRefs:
      - <destination>
```

When the same prune filter is applied to `application` or `infrastructure` inputs, the same field paths work correctly. Only audit input is affected.

## Root Cause

In the current logging-collector release, the `audit` input does not deliver records with the API-server fields at the **top level** of the event document. Vector wraps the parsed audit event under a `.structured` sub-object, so what the user thinks is `.apiVersion` is in fact `.structured.apiVersion` once Vector has the record in hand. The prune filter is a literal field-path matcher; declaring `.apiVersion` simply does not match anything in the actual record.

The reason `.hostname` does drop is that `.hostname` is not part of the audit JSON itself — it is added by the collector at the top level outside the `.structured` envelope. Top-level paths match literally, sub-event paths do not, hence the asymmetric behavior the user observes.

The collector's documented behavior is for the prune filter to operate on the path the user wrote. The mismatch between the documented behavior and the actual `.structured` wrapping is a defect, tracked in the logging operator's bug tracker. The fix flips the prune filter to resolve user-supplied paths against the wrapped event so that `.requestURI` reaches into `.structured.requestURI` automatically. After the fix lands, the original (unprefixed) configuration starts working, and the workaround config below should be reverted to avoid double-prefixing.

## Resolution

### Preferred: upgrade the platform logging operator

Upgrade the platform logging-service operator to the point release that ships the prune-filter fix. After the upgrade, the original configuration that lists field paths *without* the `.structured` prefix begins working as expected. No CR change is required at upgrade time.

If the workaround below was applied prior to the upgrade, **un-prefix** the field list as part of the upgrade — leaving `.structured` prefixes in a fixed collector causes the filter to look for `.structured.structured.<field>` and the symptom returns.

### Workaround: prefix audit field paths with .structured

While still on a pre-fix collector release, edit the `ClusterLogForwarder` CR and prefix each audit-only field path with `.structured`:

```yaml
filters:
  - name: remove-unwanted-fields
    type: prune
    prune:
      in:
        - .structured.requestReceivedTimestamp
        - .structured.apiVersion
        - .structured.requestURI
        - .structured.userAgent
        - .structured.stage
        - .structured.stageTimestamp
pipelines:
  - name: audit-logs
    inputRefs:
      - audit
    filterRefs:
      - remove-unwanted-fields
    outputRefs:
      - <destination>
```

Apply the change and let the collector reload (the operator rolls the collector pods). Audit records arriving at the destination after the reload will have the listed fields removed.

Two operational notes:

- **Do not apply the `.structured` prefix to non-audit pipelines.** Application and infrastructure inputs are not wrapped, so prefixing those paths breaks pruning the same way the absence of the prefix breaks audit pruning.
- **Track the upgrade in your runbook.** This workaround must be undone after upgrading to the fixed collector release; see the warning above.

### OSS fallback

On a vanilla OSS Vector deployment shipping audit logs (no logging-operator wrapper), the parsed JSON envelope is whatever the Vector source step puts on the wire — usually the audit JSON at the top level. In that case the original `.<field>` paths work and the `.structured` prefix is *not* required. The defect is specific to the `.structured` wrapping the platform logging-collector applies; it does not exist in a hand-rolled Vector pipeline that does not introduce that envelope.

## Diagnostic Steps

Confirm the pruning is failing because of path-shape and not because the filter is unattached.

1. Read the active `ClusterLogForwarder` resource and confirm the prune filter is in the audit pipeline:

   ```bash
   CR=collector
   NS=<logging-namespace>
   kubectl -n $NS get clusterlogforwarder $CR -o yaml \
     | yq '.spec.filters, .spec.pipelines'
   ```

   The `audit-logs` pipeline must list the prune filter under `filterRefs`. If it does not, the filter is silently inactive and the symptom is unrelated to path shape.

2. Inspect a single audit record at the destination to see the actual envelope shape. Most destinations let you tail the most recent events; the JSON should show whether the audit fields appear at the top level or under `.structured`. If a destination tail is unavailable, exec into the collector pod and read its stdout:

   ```bash
   kubectl -n $NS get pods -l app.kubernetes.io/component=collector
   kubectl -n $NS exec <collector-pod> -- \
     sh -c 'tail -n 50 /var/log/collector.log' | grep -E '"audit"' | head -2 | jq .
   ```

   If the audit fields are nested under `.structured`, the `.structured`-prefixed workaround is required.

3. After applying the workaround, confirm the rendered Vector configuration in the collector pod's config volume reflects the prefixed paths:

   ```bash
   kubectl -n $NS exec <collector-pod> -- \
     cat /etc/vector/vector.toml | grep -A2 prune
   ```

4. Send a single API request that will produce an audit event (any `kubectl get` against an audited resource) and observe the fields at the destination. The pruned fields should be absent; the others (the ones the prune did not name, plus the always-required identifying fields) should still be present.

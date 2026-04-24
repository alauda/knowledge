---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Every Vector-based collector pod in the logging namespace is in `CrashLoopBackOff` immediately after a `ClusterLogForwarder` is updated to forward logs to an Elasticsearch sink with **token** authentication. Pod logs show that Vector refuses to start because the rendered configuration carries an unsupported auth strategy:

```text
Creating the directory used for persisting Vector state /var/lib/vector/<ns>/collector
Starting Vector process...
ERROR vector::cli: Configuration error.
  error=unknown variant `bearer`, expected `basic` or `aws`
        in `sinks.output_elasticsearch`
```

The same configuration with `basic` auth (username/password) starts cleanly; switching the sink to `token` fails on every node simultaneously.

## Root Cause

The `ClusterLogForwarder` (CLF) used by the platform's logging stack — based on the open-source Vector collector and the **Logging Service** extension product (`observability/log`) — accepts a `token` authentication block on Elasticsearch outputs:

```yaml
authentication:
  token:
    from: secret
    secret:
      name: elasticsearchsecret
      key: token
```

The CLF operator translates the CRD into a Vector TOML/YAML configuration. In affected versions, the rendering code path for Elasticsearch sinks emits `auth.strategy = "bearer"` whenever the user sets `authentication.token`. The Vector `elasticsearch` sink, however, only recognises `basic` and `aws` for `auth.strategy` in those Vector releases — `bearer` is not a valid variant. Vector exits at config-load time, the collector pod restarts, and the controller tries the same config again.

The bug is in the operator's renderer, not in the user's CLF. As a result, the entire collector DaemonSet flips into CrashLoopBackOff the moment a token-auth Elasticsearch output is added — it is not a partial failure scoped to one node.

A fix for this rendering bug shipped in a later Logging Service patch release; once that release is rolled out, the renderer emits the correct field shape (custom HTTP header carrying the bearer token, rather than the unknown `auth.strategy` variant) and the collector starts cleanly.

## Resolution

Pick the lowest-impact path that restores log forwarding:

### 1. Upgrade the Logging Service to a fixed release

Roll the Logging Service (or whichever component shipped the affected CLF operator) to the version where the renderer fix landed. After the new operator pod replaces the old one, the rendered Vector configuration for the same `ClusterLogForwarder` is regenerated; the collector DaemonSet re-rolls and the pods reach `Ready` within a minute.

```bash
# Confirm the upgrade is in progress and the new collector image is rolling.
LOG_NS=<logging-namespace>
kubectl -n "$LOG_NS" get pods -l app.kubernetes.io/component=collector \
  -o custom-columns=NAME:.metadata.name,STATUS:.status.phase,IMAGE:.spec.containers[0].image
```

### 2. Workaround: switch the output to basic auth or to a token forwarded as a header

If the upgrade cannot happen immediately, two options keep logs flowing without the bug:

- **Use `basic` authentication.** The Elasticsearch endpoint usually supports both. Mint a service account in the cluster the receiving Elasticsearch trusts, store it as a Secret with `username` / `password`, and reference it from the CLF output. This avoids the bad rendering path entirely.
- **Forward the bearer token as a custom HTTP header.** If the receiving cluster only honours bearer tokens, omit the `authentication.token` block and instead inject the header through the CLF's per-output `headers` map (the field name varies with the CLF version; check `observability/log`). The renderer treats this as a generic header pass-through and does not emit `auth.strategy = "bearer"`.

  Sketch of the workaround output:

  ```yaml
  outputs:
    - name: elasticsearch
      type: elasticsearch
      elasticsearch:
        url: https://elasticsearch.example:9200
        version: 8
        index: my-index
        # No `authentication.token:` block here.
      tuning:
        # CLF/output-level header injection — exact field per
        # observability/log docs for the deployed version.
        headers:
          Authorization: "Bearer ${ELASTIC_TOKEN}"
      secretRefs:
        - name: elasticsearchsecret  # exposes ELASTIC_TOKEN as env var
  ```

After the workaround is in place, plan the operator upgrade for the next maintenance window so that the CLF can return to the supported `authentication.token` form.

### 3. Stop the crash storm while triaging

Even with the workaround prepared, removing the failing `authentication.token` block immediately stops the CrashLoopBackOff and lets the collector pods come back. Edit the CLF and either drop the broken output or substitute the basic-auth variant:

```bash
LOG_NS=<logging-namespace>
kubectl -n "$LOG_NS" edit clusterlogforwarder <name>
# Remove the offending output OR change `authentication.token:` to `authentication.basic:`.
```

The CLF operator regenerates the Vector configuration; the DaemonSet rolls and pods reach `Ready` within a minute.

## Diagnostic Steps

Confirm the failing config is exactly the token-auth Elasticsearch sink:

```bash
LOG_NS=<logging-namespace>
kubectl -n "$LOG_NS" get clusterlogforwarder -o yaml \
  | grep -A6 -E 'authentication:|type: elasticsearch'
```

Tail the renderer's emitted Vector config from a collector pod (the file path varies by version; the rendered config is typically a ConfigMap mounted at `/etc/vector/`):

```bash
POD=$(kubectl -n "$LOG_NS" get pod -l app.kubernetes.io/component=collector \
        -o name | head -n1)
kubectl -n "$LOG_NS" exec "$POD" -- \
  sh -c 'find /etc/vector -name "*.toml" -o -name "*.yaml" | xargs grep -nE "auth|strategy" || true'
```

A `strategy = "bearer"` line under an `[sinks.output_elasticsearch.auth]` block confirms the renderer bug; that is the value Vector rejects.

Verify a collector starts after switching to basic auth or removing the broken output:

```bash
kubectl -n "$LOG_NS" rollout status ds/collector --timeout=2m
kubectl -n "$LOG_NS" logs ds/collector --tail=50 \
  | grep -iE 'error|started|listening' | head
```

If pods still crash with the same message after the CLF was edited, inspect the operator's status — the renderer may not have re-run yet. Bouncing the CLF operator pod forces an immediate reconcile:

```bash
kubectl -n "$LOG_NS" delete pod -l app.kubernetes.io/name=cluster-logging-operator
```

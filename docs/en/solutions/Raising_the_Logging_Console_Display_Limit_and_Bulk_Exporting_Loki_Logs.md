---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The platform's Logging console returns a small number of log lines per query (typically 100 by default) and offers no built-in "export the entire result set" button. Operators investigating an incident over a multi-hour window need:

- a way to raise the per-query line limit so that paging through the UI is less tedious;
- a path to bulk-export logs as CSV / NDJSON for offline analysis when the UI is not the right tool.

## Root Cause

The Logging UI plugin in the platform console is a thin client over the Loki query API. Each query the UI issues includes a `limit` parameter that caps the number of returned entries; the plugin reads this value from a `logsLimit` field on its own custom resource and falls back to a conservative default when unset. Loki itself does not paginate for the UI — the entire result set up to the limit is computed before being returned, so blindly raising the limit puts back-pressure on Loki rather than the browser.

For bulk export, the UI is the wrong abstraction: the request volume and the size of the JSON payload make it more efficient to talk to Loki directly with a CLI tool (`logcli` or a curl loop), which streams results in pages and can write CSV / NDJSON with no UI involvement.

## Resolution

### Step 1: Raise `logsLimit` on the Logging UI Plugin

Find the `UIPlugin` resource that backs the Logging console:

```bash
kubectl -n <logging-namespace> get uiplugin
kubectl -n <logging-namespace> get uiplugin -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'
```

Edit the relevant resource and set `spec.logging.logsLimit`:

```yaml
apiVersion: observability.alauda.io/v1alpha1      # may vary by plugin version
kind: UIPlugin
metadata:
  name: logging
  namespace: <logging-namespace>
spec:
  type: Logging
  logging:
    logsLimit: 5000
    lokiStack:
      name: logging-loki
```

Apply the change either by editing in place or by re-applying the manifest:

```bash
kubectl -n <logging-namespace> edit uiplugin logging
# — or —
kubectl apply -f uiplugin-logging.yaml
```

The plugin reloads within a minute. The console UI now fetches up to 5000 entries per query; click **Load more** at the end of the result set to fetch additional pages.

Recommended progression when raising the value:

- start at 1000;
- raise to 2500 if users still hit the ceiling regularly;
- treat 5000 as a soft cap — values above that increase the time-to-first-byte enough that the UI feels unresponsive.

In multi-tenant clusters, leave the limit modest: a single tenant issuing several 5000-line queries per minute can pressure the shared LokiStack querier pool.

### Step 2: Bulk-Export From the Command Line

For audit, post-mortem, or compliance work that needs more than a few thousand lines, query Loki directly with `logcli`:

```bash
# Install logcli (one-time):
curl -L -o logcli "https://github.com/grafana/loki/releases/latest/download/logcli-linux-amd64.zip"
unzip logcli && chmod +x logcli && sudo mv logcli /usr/local/bin/

# Forward the Loki gateway service to localhost.
kubectl -n <logging-namespace> port-forward svc/logging-loki-gateway-http 3100:80 &

# Stream every entry over a 6-hour window to a file. --output=jsonl emits one
# JSON object per line — easy to convert to CSV downstream with jq.
logcli query --addr=http://localhost:3100 \
  --from="2026-04-23T00:00:00Z" --to="2026-04-23T06:00:00Z" \
  --output=jsonl --batch=5000 --limit=0 --parallel-duration=15m \
  '{namespace="my-app"} |= "error"' \
  > my-app-errors.jsonl
```

Convert to CSV when the consuming tool is a spreadsheet:

```bash
jq -r '[.timestamp, .labels.namespace, .labels.pod, .line] | @csv' \
  my-app-errors.jsonl > my-app-errors.csv
```

`--limit=0` removes the per-page cap; `--parallel-duration` splits the window into 15-minute chunks fetched in parallel, which keeps a busy LokiStack from being overloaded by a single huge query.

For ad-hoc one-shot exports without installing a CLI, the same query plain HTTP:

```bash
curl -sG "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={namespace="my-app"} |= "error"' \
  --data-urlencode 'start=2026-04-23T00:00:00Z' \
  --data-urlencode 'end=2026-04-23T06:00:00Z' \
  --data-urlencode 'limit=5000' \
  --data-urlencode 'direction=forward' \
  | jq '.data.result[].values[]' > raw-page-1.json
```

For windows that span more than a single page, use the last entry's timestamp as the next request's `start` and loop.

### Step 3: Sizing Considerations

When raising `logsLimit` or running bulk exports:

- LokiStack's read path (`querier`, `query-frontend`) is the bottleneck. Scale the read pool up before pushing the limit hard.
- LogQL `|= "..."` filters are pushed down to the ingester — they are cheap. Regex (`|~ "..."`) is more expensive; bias toward exact-match filters when possible.
- Per-stream sharding makes wider time windows less efficient; fetch in chunks rather than one-shot for windows over a few hours.

## Diagnostic Steps

Confirm the plugin is running and on a recent revision:

```bash
kubectl -n <logging-namespace> get uiplugin -o yaml | grep -A2 status
kubectl -n <logging-namespace> get pods -l app.kubernetes.io/name=logging-view-plugin
```

Confirm the LokiStack the plugin points at is healthy:

```bash
kubectl -n <logging-namespace> get lokistack
kubectl -n <logging-namespace> get pods -l app.kubernetes.io/name=lokistack
```

Verify the live `logsLimit` the UI is actually using by inspecting the plugin's served config:

```bash
kubectl -n <logging-namespace> get uiplugin logging -o jsonpath='{.spec.logging.logsLimit}'
```

If the value differs from what was applied, the plugin has not yet reloaded — restart its Deployment to force a re-read:

```bash
kubectl -n <logging-namespace> rollout restart deployment logging-view-plugin
```

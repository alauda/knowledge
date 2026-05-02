---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A LokiStack-backed log store is healthy through the platform UI, but a script that hits the LokiStack gateway directly with curl gets a `403 Forbidden`:

```text
curl -G -k -H "Authorization: Bearer $token" \
  "https://logging-loki-cpaas-logging.apps.lab.example.com/api/logs/v1/application/loki/api/v1/query_range" \
  --data-urlencode 'query={log_type="application",kubernetes_namespace_name="my-app"}'
< HTTP/1.1 403 Forbidden
```

The token is a valid ServiceAccount token, the URL hits the right gateway, the query path is correct — but the gateway rejects it. The issue is the bearer principal (the ServiceAccount) does not have the LokiStack-specific RBAC needed to read the requested log tier (`application` / `infrastructure` / `audit`), or does not carry the per-namespace read permission that LokiStack 5.8+ enforces for application logs.

## Resolution

Recent LokiStack releases added a fine-grained access layer on top of the gateway: the bearer principal must have **both** of:

1. The LokiStack tier ClusterRole (`cluster-logging-application-view`, `cluster-logging-audit-view`, `cluster-logging-infrastructure-view`) — gates the tier as a whole.
2. Standard Kubernetes `pods/log` and `namespaces` read permission for the namespace whose logs the query selects — gates the per-namespace access. This second check applies only to the `application` tier; `audit` and `infrastructure` skip it.

> **Note:** This recipe wires up direct gateway access via a static token and intentionally bypasses the multi-tenant identity flow that the platform's UI uses. Treat it as a debugging / scripting path, not as a production tenant-isolation mechanism.

### Step 1 — create a ServiceAccount

```bash
LOG_NS=cpaas-logging
SA=logs-reader
kubectl -n "$LOG_NS" create serviceaccount "$SA"
```

### Step 2 — grant the LokiStack tier access

The tier is encoded as a ClusterRole. Pick the one that matches the log tier the script will query:

```bash
kubectl create clusterrolebinding logs-reader-app \
  --clusterrole=cluster-logging-application-view \
  --serviceaccount="$LOG_NS:$SA"

# Or for audit / infrastructure:
# --clusterrole=cluster-logging-audit-view
# --clusterrole=cluster-logging-infrastructure-view
```

### Step 3 — grant the standard pod-log read permission

For the `application` tier, the gateway also checks that the principal can `get pods/log` in the namespace whose logs are being queried. Mint a small ClusterRole and bind it either cluster-wide (any namespace) or per-namespace (limit blast radius):

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: viewlogs
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get"]
```

Bind it. For a single application namespace:

```bash
kubectl -n my-app create rolebinding logs-viewer \
  --clusterrole=viewlogs \
  --serviceaccount="$LOG_NS:$SA"
```

For all application namespaces (the wide form):

```bash
kubectl create clusterrolebinding logs-viewer-all \
  --clusterrole=viewlogs \
  --serviceaccount="$LOG_NS:$SA"
```

### Step 4 — mint a token

```bash
TOKEN=$(kubectl -n "$LOG_NS" create token "$SA" --duration=1h)
```

`--duration` controls how long the token is valid. Tokens issued through the `TokenRequest` API are intentionally bound to the ServiceAccount and to a finite TTL — the historical `kubectl get secret` form (legacy long-lived tokens) is deprecated and should not be used.

### Step 5 — query the gateway

The path layout is `/api/logs/v1/<tier>/loki/api/v1/<endpoint>`. For application-tier `query_range`:

```bash
GATEWAY=https://logging-loki-cpaas-logging.apps.lab.example.com
NS=my-app
curl -G -k -H "Authorization: Bearer $TOKEN" \
  "$GATEWAY/api/logs/v1/application/loki/api/v1/query_range" \
  --data-urlencode "query={log_type=\"application\",kubernetes_namespace_name=\"$NS\"} | json" \
  --data-urlencode "start=$(date -d '2 hours ago' +%s)" \
  --data-urlencode "end=$(date +%s)"
```

A successful response is a JSON envelope with `status: success` and a `data.result[]` array of log streams. A 200 with an empty `result[]` means the RBAC is fine but the log selector matched no streams in the time window — adjust the LogQL.

For an instant query, swap the endpoint:

```bash
curl -G -k -H "Authorization: Bearer $TOKEN" \
  "$GATEWAY/api/logs/v1/application/loki/api/v1/query" \
  --data-urlencode 'query=count_over_time({log_type="application",kubernetes_namespace_name="my-app"}[5m])'
```

### Step 6 — clean up the token

The minted token is bound to the ServiceAccount and expires automatically. To revoke a token early (e.g. if it leaked), delete and re-create the ServiceAccount — that invalidates every previously-issued token.

```bash
kubectl -n "$LOG_NS" delete serviceaccount "$SA"
```

## Diagnostic Steps

To confirm a 403 is RBAC (not a corrupt token, not a gateway path typo):

```bash
kubectl auth can-i get pods/log --as="system:serviceaccount:$LOG_NS:$SA" -n my-app
kubectl auth can-i view  --subresource= --as="system:serviceaccount:$LOG_NS:$SA" \
  cluster-logging-application-view
```

The first call must return `yes` for any application-tier query; the second confirms the LokiStack tier ClusterRoleBinding landed.

If the gateway returns `401 Unauthorized` instead of `403`, the bearer token itself is stale or wrong:

```bash
kubectl -n "$LOG_NS" create token "$SA" --duration=1h | tee /tmp/loki-token | wc -c
```

A non-trivial output length confirms the token was minted; pass `cat /tmp/loki-token` directly to `curl` so shell expansion does not break it.

For 403s where every RBAC check looks correct, inspect the gateway's authentication log to see what the gateway actually saw:

```bash
kubectl -n "$LOG_NS" logs deploy/logging-loki-gateway --tail=200 \
  | grep -E "$SA|forbidden|tenant"
```

A `tenant ID mismatch` entry indicates the URL path's tier (`/api/logs/v1/<tier>/`) does not match the tier the principal was granted — the URL says `application` but the binding only allows `audit`, or vice versa.

If queries succeed but return surprisingly small result sets, confirm the per-namespace `pods/log` rule is in place:

```bash
kubectl -n my-app describe rolebinding logs-viewer
```

Without that role binding the gateway silently filters out streams from namespaces the principal cannot see, returning fewer entries instead of an explicit 403.

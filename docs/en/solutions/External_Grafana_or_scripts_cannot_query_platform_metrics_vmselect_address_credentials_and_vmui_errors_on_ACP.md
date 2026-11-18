---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.8.x
  - 3.10.x
  - 3.12.x
  - 3.14.x
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# External Grafana or scripts cannot query platform metrics: vmselect address, credentials, and vmui errors on ACP

## Issue

An external Grafana, a self-built monitoring platform such as Nightingale, a big-data platform, or a `curl` script must read the metrics that the platform monitoring stores, and one of these happens:

- Nobody can find the query address or the username and password. VMUI shows a query page but no connection string.
- `curl` to `vmselect` returns `200 OK` with the platform login page (`<title>Product Login</title>`, `<base href="/console-dex/">`) instead of JSON.
- `curl` with basic auth returns `HTTP/1.1 200 OK`, `Content-Length: 0`, a `Gap-Auth: <user>` header and an empty body, or an export from `/select/<tenant>/prometheus/api/v1/export` returns nothing.
- vmui fails every query with `Error executing query: Unexpected token 'u', "unsupporte"... is not valid JSON. Please check your serverURL settings and confirm server availability.` or `SyntaxError: Unexpected token 'r', "remoteAddr"... is not valid JSON`.
- vmui opened through a NAT-mapped address redirects the browser to the platform's internal address, which the user's network cannot reach.
- The HAMi web UI stays empty although its Pod and Prometheus are Running.
- Someone asks for a login-free or NodePort address for Prometheus.

On VictoriaMetrics clusters the query endpoint is `vmselect`, which accepts the Prometheus query API. On Prometheus clusters it is the Prometheus instance behind `/clusters/<cluster-name>/prometheus-0`. Both are protected by basic auth or the platform login.

Related articles: [Grafana returns HTTP 500 after a password change, is missing after an upgrade, or rules and alerts do not carry over on ACP](Grafana_returns_HTTP_500_after_a_password_change_is_missing_after_an_upgrade_or_rules_and_alerts_do_not_carry_over.md). Credentials for the platform API and the 4.2 node-exporter change are in [auth-controller2 webhook certificate missing or log burst, monitoring query credentials, and Connector tokens on ACP](auth-controller2_webhook_certificate_missing_or_log_burst_monitoring_query_credentials_and_Connector_tokens_on_ACP.md).

## Root Cause

### Cause 1: the query address and the basic-auth Secret are on the monitoring feature, not on the VMUI page

VMUI is a browser on top of `vmselect` and does not print a connection string. On the global cluster, the `feature` object named `monitoring` carries `spec.accessInfo.database`:

- `instanceType: victoriametrics` (or Prometheus)
- `address`: the external form `https://<platform-address>/clusters/<cluster-name>/vmselect`; this is what an external Grafana uses
- `service`: the in-cluster form, for example `http://vmselect:8481/select/10001/prometheus`
- `basicAuth.secretName: victoriametrics-basic-auth`

The credentials are in Secret `victoriametrics-basic-auth` in `cpaas-system`. Credentials copied from another system do not log in. A request without credentials is redirected to the platform login page, so it returns `200 OK` with HTML. The tenant segment in `/select/<tenant>/prometheus` must be the one the cluster writes to; a mistyped tenant (for example `10010` instead of `10001`) returns an empty result rather than an error.

The built-in Prometheus of a Prometheus cluster is reachable at `https://<platform-address>/clusters/<cluster-name>/prometheus-0`, with the credentials in Secret `kube-prometheus-prometheus-basic-auth` in `cpaas-system` (user `monitor@cpaas.io`).

### Cause 2: the vmui server URL ends in prometheus/

A vmui page that worked before now fails every query with `Unexpected token 'u', "unsupporte"... is not valid JSON`. The server URL in vmui settings ends in `prometheus/` (for example `/clusters/global/vmselect/prometheus/`), so queries go to a path that answers with a plain-text `unsupported path` body. The first visit to `/clusters/<cluster-name>/vmselect/vmui/?` can redirect to the Prometheus path and leave that suffix in the setting. The `"remoteAddr"... is not valid JSON` variant has the same cause.

### Cause 3: vmui through a NAT-mapped address redirects to an unreachable internal address

vmui login is SSO with the platform Dex as identity provider. The Dex callback address is fixed in the start-up arguments of the VictoriaMetrics auth proxy and is bound to the platform address given when the environment was created. On a platform deployed by IP, a browser that reaches the platform only through a NAT-mapped address follows the redirect to `https://<real-platform-address>/dex/auth?...client_id=alauda-auth&redirect_uri=...vmselect%2Foauth2%2Fcallback...` and fails to connect. The routes themselves are healthy: on global, ingress `cluster-proxy-<cluster>` sends `/clusters/<cluster>(.|$)(.*)` to service `cluster-proxy-<cluster>` port `11780`, and on the workload cluster ingress `vmselect` sends `/clusters/<cluster>/vmselect($|/)(.*)` to service `vmselect` port `8481`. Opening `/clusters/<cluster>/vmselect/select/10001/vmui/` directly returns `unsupported path requested: "/select/10001/prometheus/select/10001/vmui/"`; that path is not the vmui entry.

### Cause 4: the HAMi web UI has the wrong Prometheus URL or credentials

`hamiwebui` and the Prometheus Pod are Running, and the in-cluster Prometheus URL returns data. The address, or the username and password, entered in the HAMi UI installation do not match that endpoint, so the HAMi page stays empty.

### Cause 5: Prometheus has no login-free access

Prometheus authentication is enforced by the platform and cannot be bypassed; there is no NodePort or login-free address. The platform Elasticsearch, which may seem to "open directly", has no web UI: what answers is its API.

## Resolution

### Cause 1: the query address and the basic-auth Secret are on the monitoring feature, not on the VMUI page

1. On the global cluster, read the address and the Secret name:

   ```bash
   kubectl get feature monitoring -o yaml
   kubectl get feature monitoring -o jsonpath='{.spec.accessInfo.database.address}{"\n"}{.spec.accessInfo.database.service}{"\n"}'
   ```

2. List the keys of the Secret, then decode them. If the key list is empty, the Secret name does not match this version; do not invent a password.

   ```bash
   kubectl -n cpaas-system get secret victoriametrics-basic-auth -o go-template='{{range $k,$v := .data}}{{printf "%s\n" $k}}{{end}}'
   kubectl -n cpaas-system get secret victoriametrics-basic-auth -o jsonpath='{.data.username}' | base64 -d; echo
   kubectl -n cpaas-system get secret victoriametrics-basic-auth -o jsonpath='{.data.password}' | base64 -d; echo
   ```

3. Take the tenant from the cluster's own `vmagent` remote-write URL instead of typing it:

   ```bash
   kubectl -n cpaas-system get vmagent -o yaml | grep -n 'insert/'
   ```

4. From the network where Grafana or the script runs, test before saving a data source. Use `-G` with `--data-urlencode` instead of hand-encoding `match%5B%5D`:

   ```bash
   curl -k -s -u '<user>:<password>' -G "https://<platform-address>/clusters/<cluster-name>/vmselect/api/v1/query" --data-urlencode 'query=up'
   curl -k -s -u '<user>:<password>' -G "https://<platform-address>/clusters/<cluster-name>/vmselect/federate" --data-urlencode 'match[]=up'
   ```

   Inside the cluster, the `service` address works the same way, for example `http://vmselect:8481/select/<tenant>/prometheus/api/v1/query`. For raw export:

   ```bash
   curl -k -u '<user>:<password>' 'https://<vmselect-address>/select/<tenant>/prometheus/api/v1/export' \
     --data-urlencode 'match[]=node_cpu_seconds_total{mode="idle"}' \
     --data-urlencode 'start=<unix-seconds>' --data-urlencode 'end=<unix-seconds>'
   ```

5. In Grafana, create a **Prometheus** data source with the `address` URL, enable basic auth with the decoded user and password, and save. The platform monitoring dashboards cannot be exported as Grafana JSON; build the Grafana dashboards from the metric names.

6. For an external system that only needs business Pod CPU, memory and network I/O, query this API rather than the platform API, and exclude platform namespaces, for example:

   ```promql
   sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{namespace!~"cpaas-system|kube-system",container!="",container!="POD"}[5m]))
   ```

On a Prometheus cluster, use the Prometheus path and its Secret:

```bash
kubectl get secret -n cpaas-system kube-prometheus-prometheus-basic-auth -o jsonpath='{.data.password}' | base64 -d; echo
curl -k -u 'monitor@cpaas.io:<password>' -G 'https://<platform-address>/clusters/<cluster-name>/prometheus-0/api/v1/query_range' \
  --data-urlencode 'query=node_cpu_seconds_total' --data-urlencode 'start=<rfc3339>' \
  --data-urlencode 'end=<rfc3339>' --data-urlencode 'step=1m'
```

On Windows, call `curl.exe` explicitly. In Windows PowerShell `curl` is an alias of `Invoke-WebRequest`, which rejects curl options with `ParameterBindingException` / `AmbiguousParameter`; that error is about the command, not the API. If the API answers from a cluster node but not from the Windows client, the client network policy is blocking it.

### Cause 2: the vmui server URL ends in prometheus/

1. Open `https://<platform-address>/clusters/<cluster-name>/vmselect/vmui/?`. If the first visit redirects to the Prometheus path, change the path back.
2. Open **Settings** at the top right, remove the trailing `prometheus/` from the server URL, and click **Apply**.
3. Run the query again; it returns data.

### Cause 3: vmui through a NAT-mapped address redirects to an unreachable internal address

1. From the user's PC, confirm where the redirect goes:

   ```bash
   curl -k -L 'https://<mapped-address>/clusters/<cluster-name>/vmselect/vmui/?'
   ```

   A `Found` redirect to `https://<real-platform-address>/dex/auth?...` followed by `Failed to connect to <real-platform-address> port 443` is this cause. The same request from a global node returns the login page.

2. Open vmui from a network that reaches the real platform address (VPN, cloud desktop, or the global VIP). The documented entry is `https://<platform-address>/clusters/<cluster-name>/vmselect-ui/vmui/`, then SSO login, then the vmui settings; for a VictoriaMetrics plugin that is not agent-only, `/clusters/<cluster-name>/vmselect/vmui/` also works.

On a platform deployed by IP, vmui cannot work through a mapped address, and opening extra ports does not change that. A hosts-file entry that points a domain at the mapped address helps only on platforms deployed with a domain name, where the Dex callback is a resolvable domain. Only the global nodes need to reach the workload cluster on port `11780`.

### Cause 4: the HAMi web UI has the wrong Prometheus URL or credentials

Prove the in-cluster Prometheus URL with `curl` and the basic-auth pair from Cause 1, then enter exactly that URL and pair in the HAMi web UI installation parameters. No Prometheus restart is needed when the Pod is Running and `up` returns samples.

### Cause 5: Prometheus has no login-free access

There is no supported login-free or NodePort access to Prometheus. Use the platform address with the platform login, or the API with basic auth as in Cause 1.

## Diagnostic Steps

1. On the global cluster, print `feature/monitoring` and the Secret keys before asking anyone for a connection string (Cause 1):

   ```bash
   kubectl get feature monitoring -o jsonpath='{.spec.accessInfo.database}{"\n"}'
   ```

   Expected: an `address`, a `service`, and `basicAuth.secretName`.

2. Run the query with and without credentials:

   ```bash
   curl -k -s -o /dev/null -w '%{http_code} %{content_type}\n' -G "https://<platform-address>/clusters/<cluster-name>/vmselect/api/v1/query" --data-urlencode 'query=up'
   curl -k -s -u '<user>:<password>' -G "https://<platform-address>/clusters/<cluster-name>/vmselect/api/v1/query" --data-urlencode 'query=up' | head -c 200
   ```

   Without credentials: `200 text/html` (login page). With credentials: JSON with `"status":"success"`. An empty body or empty result with credentials means a wrong tenant or path.

3. vmui `is not valid JSON`: open vmui **Settings** and read the server URL; a trailing `prometheus/` is Cause 2.

4. vmui redirects to an internal address only from the user's network: Cause 3. Compare the same `curl -L` from a global node.

5. HAMi UI empty while its Pods are Running: test the URL and credentials it was installed with (Cause 4).

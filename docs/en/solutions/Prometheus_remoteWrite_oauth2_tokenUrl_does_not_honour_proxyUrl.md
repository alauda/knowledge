---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On a cluster that sits behind an HTTP(S) egress proxy, a Prometheus remote-write endpoint configured with OAuth2 client-credentials authentication fails to deliver samples. The remote-write target itself is reachable through the proxy, and `proxyUrl` is set on the remote-write block, but the OAuth2 `tokenUrl` fetch does not go through the proxy. As a consequence, Prometheus cannot acquire a bearer token, the authorization step fails, and samples are dropped at remote-write time.

Example of an affected remote-write configuration on the cluster monitoring stack:

```yaml
prometheus:
  remoteWrite:
    - url: https://ingest.example.com/metrics/api/v1/write?api-version=2023-04-24
      oauth2:
        clientId:
          secret:
            name: azure-monitor
            key: id
        clientSecret:
          name: azure-monitor
          key: secret
        tokenUrl: https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
        scopes:
          - "https://monitor.example.com/.default"
      proxyUrl: http://proxy.example.local:8080
```

The `url` target goes through `proxyUrl` correctly, but the HTTP client that fetches the OAuth2 `tokenUrl` is built from a separate HTTP client configuration and ignores the `proxyUrl` set on the outer remote-write block. In a fully proxied egress environment where the token endpoint is not reachable directly, token acquisition times out and the remote-write queue drains into the error path.

## Root Cause

Prometheus builds two independent HTTP clients for a remote-write entry: one for the actual samples POST to the `url`, and a second one for the OAuth2 `tokenUrl` exchange. The `proxyUrl` attribute on the remote-write block is applied only to the first client. The OAuth2 client is constructed from its own (nested) HTTP client configuration, which is not linked to the outer `proxyUrl`. In environments where both endpoints require the egress proxy, the token fetch therefore bypasses the proxy and fails.

This is a known upstream Prometheus limitation that is being corrected so the token-fetch client inherits the surrounding proxy configuration. Until a Prometheus release with that inheritance is picked up by the observability stack, the OAuth2 `tokenUrl` path cannot be driven through `proxyUrl`.

## Resolution

Where the target endpoint supports it, avoid the OAuth2 client-credentials flow in Prometheus and use a pre-issued bearer token supplied through a Kubernetes `Secret`. This removes the token-fetch step entirely, so there is no second HTTP client that needs its own proxy setting — the surviving single client for the remote-write POST uses `proxyUrl` as expected.

1. Provision the bearer token out-of-band (scripted refresh on a schedule, or a short-lived static token issued by the identity provider) and store it in a `Secret` in the monitoring namespace:

   ```bash
   kubectl -n <monitor-namespace> create secret generic remote-write-bearer \
     --from-literal=token='<bearer-token-value>'
   ```

2. Change the remote-write block to reference the token via `authorization` (or `bearerTokenSecret`, depending on the CRD version in use) instead of `oauth2`. Example shape:

   ```yaml
   prometheus:
     remoteWrite:
       - url: https://ingest.example.com/metrics/api/v1/write?api-version=2023-04-24
         authorization:
           type: Bearer
           credentials:
             name: remote-write-bearer
             key: token
         proxyUrl: http://proxy.example.local:8080
   ```

   If the embedded Prometheus CRD on the cluster is on an older schema that uses `bearerTokenSecret`, the equivalent is:

   ```yaml
   prometheus:
     remoteWrite:
       - url: https://ingest.example.com/metrics/api/v1/write?api-version=2023-04-24
         bearerTokenSecret:
           name: remote-write-bearer
           key: token
         proxyUrl: http://proxy.example.local:8080
   ```

3. Apply the change through whatever the observability stack uses to drive the Prometheus CR on the cluster — the ACP monitor stack reconciles the change into the Prometheus StatefulSet automatically. No pod restart is required; the reloader picks up the configuration change in-place.

4. Rotate the bearer token on whatever cadence the identity provider requires. Any external process — a CronJob that refreshes the token and updates the `Secret`, or a downstream `External Secret` integration — works, because Prometheus re-reads the `Secret` on config reload. Keep the token's validity window comfortably longer than the scrape/remote-write cycle.

If the remote-write target genuinely requires OAuth2 and does not accept a pre-issued bearer, the two working alternatives are:

- **Move the OAuth2 exchange out of Prometheus.** Deploy a sidecar / intermediate agent (Vector, otelcol, a lightweight proxy) that accepts Prometheus remote-write traffic in-cluster, performs the OAuth2 dance against the identity provider from outside the affected Prometheus binary, and relays to the final target. The sidecar is responsible for honouring proxy settings for both token fetch and data plane.
- **Whitelist the OAuth2 `tokenUrl` host in the egress network policy** so that Prometheus can reach it directly without the proxy. Only viable where direct egress to the identity-provider host is policy-permitted; otherwise stick with the bearer-token workaround above.

## Diagnostic Steps

1. Confirm the failure is actually in the token fetch, not in the remote-write POST. Tail the Prometheus pod log while the remote-write queue is active:

   ```bash
   kubectl -n <monitor-namespace> logs -l app.kubernetes.io/name=prometheus \
     | grep -Ei "remote_write|oauth2|token|proxy"
   ```

   Look for repeated `failed to fetch token` or connection-timeout messages against the `tokenUrl` host. A failing POST against the data plane would instead reference the `url` host.

2. Cross-check the two endpoints against the network policy from inside the Prometheus pod:

   ```bash
   kubectl -n <monitor-namespace> exec -it <prometheus-pod> -- \
     sh -c 'curl -sS --max-time 5 -o /dev/null -w "%{http_code}\n" \
             -x http://proxy.example.local:8080 \
             https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token; \
           curl -sS --max-time 5 -o /dev/null -w "%{http_code}\n" \
             https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token'
   ```

   The first curl (via proxy) should succeed; the second (direct) should fail. That combination confirms the token host is only reachable through the proxy and that Prometheus's direct attempt is doomed.

3. Inspect the Prometheus remote-write runtime metrics to verify the symptom and, after the switch, the recovery:

   ```bash
   kubectl -n <monitor-namespace> port-forward <prometheus-pod> 9090:9090
   # Then query:
   #   prometheus_remote_storage_failed_samples_total
   #   prometheus_remote_storage_samples_pending
   #   prometheus_remote_storage_sent_batch_duration_seconds_count
   ```

   Under the failing configuration `failed_samples_total` climbs while `sent_batch_duration` stays near zero; after switching to the bearer-token flow both should transition to the normal pattern (non-zero sent-batch count, flat failed-samples counter).

4. Check that the reloader saw the configuration change and the new `Secret` is mounted:

   ```bash
   kubectl -n <monitor-namespace> logs <prometheus-pod> -c config-reloader
   kubectl -n <monitor-namespace> get secret remote-write-bearer -o yaml \
     | grep -E "^  token:"
   ```

   If the reloader has not picked up the `Secret` yet, delete the Prometheus pod so the StatefulSet recreates it with the mount refreshed. Do not edit the `Secret` and leave the pod running expecting inline refresh if the CRD's `bearerTokenSecret` form is in use — only the file mount of the `Secret` is re-read on reload.
</content>
</invoke>
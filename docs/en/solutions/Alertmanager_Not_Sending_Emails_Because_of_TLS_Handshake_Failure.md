---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Alertmanager is failing to deliver notifications through its email receiver. Expected alerts never arrive in the target inbox, and the Alertmanager pod log shows TLS-related errors against the configured SMTP server — for example:

```text
level=error ... component=dispatcher
  msg="Notify for alerts failed" err="*email.loginAuth auth: EOF"
level=error ... component=dispatcher
  msg="Notify for alerts failed" err="establish connection: x509:
  certificate signed by unknown authority"
```

Symptoms cluster around three shapes: the SMTP server does not advertise `STARTTLS` but Alertmanager insists on it; the server does advertise it but the presented certificate does not validate against any CA Alertmanager trusts; or the handshake succeeds but authentication on top of it fails with a garbled password because the plaintext credentials were sent before the channel was upgraded.

## Root Cause

Alertmanager's email receiver defaults to `require_tls: true` and uses `STARTTLS` to upgrade the SMTP session to TLS before sending credentials or payload. This is the right default — it prevents `AUTH PLAIN` credentials from ever appearing on the wire unencrypted — but it makes Alertmanager fail closed whenever the TLS side of the connection is broken for any reason:

- **The SMTP server does not advertise the `STARTTLS` extension.** Many older internal relays, or "submission" (587) endpoints misconfigured as "smtp" (25), never offer `STARTTLS`. Alertmanager tries to upgrade, the server returns `502 command not recognized`, and Alertmanager aborts the session without sending anything.
- **The SMTP server advertises `STARTTLS` but the certificate does not validate.** Self-signed cert, certificate expired, hostname in the cert does not match the hostname Alertmanager is connecting to, or the chain is not fully present and Alertmanager cannot follow it to a known root.
- **Network path breaks the TLS session.** A transparent proxy terminating TLS mid-stream (common in some corporate networks) or a load balancer truncating the connection on an idle timeout.

Disabling TLS entirely fixes the symptom but leaves SMTP credentials going out in plaintext. Treat disable-TLS as a short-lived workaround while the real problem is being fixed, not the endpoint of the investigation.

## Resolution

### Preferred: fix the TLS side of the SMTP relay

1. **Confirm the SMTP server actually supports `STARTTLS` on the port you are using.** Run an interactive probe from inside the cluster against the same endpoint Alertmanager is configured for — use a one-shot pod with `openssl` so the probe traverses the same network policy path:

   ```bash
   kubectl -n <monitoring-namespace> run smtp-probe --rm -it \
     --image=alpine:3.19 --restart=Never -- \
     sh -c 'apk add --no-cache openssl >/dev/null &&
            openssl s_client -starttls smtp \
              -connect <smtp-host>:<port> -crlf 2>&1 | head -40'
   ```

   Expected: the server advertises `STARTTLS` and the handshake completes with a certificate whose Subject matches the hostname. If `STARTTLS` is missing, point Alertmanager at the correct port (usually 587 for submission / `STARTTLS`, 465 for implicit TLS — which Alertmanager reaches with `smtp_hello`/`smtp_smarthost` on that port and no `require_tls`).

2. **If the certificate does not validate, make Alertmanager trust the issuer.** Add the CA certificate to the ConfigMap Alertmanager consumes as its trust bundle and reference it from the receiver. For an ACP monitoring stack that provisions Alertmanager through the `observability/monitor` in-core surface, the CA bundle is referenced through the monitoring stack's TLS-trust configuration; supply the PEM and the controller will mount it into the Alertmanager pod:

   ```bash
   kubectl -n <monitoring-namespace> create configmap alertmanager-smtp-ca \
     --from-file=ca.crt=smtp-ca.crt
   ```

   Then point the email receiver at the bundle via `tls_config.ca_file` in the rendered `alertmanager.yaml` section of the stack's configuration — the monitoring controller merges user-provided receiver configuration with the platform defaults. For a self-managed Alertmanager deployment the same field is set directly in the Alertmanager config Secret.

### Workaround: disable TLS verification for one receiver

When the goal is to restore alerts urgently and the SMTP relay genuinely does not support TLS (internal test relay, temporary fallback), disable TLS for that one receiver. Do not disable it cluster-wide unless every configured relay is known-unencrypted.

The Alertmanager config lives in a Secret. Extract it, edit, and reapply:

```bash
kubectl -n <monitoring-namespace> extract secret/alertmanager-main --confirm

# edit alertmanager.yaml — for a single receiver:
#   receivers:
#     - name: testrec
#       email_configs:
#         - to: "ops@example.com"
#           require_tls: false
#
# for the whole global default:
#   global:
#     smtp_require_tls: false

kubectl -n <monitoring-namespace> create secret generic alertmanager-main \
  --from-file=alertmanager.yaml=alertmanager.yaml \
  --dry-run=client -o yaml \
  | kubectl apply -f -
```

For a managed stack where the configuration Secret is owned by a controller (the `observability/monitor` surface or the Prometheus Operator reconciling it), push the change through the controller's configuration CR instead of editing the Secret directly; otherwise the controller will overwrite your edit on the next reconcile.

Restart the Alertmanager pods so they pick up the new Secret on the next alert flush:

```bash
kubectl -n <monitoring-namespace> delete pod -l alertmanager=main
kubectl -n <monitoring-namespace> get pod -l alertmanager=main
```

After the pods are `Running`, send a test alert or wait for the next real one and confirm delivery.

## Diagnostic Steps

Look at the exact error Alertmanager is reporting. Different phrases map to different fixes:

```bash
kubectl -n <monitoring-namespace> logs \
  alertmanager-main-0 -c alertmanager --tail=200 \
  | grep -iE 'smtp|email|tls|starttls|x509'
```

- `establish connection: x509: certificate signed by unknown authority` → certificate validation problem, fix trust.
- `starttls: ... not recognized` or `502 command not recognized` → server does not advertise `STARTTLS`, fix the endpoint/port.
- `auth: EOF` or `login auth: unexpected response` → TLS is up but SMTP authentication is failing, check credentials (often rotated without the Secret being updated) and whether the server expects `LOGIN` vs `PLAIN`.
- `RequestTimeTooSkewed` or `certificate expired` — clock skew or server-side cert expiry.

Probe the SMTP server directly as shown in the resolution, then compare the certificate the probe retrieves with the certificate Alertmanager is attempting to validate. A mismatch on Subject / SANs against the hostname in `smtp_smarthost` means the receiver configuration should point at whichever hostname the certificate actually covers, not an IP or short name.

Validate the Alertmanager configuration syntax locally before applying:

```bash
kubectl -n <monitoring-namespace> extract secret/alertmanager-main --to=- \
  | amtool check-config alertmanager.yaml
```

Syntactic errors in the email receiver (missing `smtp_smarthost`, invalid `require_tls` value) will cause Alertmanager to refuse to reload the configuration entirely — the old configuration continues to serve, which masks the fact that the new one never landed.

Once deliveries resume, ensure rotation hygiene: store SMTP credentials in a separate Secret referenced by the configuration rather than inline, so rotating them does not require rewriting the full Alertmanager config each time.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Alertmanager Email Receiver Fails SMTP Certificate Validation
## Issue

Email notifications from Alertmanager stop being delivered. The Alertmanager pod log carries one of the following error shapes:

```text
level=warn component=dispatcher receiver=MyEmailReceiver=email[0]
  msg="Notify attempt failed, will retry later" attempts=1
  err="send STARTTLS command: x509: cannot validate certificate for
       because it doesn't contain any IP SANs"
```

```text
level=warn component=dispatcher receiver=MyEmailReceiver=email[0]
  aggrGroup="{}:{namespace=\"[namespace_name]\"}"
  msg="Notify attempt failed, will retry later" attempts=7
  err="send STARTTLS command: tls: failed to verify certificate:
       x509: certificate has expired or is not yet valid:
       current time 2026-01-01T00:00:00Z is after 2025-12-31T23:59:59Z"
```

The receiver's retry counter keeps climbing and no alert reaches the target inbox.

## Root Cause

Alertmanager defaults to `smtp_require_tls: true`, so every outbound connection upgrades to TLS via `STARTTLS` and the Go TLS client validates the server certificate chain. Validation fails in two common ways:

- **Expired certificate.** The server certificate's `notAfter` is in the past relative to the Alertmanager pod's clock.
- **Hostname or IP SAN mismatch.** The `smtp_smarthost` value is an IP literal but the certificate's `Subject Alternative Name` extension only lists DNS names (or vice versa — a hostname is used but the SAN only lists IPs).

In both cases Go refuses to proceed and reports the error seen above.

## Resolution

Fix the server certificate or the way Alertmanager addresses the SMTP server so that the certificate presented matches the name in `smtp_smarthost`.

1. If the certificate is expired, rotate it on the SMTP server. Nothing changes on the Alertmanager side.

2. If the error is `doesn't contain any IP SANs`, the certificate is issued to a hostname but `smtp_smarthost` uses an IP address. Replace the IP with the hostname that is listed in the SAN extension of the server certificate. Example `alertmanager.yaml` fragment:

   ```yaml
   global:
     smtp_from: myuser@example.com
     smtp_smarthost: smtp.example.com:587
     smtp_auth_username: myuser@example.com
     smtp_auth_password: password
     smtp_require_tls: true
   ```

   If the SMTP server's certificate legitimately carries the IP in the SAN (`IP:10.x.x.x`), the reverse is also valid — keep the IP form and leave the hostname out. The rule is that whichever string you put in `smtp_smarthost` must appear in the server certificate's SAN.

3. Apply the Alertmanager secret change through the monitor stack's normal configuration path — typically by editing the `kube-prometheus-alertmanager` Secret (in the monitor namespace) and letting the Alertmanager pods reload, or by updating whatever higher-level Alertmanager configuration resource the platform exposes:

   ```bash
   kubectl -n cpaas-system get secret kube-prometheus-alertmanager \
     -o jsonpath='{.data.alertmanager\.yaml}' | base64 -d
   ```

   Edit the decoded YAML, base64-encode it, and patch it back:

   ```bash
   kubectl -n cpaas-system edit secret kube-prometheus-alertmanager
   ```

Skipping verification with `tls_config.insecure_skip_verify: true` is technically possible and is supported by the upstream Alertmanager schema, but it disables the whole point of using TLS on an email channel and should not be used in production. Treat it as a last-resort workaround on an isolated network, and even then only while the proper certificate is being rotated.

## Diagnostic Steps

Tail the Alertmanager pod log to capture the exact TLS error:

```bash
kubectl -n cpaas-system logs -l app.kubernetes.io/name=alertmanager --tail=200
```

Read the current SMTP configuration out of the Secret:

```bash
kubectl -n cpaas-system get secret kube-prometheus-alertmanager \
  -o jsonpath='{.data.alertmanager\.yaml}' | base64 -d | grep -E 'smtp_smarthost|smtp_require_tls'
```

Inspect the server certificate the SMTP endpoint actually presents. Use `openssl` with `-starttls smtp`:

```bash
kubectl -n cpaas-system run -it --rm smtp-check \
  --image=alpine/openssl --restart=Never -- \
  openssl s_client -starttls smtp -connect <SMTP_HOST>:<SMTP_PORT> -showcerts
```

Check two things in the output:

- The `notAfter` field of the leaf certificate — if it is in the past, the server certificate has expired.
- The `X509v3 Subject Alternative Name` extension — it should list whatever string (DNS name or IP) `smtp_smarthost` uses. A hostname-only SAN will reject an IP-based `smtp_smarthost`, and vice versa.

After correcting `smtp_smarthost` or rotating the certificate, watch the Alertmanager logs for notifications succeeding (`msg="Notify success"`). If the error persists with the hostname form, DNS inside the cluster may be returning a different IP than the one the certificate was issued for — resolve the name from a pod to confirm.

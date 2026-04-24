---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Alertmanager cannot deliver alerts through an email receiver. The Alertmanager pod log shows that the notifier aborts every attempt because the configured SMTP server never advertises `STARTTLS`:

```text
level=warn component=dispatcher receiver=My Email Receiver=email[0]
  msg="Notify attempt failed, will retry later" attempts=1
  err="'require_tls' is true (default) but \"smtp.example.com:587\"
       does not advertise the STARTTLS extension"
```

Because `smtp_require_tls` defaults to `true`, Alertmanager refuses to hand off the message over an unencrypted channel and retries indefinitely.

## Root Cause

Per RFC 2487, an SMTP server announces TLS support by returning `250-STARTTLS` in its response to the client's `EHLO`. If that line is missing from the `EHLO` reply, the server is not willing (or not configured) to upgrade the session to TLS. Alertmanager observes the absent capability and — because the receiver was told to require TLS — refuses to continue.

## Resolution

Fix the SMTP side rather than the monitoring side: enable the `STARTTLS` extension on the SMTP server so that it advertises `250-STARTTLS` in its `EHLO` response. Once the capability is visible, Alertmanager will negotiate TLS and the receiver recovers without any change to the Alertmanager Secret.

Two supporting notes:

- If the target SMTP server genuinely cannot support TLS (legacy appliance, internal-only relay on a trusted network), the *only* alternative is to relax `smtp_require_tls` — e.g. set it to `false` in the receiver block of `alertmanager.yaml`. This is insecure, sends credentials and message bodies in the clear, and should be treated as a temporary bypass, not a fix. Keep the receiver on an internal network, tighten firewall rules, and plan the TLS rollout on the relay.
- If TLS is actually desired but the server is misadvertising because of a broken TLS handshake (expired certificate, SAN mismatch), the error surfaces differently — as a certificate-validation failure on the client side, not as "does not advertise the STARTTLS extension". Treat that as a separate class of issue and inspect the server certificate.

## Diagnostic Steps

Confirm the error surfaces exactly as above in the Alertmanager pod log:

```bash
kubectl -n cpaas-system logs -l app.kubernetes.io/name=alertmanager --tail=200
```

Probe the SMTP server directly from a pod on the cluster to check whether `STARTTLS` is announced. Using `curl` against an `smtp://` URL prints the `EHLO` response; using `openssl` drives the handshake end-to-end:

```bash
kubectl -n cpaas-system run -it --rm smtp-check \
  --image=alpine/openssl --restart=Never -- \
  openssl s_client -starttls smtp -connect smtp.example.com:587
```

In the transcript, look for `250-STARTTLS` in the `EHLO` section:

```text
< 220 smtp.example.com ESMTP ...
> EHLO ...
< 250-smtp.example.com at your service
< 250-SIZE 35882577
< 250-8BITMIME
< 250-STARTTLS        <-- this line must be present
< 250-ENHANCEDSTATUSCODES
< 250-PIPELINING
< 250 SMTPUTF8
> STARTTLS
< 220 2.0.0 Ready to start TLS
```

If `250-STARTTLS` is absent, the SMTP server itself is the problem. If it is present but Alertmanager still reports the same error, double-check that the `smtp_smarthost` Alertmanager is using really is the host you are probing — a stale DNS cache or a wrong port in the receiver secret will send traffic elsewhere.

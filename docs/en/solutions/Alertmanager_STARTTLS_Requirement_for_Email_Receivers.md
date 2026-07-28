---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Alertmanager STARTTLS Requirement for Email Receivers

## Overview

The ACP monitoring stack ships the upstream Prometheus Alertmanager binary unchanged, currently image `3rdparty/prometheus/alertmanager` at upstream tag `v0.32.1` (packaged on ACP as `v0.32.1-v4.3.4`), running as a pod in the `cpaas-system` namespace. The `prometheus-operator` bundle on this platform advertises both the `Alertmanager` and `AlertmanagerConfig` CRDs (`monitoring.coreos.com/v1alpha1` for the latter), so the upstream `email_config` schema is the structural carrier for per-receiver email settings on ACP.

This reference describes one specific behavioral contract of the upstream binary that surfaces frequently on first email-receiver setup: the interaction between the receiver's `require_tls` flag and the SMTP server's STARTTLS advertisement (RFC 3207).

## Issue

When an Alertmanager email receiver is configured with `require_tls: true` (which is the upstream default if the flag is omitted) and the configured SMTP server's response to the `EHLO` command does not contain a `250-STARTTLS` capability line, the upstream Alertmanager binary at this release is documented to log an error matching the form `'require_tls' is true (default) but "<host>:<port>" does not advertise the STARTTLS extension`; email submission does not proceed while the flag remains true.

## Root Cause

The condition is determined by the SMTP server, not by Alertmanager. RFC 3207 specifies that an SMTP server willing to accept a TLS upgrade must advertise the `STARTTLS` capability in its EHLO reply; absence of that line is treated by Alertmanager as "the server does not support the upgrade", and the receiver does not fall back to plaintext while `require_tls` is still `true`.

## Resolution

The recommended fix is to enable STARTTLS on the SMTP server itself so that its EHLO response advertises `250-STARTTLS`; once it does, the existing Alertmanager configuration continues to apply without modification and the TLS guarantee is preserved.

If the SMTP server cannot be changed and plaintext submission is acceptable in the local environment, the upstream `email_config` schema exposes a `require_tls` boolean field that can be set to `false` per receiver, or `smtp_require_tls: false` can be set in the global block to apply cluster-wide; either setting drops the receiver to a plain-text SMTP submission and should be treated as a workaround rather than a target state. In the `AlertmanagerConfig` CR the corresponding camelCase field is `emailConfigs[].requireTLS`; in the flat `alertmanager.yaml` it is `email_configs[].require_tls`.

The following minimal `AlertmanagerConfig` CR follows the upstream `monitoring.coreos.com/v1alpha1` schema (field names are upstream-inferred from the prometheus-operator v1alpha1 `emailConfig` shape; the bundle on this platform advertises the kind at exactly this version):

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: ops-email
  namespace: cpaas-system
spec:
  receivers:
    - name: ops
      emailConfigs:
        - to: ops@example.invalid
          smarthost: smtp.example.invalid:25
          from: alertmanager@example.invalid
          authUsername: alertmanager
          requireTLS: false
```

## Diagnostic Steps

Whether the SMTP server actually advertises STARTTLS can be verified independently of Alertmanager by speaking the SMTP protocol manually from any pod or node that can reach the SMTP host; a successful probe surfaces a line containing `250-STARTTLS` in the EHLO response, and absence of that line indicates the server side has not enabled the extension.

```bash
openssl s_client -starttls smtp -connect smtp.example.invalid:25 -crlf
```

A response containing the `250-STARTTLS` line indicates the server side has the extension enabled and matches what the upstream `require_tls: true` contract expects; absence of the line indicates the server must be reconfigured (or `require_tls` lowered per the Resolution section) before the receiver's configured behavior aligns with the server.

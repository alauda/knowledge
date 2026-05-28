---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Configure a Custom CA Certificate for Alertmanager's SMTP Email Receiver on ACP

## Issue

On Alauda Container Platform with the `prometheus` ModulePlugin installed (chart `ait/chart-kube-prometheus` v4.3.3, image `3rdparty/prometheus/alertmanager:v0.32.1-v4.3.4`), Alertmanager's SMTP email receiver must validate the smarthost's TLS certificate against the in-container trust store. When the smarthost certificate is signed by a private or internal CA that is not present in that trust store, the TLS handshake to the SMTP server fails with `x509: certificate signed by unknown authority` and the configured email notifications are never delivered.

## Root Cause

The Alertmanager binary shipped in `cpaas-system` is upstream Alertmanager v0.32.1, which honors the upstream `email_configs[].tls_config.ca_file` field. That field takes a filesystem path inside the Alertmanager container pointing at a PEM-encoded CA bundle used to verify the smarthost certificate. If `ca_file` is not set (or does not reference the issuer of the smarthost certificate), the connection is verified against the container's default trust store only — which does not include arbitrary internal or private CAs — and the receiver logs the x509 verification failure rather than sending mail.

## Resolution

Provide the private CA bundle to the Alertmanager pod by creating a Kubernetes Secret in `cpaas-system` and listing it on the platform's Alertmanager CR. The supported mount surface is the upstream prometheus-operator `Alertmanager.spec.secrets[]` field — the same field the platform already exercises on `Alertmanager` `cpaas-system/kube-prometheus`, whose live `spec.secrets` includes `callback-secret` mounted by the operator.

Create the Secret holding the PEM-encoded CA bundle (replace the file path with the actual CA bundle on disk):

```bash
kubectl -n cpaas-system create secret generic smtp-ca-bundle \
  --from-file=ca.crt=/path/to/smtp-ca.pem
```

Add the secret name to the Alertmanager CR's `spec.secrets[]`. The prometheus-operator reconciles `spec.secrets[]` and mounts each entry into the Alertmanager pod at `/etc/alertmanager/secrets/<secret-name>/` (read-only), the same way `callback-secret` is currently mounted at `/etc/alertmanager/secrets/callback-secret/` on the running pod:

```bash
kubectl -n cpaas-system patch alertmanager kube-prometheus \
  --type merge \
  -p '{"spec":{"secrets":["smtp-ca-bundle"]}}'
```

When multiple secrets are required, pass the full list (the patch replaces `spec.secrets` rather than appending) so existing entries such as `callback-secret` are preserved.

Reference the mounted bundle from the email receiver via the operator-produced path `/etc/alertmanager/secrets/<secret-name>/<key-in-secret>`. The same path pattern is already used in the live rendered `alertmanager.yaml`, where `bearer_token_file: /etc/alertmanager/secrets/callback-secret/token` resolves the `callback-secret` mount — the CA bundle uses the identical shape:

```yaml
receivers:
  - name: email-receiver
    email_configs:
      - to: ops@example.com
        from: alertmanager@example.com
        smarthost: smtp.example.internal:587
        auth_username: alertmanager@example.com
        auth_identity: alertmanager@example.com
        auth_password: <smtp-password>
        require_tls: true
        tls_config:
          ca_file: /etc/alertmanager/secrets/smtp-ca-bundle/ca.crt
```

Keep `require_tls: true` (or omit it and rely on the upstream default) on the receiver, and do not set `insecure_skip_verify: true` — enabling skip-verify bypasses the custom CA mount entirely and silently disables certificate validation, defeating the purpose of supplying the bundle.

As an alternative to hand-editing the rendered alertmanager configuration, the AlertmanagerConfig CRD (`alertmanagerconfigs.monitoring.coreos.com/v1alpha1`) exposes the same custom-CA capability as a typed field. `spec.receivers[].emailConfigs[].tlsConfig.ca` is an object with `{configMap, secret}` selectors — a `SecretKeySelector` referencing a Secret + key holding the PEM CA bundle, rather than a raw filesystem path:

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: email-with-ca
  namespace: cpaas-system
spec:
  receivers:
    - name: email-receiver
      emailConfigs:
        - to: ops@example.com
          from: alertmanager@example.com
          smarthost: smtp.example.internal:587
          requireTLS: true
          tlsConfig:
            ca:
              secret:
                name: smtp-ca-bundle
                key: ca.crt
```

## Diagnostic Steps

Confirm the symptom by tailing the Alertmanager container log; the upstream Notify path emits the x509 verification failure verbatim from the alertmanager container:

```bash
kubectl -n cpaas-system logs statefulset/alertmanager-kube-prometheus \
  -c alertmanager --tail=200 | grep -i 'x509\|certificate'
```

A log line containing `x509: certificate signed by unknown authority` from the dispatcher / notify path confirms the SMTP smarthost certificate's issuer is not present in the container trust store and that a custom `ca_file` mount is required.

After applying the Secret and patching `spec.secrets[]`, verify the operator has wired the mount into the Alertmanager pod at the expected path:

```bash
kubectl -n cpaas-system get pod -l app.kubernetes.io/name=alertmanager \
  -o jsonpath='{range .items[*].spec.containers[?(@.name=="alertmanager")].volumeMounts[*]}{.mountPath}{"\n"}{end}' \
  | grep '/etc/alertmanager/secrets/'
```

The output should list `/etc/alertmanager/secrets/smtp-ca-bundle` alongside any pre-existing entries such as `/etc/alertmanager/secrets/callback-secret`.

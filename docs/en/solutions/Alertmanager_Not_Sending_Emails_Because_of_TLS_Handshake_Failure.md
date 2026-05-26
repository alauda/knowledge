---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
---

# Alertmanager email delivery fails to an SMTP smarthost on ACP

## Issue

On Alauda Container Platform clusters that have the `prometheus` ModulePlugin (v4.3.3) installed, the Alertmanager workload runs in the `cpaas-system` namespace as part of the kube-prometheus chart (`ait/chart-kube-prometheus` v4.3.1, release name `kube-prometheus`). When operators add an SMTP email receiver on top of the platform default and the smarthost interaction fails — whether at the TCP connect, the TLS negotiation, or the SMTP dialogue itself — alerts are not delivered. The actual log line shape depends on which stage of the delivery fails, so the diagnostic entry point for this class of failure is the alertmanager container log on the Alertmanager pod in `cpaas-system` [ev:c2].

## Root Cause

ACP ships a default Alertmanager configuration (`configForACP` in the kube-prometheus chart) that only defines a webhook receiver pointed at the platform CPAAS route — no SMTP global block and no email receiver are present out of the box. Email delivery only works once an operator layers an SMTP global section and an email receiver on top of the default, either by editing the rendered config secret or by creating an `AlertmanagerConfig` custom resource. A misconfigured `smtp_require_tls` / per-receiver `require_tls` toggle in that user-supplied overlay is the typical source of the SMTP-delivery failure surface, with the exact log line determined by where in the connect / TLS / SMTP dialogue the receiver actually rejects [ev:c5].

## Resolution

The Alertmanager configuration is held in a Kubernetes Secret named `alertmanager-<alertmanager-cr-name>` in the same namespace as the Alertmanager custom resource. On an ACP cluster with the standard kube-prometheus release, that resolves to Secret `alertmanager-kube-prometheus` in `cpaas-system`. The Secret's `alertmanager.yaml` key holds the rendered configuration, and editing that key followed by re-applying the Secret is the structural workaround surface for any change to the receiver layer [ev:c3].

Read the current rendered configuration so the overlay is layered on top of the existing structure rather than blindly replacing it:

```bash
kubectl get secret -n cpaas-system alertmanager-kube-prometheus \
  -o jsonpath='{.data.alertmanager\.yaml}' | base64 -d
```

A TLS handshake failure against the smarthost almost always means the smarthost's certificate is not trusted by Alertmanager or the server name does not match — not that TLS itself should be turned off. Fix the trust problem first: point the receiver at the correct CA bundle and (when needed) the matching server name, rather than disabling encryption. The `AlertmanagerConfig` CRD exposes this directly via `spec.receivers[].emailConfigs[].tlsConfig` (CA certificate, client cert/key, and `serverName`); the raw `alertmanager.yaml` form carries the equivalent `email_configs[].tls_config` block. Supplying the smarthost's issuing CA so the certificate validates is the correct resolution and keeps the SMTP session encrypted [ev:c6].

```yaml
receivers:
- name: email-ops
  email_configs:
  - to: ops@example.internal
    tls_config:
      ca_file: /etc/alertmanager/smtp-ca/ca.crt
      server_name: smtp.example.internal
```

Disabling TLS verification or TLS itself is a last-resort, temporary workaround — for example to confirm the smarthost is otherwise reachable while a proper CA bundle is being sourced. It sends credentials and alert contents in cleartext (or unverified), so it must not be left in place in production. If you must apply it temporarily, the relevant upstream keys are the cluster-wide `global.smtp_require_tls: false` toggle and the per-receiver `email_configs[].require_tls: false` toggle (typed `requireTLS: false` on the CRD); prefer `tls_config.insecure_skip_verify: true`, which keeps the channel encrypted while skipping only certificate validation, over `require_tls: false`, which drops encryption entirely [ev:c4].

A minimal overlay layered on top of the platform-default `configForACP` looks roughly as follows — adjust receiver names and smarthost to the environment, and prefer the `tls_config` CA path above over the `*_require_tls: false` toggles shown here:

```yaml
global:
  smtp_smarthost: smtp.example.internal:587
  smtp_from: alerts@example.internal
  smtp_auth_username: alerts@example.internal
  smtp_auth_password: redacted
  smtp_require_tls: false  # last-resort workaround only — see warning above
receivers:
- name: email-ops
  email_configs:
  - to: ops@example.internal
    require_tls: false      # last-resort workaround only — prefer tls_config CA
```

Re-render the secret with the updated `alertmanager.yaml` and apply it back into `cpaas-system`. After editing the configuration secret, the alertmanager pod must pick up the new configuration; the typical action is to delete the alertmanager pod so the StatefulSet recreates it and the prometheus-operator-rendered secret is re-mounted into the container [ev:c7]:

```bash
kubectl delete pod -n cpaas-system -l app.kubernetes.io/name=alertmanager
```

For environments that prefer a typed, Kubernetes-native surface over hand-edited secret payloads, the `prometheus-operator` chart (`ait/chart-prometheus-operator`) ships the `AlertmanagerConfig` CRD; on this ACP install the served version is `monitoring.coreos.com/v1alpha1`. The CRD models the SMTP and TLS surface as typed fields under `spec.receivers[].emailConfigs[]` — including `smarthost`, `requireTLS`, `tlsConfig` (with CA / cert / `insecureSkipVerify`), `authUsername`, `authPassword` (Secret reference), and `forceImplicitTLS` — providing an alternative to direct edits of the raw `alertmanager.yaml` secret [ev:c6].

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: email-ops
  namespace: cpaas-system
spec:
  receivers:
  - name: email-ops
    emailConfigs:
    - to: ops@example.internal
      smarthost: smtp.example.internal:587
      requireTLS: true
      tlsConfig:
        ca:
          secret:
            name: alertmanager-smtp-ca
            key: ca.crt
        serverName: smtp.example.internal
      authUsername: alerts@example.internal
      authPassword:
        name: alertmanager-smtp
        key: password
```

The example above keeps TLS on (`requireTLS: true`) and supplies the smarthost CA through `tlsConfig` so the certificate validates — the preferred shape. Set `requireTLS: false` only as the temporary, production-unsafe workaround described above.

## Diagnostic Steps

Tail the alertmanager container log to observe the SMTP delivery failure surface and to verify recovery after the overlay change [ev:c2]:

```bash
kubectl logs -n cpaas-system -l app.kubernetes.io/name=alertmanager \
  -c alertmanager --tail=200 -f
```

Inspect the active configuration the running pod has mounted to make sure the overlay reached the workload rather than only the Secret object [ev:c3]:

```bash
kubectl get secret -n cpaas-system alertmanager-kube-prometheus \
  -o jsonpath='{.data.alertmanager\.yaml}' | base64 -d
```

If the rendered configuration looks correct but the log still shows the prior failure, the pod has not yet re-mounted the updated secret; delete the alertmanager pod so the StatefulSet recreates it and the new configuration is picked up [ev:c7].

---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Configure a Custom CA Certificate for Alertmanager's SMTP Email Receiver
## Issue

Alertmanager is configured to send notifications through an internal SMTP relay that presents a TLS certificate signed by a private (in-house) Certificate Authority. Notifications never arrive at their inbox; the Alertmanager pod log shows a TLS handshake failure against the SMTP server:

```text
level=error ts=... caller=dispatch.go... component=dispatcher
  msg="Notify for alerts failed"
  ... err="... x509: certificate signed by unknown authority"
```

The SMTP server is reachable (TCP connects succeed), the credentials are correct, and the same mail server works for other clients that trust the in-house CA. What Alertmanager is missing is a path from its container's CA-trust store to the certificate chain the SMTP server presents.

## Root Cause

The Alertmanager container image ships with the default public CA bundle. Private CAs — including whatever the organisation uses to sign internal service certificates — are not in that bundle. When Alertmanager opens a TLS connection to the SMTP server, its standard library's verifier walks up the presented chain, does not find the private root in its trust store, and aborts with `x509: certificate signed by unknown authority`.

Fixing this needs two steps working together:

1. The private CA bundle has to be **available to the pod**. It is delivered as a `Secret` mounted into the Alertmanager container by the monitoring stack's operator.
2. The SMTP receiver in Alertmanager's own configuration has to **point at the mounted path** as its `ca_file`.

Either step alone is not enough. If the Secret is mounted but the receiver does not reference it, Alertmanager keeps using the default bundle. If the receiver references a path but no Secret mounts there, the connection fails earlier (file not found) rather than with the cleaner `unknown authority` error.

## Resolution

Three objects, applied in order.

### Step 1 — create the CA Secret in the monitoring namespace

Gather the full private-CA certificate (the root, and any intermediate certificates needed to chain up to the SMTP server's leaf) into a single `ca.crt` file and create a Secret in the monitoring namespace:

```bash
# Validate the file chain before creating the Secret.
openssl crl2pkcs7 -nocrl -certfile /path/to/internal-ca.crt | \
  openssl pkcs7 -print_certs -noout | head -20

kubectl -n cpaas-monitoring create secret generic custom-email-ca \
  --from-file=ca.crt=/path/to/internal-ca.crt
```

The Secret name (`custom-email-ca`) is what the monitoring stack's configuration references in Step 2.

### Step 2 — tell the monitoring stack to mount the Secret into Alertmanager

The monitoring stack's central config (`cluster-monitoring-config` ConfigMap or the platform's equivalent CR) accepts a list of additional Secrets to mount. Add the Secret from Step 1:

```bash
kubectl -n cpaas-monitoring edit configmap cluster-monitoring-config
```

Modify (or add) the `alertmanagerMain` block so it includes:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-monitoring-config
  namespace: cpaas-monitoring
data:
  config.yaml: |
    alertmanagerMain:
      secrets:
        - custom-email-ca
```

The monitoring operator reconciles the change and rolls the Alertmanager pods. After the roll, each pod mounts the Secret's contents at a predictable path:

```text
/etc/alertmanager/secrets/<secret-name>/<key-in-secret>
```

So the `ca.crt` key of the `custom-email-ca` Secret appears inside the pod at:

```text
/etc/alertmanager/secrets/custom-email-ca/ca.crt
```

Verify the mount before moving on:

```bash
POD=$(kubectl -n cpaas-monitoring get pod -l app.kubernetes.io/name=alertmanager \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n cpaas-monitoring exec "$POD" -c alertmanager -- \
  ls -l /etc/alertmanager/secrets/custom-email-ca/
# -rw-------  1  nobody  nobody  2100 ... ca.crt
```

### Step 3 — point the email receiver at the mounted CA

Alertmanager's own configuration lives in a Secret (conventionally named `alertmanager-main` or `alertmanager-<name>` depending on the operator). The email receiver's `tls_config.ca_file` must point at the Step-2 mount path:

```yaml
# Inside the alertmanager.yaml that the alertmanager Secret holds.
receivers:
  - name: email-receiver
    email_configs:
      - to:   admin@example.com
        from: alertmanager@example.com
        smarthost: smtp.example.com:587
        auth_username: alertmanager
        auth_password: <smtp-password>
        require_tls: true
        tls_config:
          ca_file: /etc/alertmanager/secrets/custom-email-ca/ca.crt
          insecure_skip_verify: false
```

`require_tls: true` forces the TLS handshake. `insecure_skip_verify: false` (or leaving the key out entirely, which defaults to `false`) makes sure the handshake actually verifies against `ca_file`.

Depending on how the monitoring stack exposes Alertmanager configuration, update `alertmanager.yaml` through the operator's config surface rather than editing the Secret directly (the operator will reconcile direct edits back). Typical path is:

```bash
# Via the monitoring stack's user-workload configuration ConfigMap / CR.
kubectl -n cpaas-monitoring edit configmap alertmanager-config
```

After the update reconciles, send a test alert (silence and unsilence a low-severity rule, or use Alertmanager's API to fire a dummy notification) and confirm the SMTP relay now receives the message.

### TLS-level pitfalls to avoid

- **Do not rely on `insecure_skip_verify: true`**. It makes the error disappear but also disables authentication of the SMTP server — a private network SMTP compromise can then impersonate the relay.
- **Do include the full chain**, not just the root. If the SMTP server's leaf is signed by an intermediate, include the intermediate in the `ca.crt` file — the verifier walks only from the presented chain upward, so the intermediate needs to be present somewhere.
- **Watch the file mode on the mount**. If the operator mounts the Secret with a mode the Alertmanager user cannot read, the `ca_file` read fails silently. The monitoring operator handles this automatically on most builds; if not, verify with `ls -l` inside the pod.

## Diagnostic Steps

Confirm the error is the TLS trust failure specifically (not a different email issue):

```bash
POD=$(kubectl -n cpaas-monitoring get pod -l app.kubernetes.io/name=alertmanager \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n cpaas-monitoring logs "$POD" -c alertmanager --tail=500 | \
  grep -E 'Notify for alerts failed|unknown authority|x509'
```

`unknown authority` confirms this note. A different error (authentication failure, timeouts, connection refused) points elsewhere and needs a different fix.

Check that Step 1 and Step 2 are both in place:

```bash
# Secret exists in the monitoring ns.
kubectl -n cpaas-monitoring get secret custom-email-ca -o jsonpath='{.data}{"\n"}' | jq 'keys'
# ["ca.crt"]

# Mounted in the Alertmanager pod.
kubectl -n cpaas-monitoring exec "$POD" -c alertmanager -- \
  ls /etc/alertmanager/secrets/custom-email-ca/
```

After Step 3, verify the Alertmanager config inside the pod reflects the change:

```bash
kubectl -n cpaas-monitoring exec "$POD" -c alertmanager -- \
  cat /etc/alertmanager/config/alertmanager.yaml | grep -A3 'email_configs'
```

The `ca_file` line should name the full `/etc/alertmanager/secrets/custom-email-ca/ca.crt` path.

Test the TLS handshake directly from inside the pod to rule out any network or certificate issue independent of Alertmanager:

```bash
kubectl -n cpaas-monitoring exec "$POD" -c alertmanager -- \
  openssl s_client -connect smtp.example.com:587 \
                   -starttls smtp \
                   -CAfile /etc/alertmanager/secrets/custom-email-ca/ca.crt \
                   -verify_return_error < /dev/null
```

`Verify return code: 0 (ok)` confirms the CA file is correct and the SMTP server's certificate chains up to it. Once the handshake verifies at this level, Alertmanager's next notification attempt succeeds.

---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Deploy a Throwaway SMTP Sink to Test Alertmanager Email Receiver Configuration

## Issue

When wiring up an Alertmanager email receiver (`smtp_smarthost`, `smtp_auth_username`, `smtp_from`, `smtp_require_tls`, etc.) the actual delivery path runs through corporate relays, anti-spam filters, and TLS chains that may quarantine, silently drop, or rate-limit the test alert. A failed delivery in any of those layers makes it hard to tell whether the misconfiguration is in Alertmanager, in the relay, or in the recipient mailbox. A disposable in-cluster SMTP sink lets the operator verify the Alertmanager pipeline end-to-end before swapping the smarthost back to the production relay.

## Resolution

### Step 1 — Deploy a throwaway SMTP sink in-cluster

[`mailhog`](https://github.com/mailhog/MailHog) is a single-binary SMTP server that accepts every message into an in-memory store and exposes them through an HTTP UI. Run it as a single Pod fronted by a ClusterIP Service:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mailhog
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels: { app: mailhog }
  template:
    metadata:
      labels: { app: mailhog }
    spec:
      containers:
        - name: mailhog
          image: mailhog/mailhog:v1.0.1
          ports:
            - containerPort: 1025
              name: smtp
            - containerPort: 8025
              name: http
---
apiVersion: v1
kind: Service
metadata:
  name: mailhog
  namespace: monitoring
spec:
  selector: { app: mailhog }
  ports:
    - name: smtp
      port: 1025
      targetPort: 1025
    - name: http
      port: 8025
      targetPort: 8025
```

### Step 2 — Point Alertmanager at the sink

Edit the Alertmanager configuration so the `smtp_smarthost` is `mailhog.monitoring.svc.cluster.local:1025` and authentication is disabled (the sink accepts everything):

```yaml
global:
  smtp_smarthost: 'mailhog.monitoring.svc.cluster.local:1025'
  smtp_from: 'alerts@example.com'
  smtp_require_tls: false
  smtp_hello: 'alertmanager'

route:
  receiver: smoke

receivers:
  - name: smoke
    email_configs:
      - to: 'oncall@example.com'
        require_tls: false
        send_resolved: true
```

If Alertmanager is managed by the Prometheus Operator, the corresponding `AlertmanagerConfig` CR uses the same `email_configs` shape; if it is configured by a `Secret` named `alertmanager-main` (or similar), edit the Secret's `alertmanager.yaml` payload and restart the Alertmanager Pods.

### Step 3 — Drive a test alert

Create a `PrometheusRule` that always fires, attached to whatever `Prometheus` instance Alertmanager listens to:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: smoketest-always-firing
  namespace: monitoring
  labels:
    role: alert-rules
spec:
  groups:
    - name: smoketest
      rules:
        - alert: SmoketestAlert
          expr: vector(1)
          for: 0m
          labels:
            severity: info
          annotations:
            summary: Alertmanager email path smoke test
            description: This alert always fires; safe to ignore once seen in mailhog.
```

Within one or two scrape intervals the alert reaches Alertmanager and the email receiver fires.

### Step 4 — Verify the message landed

Port-forward the mailhog HTTP UI:

```bash
kubectl -n monitoring port-forward svc/mailhog 8025:8025
```

Open `http://127.0.0.1:8025` and confirm the test alert appears with the configured `From:` and `To:` headers and the rendered Alertmanager body. The same data is available through the JSON API:

```bash
curl -s http://127.0.0.1:8025/api/v2/messages | jq '.items[0] | {From, To, Subject: .Content.Headers.Subject}'
```

### Step 5 — Cleanup

Delete the smoke-test PrometheusRule, switch Alertmanager `smtp_smarthost` back to the production relay, and remove the mailhog Deployment/Service.

## Diagnostic Steps

If the message never reaches mailhog:

- Check that Alertmanager actually received the alert from Prometheus:

  ```bash
  kubectl -n monitoring exec deploy/alertmanager-main -c alertmanager -- \
    wget -qO- http://localhost:9093/api/v2/alerts | jq '.[].labels.alertname'
  ```

- Tail the Alertmanager log for the SMTP attempt:

  ```bash
  kubectl -n monitoring logs deploy/alertmanager-main -c alertmanager --tail=50 | grep -i smtp
  ```

- Confirm Pod-to-Pod DNS resolves the sink Service:

  ```bash
  kubectl -n monitoring exec deploy/alertmanager-main -- \
    nslookup mailhog.monitoring.svc.cluster.local
  ```

- If TLS is forced upstream, set `smtp_require_tls: false` for the smoke test only — re-enable it before pointing back at the production relay.

---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Editing the Alertmanager configuration in the platform's monitoring stack
## Issue

The platform's monitoring stack runs Alertmanager as a StatefulSet whose configuration is held in a Secret, not in a free-standing ConfigMap. Common change drivers:

- Add a receiver (email, Slack, PagerDuty, webhook) for an alert that today only fires the platform's default route.
- Tighten or relax `repeat_interval` / `group_wait` / `group_interval` to suit the operator on call.
- Route a specific `alertname` or `service` label to a dedicated team mailing list.

Editing Alertmanager's running config means rewriting that Secret and letting the Operator-managed StatefulSet reload. This article walks through the supported change shape and the validation steps that confirm the new routing took effect.

## Resolution

The Alertmanager Secret is named `kube-prometheus-alertmanager` and lives in the monitoring namespace (`cattle-monitoring-system`, `kube-system`, or whatever namespace the platform's monitoring stack was installed into — `kubectl get pod -A -l app.kubernetes.io/name=alertmanager` will identify it). The data key holding the YAML is `alertmanager.yaml`.

### 1. Extract the current configuration

```bash
NS=<monitoring-namespace>
kubectl -n "$NS" get secret kube-prometheus-alertmanager \
  -o jsonpath='{.data.alertmanager\.yaml}' | base64 -d > alertmanager.yaml
```

A starter config looks like:

```yaml
global:
  resolve_timeout: 5m
route:
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  receiver: default
  routes:
    - match:
        alertname: Watchdog
      repeat_interval: 5m
      receiver: watchdog
receivers:
  - name: default
  - name: watchdog
```

`Watchdog` (sometimes named `DeadMansSwitch` in older bundles) is the always-firing health alert; keep its dedicated short-interval route in place.

### 2. Modify `alertmanager.yaml`

Add a global SMTP block, a new receiver, and a `match` route that pins a label to it. The shape is upstream Alertmanager — see `https://prometheus.io/docs/alerting/latest/configuration/`:

```yaml
global:
  resolve_timeout: 5m
  smtp_from: alerts@example.com
  smtp_smarthost: smtp.example.com:587
  smtp_auth_username: alerts@example.com
  smtp_auth_password: <password>
route:
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  receiver: default
  routes:
    - match:
        alertname: Watchdog
      repeat_interval: 5m
      receiver: watchdog
    - match:
        service: payments
      routes:
        - match:
            severity: critical
          receiver: payments-pager
receivers:
  - name: default
  - name: watchdog
  - name: payments-pager
    email_configs:
      - to: payments-oncall@example.com
```

Keep secrets (SMTP password, webhook tokens) out of the on-disk file when committing it to git — most teams reference an external Secret via Alertmanager's `*_file` fields and mount that Secret into the Alertmanager StatefulSet.

### 3. Apply the change

The supported pattern is a `create … --dry-run -o yaml | replace` round-trip — it preserves the Secret's metadata while rewriting only the `alertmanager.yaml` key:

```bash
kubectl -n "$NS" create secret generic kube-prometheus-alertmanager \
  --from-file=alertmanager.yaml --dry-run=client -o yaml |
  kubectl -n "$NS" replace -f -
```

Alertmanager watches the mounted Secret and reloads automatically; an explicit pod restart is rarely required and not recommended (it interrupts the alert dedup state). If the reload does not take, force one:

```bash
kubectl -n "$NS" rollout restart statefulset kube-prometheus-alertmanager
```

### 4. Verify

Confirm Alertmanager parsed the new file and the routes are visible from its API:

```bash
kubectl -n "$NS" port-forward svc/kube-prometheus-alertmanager 9093:9093 &
curl -s http://localhost:9093/api/v2/status | jq '.config.original' | head
curl -s http://localhost:9093/api/v2/receivers | jq
```

The first call echoes the YAML Alertmanager loaded; the second lists every parsed receiver name. Either of these failing to include your new receiver indicates the Secret was rewritten but a syntax error sent Alertmanager back to the previous good config — check the pod logs (`kubectl -n "$NS" logs sts/kube-prometheus-alertmanager -c alertmanager`) for the `couldn't load configuration` line.

### 5. Test routing without waiting for a real alert

Use `amtool` (shipped in the Alertmanager image) or the `/api/v2/alerts` endpoint to inject a synthetic alert with the labels that should hit your new route:

```bash
curl -s -XPOST http://localhost:9093/api/v2/alerts -d '[
  {
    "labels": {
      "alertname": "TestPaymentsCritical",
      "service": "payments",
      "severity": "critical"
    },
    "annotations": {
      "summary": "Synthetic test of payments-pager receiver"
    }
  }
]'
```

The notification should reach the configured destination; if not, the receiver block is wrong, not the routing.

## Diagnostic Steps

1. Confirm which namespace and Secret hold the live Alertmanager config — never assume the default name when the platform's monitoring add-on was deployed via Helm or via a custom CR:

   ```bash
   kubectl get secret -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}' \
     | grep -i alertmanager
   ```

2. If a `replace` returns `Secret … is invalid`, the change broke the immutable-key contract — the Operator owns specific keys. Re-extract, edit only `alertmanager.yaml`, and retry.

3. After a change, watch Alertmanager's reload log to confirm the new routes parsed:

   ```bash
   kubectl -n "$NS" logs sts/kube-prometheus-alertmanager -c alertmanager --tail=50 | grep -E 'reload|config'
   ```

   `Loading configuration file … completed` paired with the new file's mtime is the success signal; `couldn't load configuration` means the change did not take and Alertmanager is still serving the previous good config from memory.

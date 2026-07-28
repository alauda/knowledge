---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Sending the same alert to multiple Alertmanager receivers
## Issue

Alertmanager has been configured with several routes that all match the same `severity: critical` label (for example one route to a pager, one route to email), but alerts are only delivered to the first matching receiver — the rest of the routes appear to be ignored. Operators typically report it as "Alertmanager is not sending the critical alerts" or "only the first route fires".

## Root Cause

Alertmanager evaluates routes in order and, by default, stops at the first match. The `continue` attribute on a route controls this: when `continue` is `false` (the default), no sibling route below the matching one is evaluated for that alert. To deliver the same alert to more than one receiver, every matching route except the last must have `continue: true`.

## Resolution

On ACP the alerting stack is part of the observability component — specifically the Prometheus Operator based monitoring platform in `observability/monitor`. The Alertmanager configuration is stored in the `kube-prometheus-alertmanager` secret inside the observability namespace, and the routing tree in that secret is what needs the `continue` flag set.

The snippet below shows a two-receiver configuration that delivers every `severity: critical` alert to both the paging receiver and the SMTP receiver:

```yaml
route:
  routes:
    - match:
        severity: critical
      receiver: Critical
      continue: true          # fan out to the next matching sibling
    - match:
        severity: critical
      receiver: smtp

receivers:
  - name: Critical
  - name: smtp
    email_configs:
      - to: smtp@example.com
        from: smtp@example.com
        smarthost: 'example.com'
        hello: example.com
        require_tls: false
```

Apply the updated configuration by re-creating the `kube-prometheus-alertmanager` secret in place. Save the edited YAML as `alertmanager.yaml` locally, then:

```bash
kubectl -n cpaas-system create secret generic kube-prometheus-alertmanager \
  --from-file=alertmanager.yaml \
  --dry-run=client -o yaml \
  | kubectl -n cpaas-system replace secret --filename=-
```

The Alertmanager pods pick up the new configuration automatically within a few seconds — no pod restart is required. Confirm the reload by fetching `/api/v1/status` from the Alertmanager port-forward and looking at the `config.original` field, which echoes back the YAML that Alertmanager has actually loaded.

If you manage monitoring via a higher-level CR (for example a platform configuration object that renders the secret), make the `continue: true` change in the source-of-truth object instead of editing the secret by hand; otherwise the next reconcile will revert it.

## Diagnostic Steps

Read back the current Alertmanager configuration and confirm whether `continue: true` is already present on the routes that need it:

```bash
kubectl -n cpaas-system get secret kube-prometheus-alertmanager \
  --template='{{ index .data "alertmanager.yaml" }}' \
  | base64 -d
```

```bash
kubectl -n cpaas-system get secret kube-prometheus-alertmanager \
  --template='{{ index .data "alertmanager.yaml" }}' \
  | base64 -d | grep -E 'continue|receiver:|match:'
```

An absence of `continue:` lines on sibling routes with the same match criteria is the usual smoking gun.

Check Alertmanager's own logs for delivery errors — a silent receiver (SMTP smarthost refused, webhook 4xx) can look the same as "the route did not fire":

```bash
kubectl -n cpaas-system logs alertmanager-kube-prometheus-0
```

Finally, validate that the receivers referenced from the routes actually exist in the configuration. A typo in the receiver name causes the route to match but the notification to be dropped with an error in the Alertmanager log.

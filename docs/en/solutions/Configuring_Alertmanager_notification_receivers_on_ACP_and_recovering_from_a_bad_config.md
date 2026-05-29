---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Configuring Alertmanager notification receivers on ACP and recovering from a bad config

## Issue

On Alauda Container Platform, the monitoring stack runs Alertmanager as ordinary pods in the `cpaas-system` namespace, owned by the StatefulSet `alertmanager-kube-prometheus`, and the pods carry the label `app=alertmanager`. Administrators routing alerts to an external destination need a clear picture of the configuration document Alertmanager consumes, how to make a change take effect, and how to recognise a configuration that the binary rejects. The Alertmanager configuration document is structured with a `global` section, a `route` tree, and a `receivers` list, and each route's receiver must reference a name that is defined in `receivers`.

## Resolution

External notification targets are configured by adding an entry to the `receivers` list — for example an `email_configs` block alongside the `smtp_*` settings in `global` — and then routing matched alerts to that receiver through the `route` tree. The receiver name used by a route entry has to match a `name` declared in `receivers`, so a new target is defined as a `receivers[]` entry plus a `route.routes[]` match that selects it.

A configuration that follows this shape:

```yaml
global:
  smtp_smarthost: smtp.example.com:587
  smtp_from: alertmanager@example.com
route:
  receiver: default-receiver
  routes:
    - match:
        severity: High
      receiver: email-oncall
receivers:
  - name: default-receiver
  - name: email-oncall
    email_configs:
      - to: oncall@example.com
```

The configuration document Alertmanager consumes lives in the `cpaas-system` Secret `alertmanager-kube-prometheus`, under the `alertmanager.yaml` data key. A new configuration is applied by replacing that Secret's `alertmanager.yaml` contents with the edited document, then restarting the pods so the new process loads it. Restart by deleting the pods matching `app=alertmanager` in `cpaas-system`; the owning StatefulSet `alertmanager-kube-prometheus` recreates the deleted pod, and the recreated pod's process loads the replaced configuration. The Alertmanager container runs the image `registry.alauda.cn:60080/3rdparty/prometheus/alertmanager:v0.32.1-v4.3.4`, the upstream `prometheus/alertmanager` v0.32.1 binary.

```bash
kubectl delete pod -n cpaas-system -l app=alertmanager
```

## Diagnostic Steps

If the replaced configuration contains an error, the restarted pods fail to come up and enter `CrashLoopBackOff`: the `alertmanager` container exits with a configuration-load error at startup and the kubelet cycles it with a climbing restart count. A configuration load failure is surfaced in the `alertmanager` container log as an error line that names the offending field — for example, a route that references a receiver name not defined in `receivers` produces a load-failure line naming that undefined receiver.

Read the `alertmanager` container log to find the named field:

```bash
kubectl logs -n cpaas-system -l app=alertmanager -c alertmanager
```

The load-failure line is emitted at `level=ERROR` with the message `Loading configuration file failed` and an `err=` clause naming the undefined receiver referenced by the route.

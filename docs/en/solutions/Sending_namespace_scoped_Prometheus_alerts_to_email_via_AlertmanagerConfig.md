---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500021
---

# Sending namespace-scoped Prometheus alerts to email via AlertmanagerConfig
## Issue

A namespace owner has authored a `PrometheusRule` in their own namespace and the rule is firing — `kubectl get prometheusrule` shows the alert in `Firing` state and the user-workload Alertmanager web UI lists it. But the configured email recipient never sees a notification. The cluster's platform-side Alertmanager only forwards alerts whose routing tree has been wired up; alerts from a workload namespace need their own routing tree, exposed through the namespace-scoped `AlertmanagerConfig` CRD that the Prometheus operator stack supports for user-workload monitoring.

This article walks through enabling the user-workload monitoring path, granting the namespace owner permission to create AlertmanagerConfig objects, defining an email receiver inside the namespace, wiring up the PrometheusRule, and verifying the notification reaches the inbox.

## Resolution

### Step 1 — enable user-workload monitoring

The platform's monitoring CR exposes a flag that turns on a separate Prometheus + Alertmanager pipeline scoped to user namespaces. The exact ConfigMap name and key depend on the platform's monitoring operator; the typical shape is:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-monitoring-config
  namespace: cpaas-system
data:
  config.yaml: |
    enableUserWorkload: true
    alertmanagerMain: {}
    prometheusK8s: {}
```

Note: ACP's monitoring stack runs in `cpaas-system` (the platform's `kube-prometheus` chart). On clusters where the user-workload Prometheus is packaged differently, substitute the namespace and ConfigMap name accordingly — `kubectl get prometheus -A` lists the actual instances.

Apply, then confirm the user-workload Prometheus and Alertmanager StatefulSets are scheduled:

```bash
kubectl -n cpaas-user-workload-monitoring get statefulset
```

### Step 2 — enable namespace-scoped AlertmanagerConfig routing

The user-workload Alertmanager ignores namespace-scoped routing trees by default. Flip the `enableAlertmanagerConfig` flag in the user-workload config so the operator picks up `AlertmanagerConfig` objects from every user namespace:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: user-workload-monitoring-config
  namespace: cpaas-user-workload-monitoring
data:
  config.yaml: |
    alertmanager:
      enabled: true
      enableAlertmanagerConfig: true
```

After the rollout, the user-workload Alertmanager pod logs should include lines like `loaded AlertmanagerConfig <ns>/<name>` when a namespace-scoped config is created.

### Step 3 — grant the namespace owner permission

By default a workload-namespace user cannot manage AlertmanagerConfig in their namespace. Bind the upstream `monitoring-rules-edit` ClusterRole (or the platform's equivalent) to the user, scoped to the target namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: alice-monitoring-edit
  namespace: custom-alert
subjects:
  - kind: User
    name: alice@example.com
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: monitoring-rules-edit
  apiGroup: rbac.authorization.k8s.io
```

Verify:

```bash
kubectl --as alice@example.com -n custom-alert auth can-i create alertmanagerconfig.monitoring.coreos.com
kubectl --as alice@example.com -n custom-alert auth can-i create prometheusrule.monitoring.coreos.com
```

Both should return `yes`.

### Step 4 — author the AlertmanagerConfig

Hold the SMTP password in a Secret in the same namespace; never inline it into the AlertmanagerConfig YAML:

```bash
kubectl create namespace custom-alert
kubectl -n custom-alert create secret generic smtp-password \
  --from-literal=password="<the-smtp-account-password>"
```

Define the AlertmanagerConfig with one email receiver and one route that funnels every alert from this namespace into it:

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: custom-alert
  namespace: custom-alert
spec:
  route:
    groupBy: ["job"]
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 12h
    receiver: email_receiver
  receivers:
    - name: email_receiver
      emailConfigs:
        - to: ops-oncall@example.com
          from: alertmanager@example.com
          smarthost: smtp.example.com:587
          authUsername: alertmanager@example.com
          authPassword:
            name: smtp-password
            key: password
          requireTLS: true
```

Apply it:

```bash
kubectl apply -f custom-alert.yaml
```

Notes on field semantics:

- `route.receiver` must reference a `receivers[].name` defined in the same AlertmanagerConfig — cross-namespace receivers are not allowed.
- The user-workload Alertmanager's wrapper route silently prefixes a namespace-equality matcher, so this AlertmanagerConfig only sees alerts whose `namespace` label equals `custom-alert`. Cross-namespace forwarding requires the platform admin to edit the top-level Alertmanager configuration, not a workload AlertmanagerConfig.
- `requireTLS: true` enforces STARTTLS — leave it off only for SMTP relays that explicitly do not support it (most cloud SMTP services do).

### Step 5 — author the PrometheusRule

A trivial always-firing rule is the easiest way to validate the wiring:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: prometheus-example-rules
  namespace: custom-alert
spec:
  groups:
    - name: example.rules
      rules:
        - alert: ExampleAlert
          expr: vector(1)
          labels:
            severity: warning
          annotations:
            summary: probe alert that always fires
```

Apply it. The user-workload Prometheus picks up the rule within ~30 seconds, sends it to the user-workload Alertmanager, and the AlertmanagerConfig route forwards it to the email receiver.

### Step 6 — verify

Watch the alert state transition:

```bash
kubectl -n custom-alert get prometheusrule
kubectl -n cpaas-user-workload-monitoring exec -it sts/alertmanager-user-workload -- \
  amtool --alertmanager.url=http://localhost:9093 alert query | grep ExampleAlert
```

The alert should appear in `firing` state. Then check the inbox configured under `to:` — a message subject like `[FIRING:1] (ExampleAlert custom-alert)` should arrive within `groupWait` (30 s in the example).

## Diagnostic Steps

If the alert is firing in Prometheus but the email never arrives, walk the chain.

**Confirm the Alertmanager loaded the AlertmanagerConfig:**

```bash
kubectl -n cpaas-user-workload-monitoring logs sts/alertmanager-user-workload --tail=200 \
  | grep -E 'loaded AlertmanagerConfig|invalid'
```

A `loaded AlertmanagerConfig custom-alert/custom-alert` line confirms the config compiled. An `invalid` or `unmarshal` error points at a YAML or schema problem (most often a typo in the SMTP fields).

**Confirm the alert reached the user-workload Alertmanager:**

```bash
kubectl -n cpaas-user-workload-monitoring port-forward sts/alertmanager-user-workload 9093:9093 &
amtool --alertmanager.url=http://localhost:9093 alert query
amtool --alertmanager.url=http://localhost:9093 silence query
```

If the alert is missing here, the user-workload Prometheus is not forwarding to the user-workload Alertmanager — re-check `enableUserWorkload: true` and the existence of the user-workload Alertmanager StatefulSet.

**Test SMTP independently of Alertmanager:**

A direct `swaks` test from the cluster confirms SMTP credentials and TLS work without involving Alertmanager. Run from a debug pod that has `swaks` installed:

```bash
swaks --to ops-oncall@example.com \
      --from alertmanager@example.com \
      --server smtp.example.com:587 \
      --auth LOGIN --auth-user alertmanager@example.com \
      --auth-password "$(kubectl -n custom-alert get secret smtp-password \
                          -o jsonpath='{.data.password}' | base64 -d)" \
      --tls
```

A successful run delivers a test message immediately. Failures surface as one of the well-known SMTP error codes (5xx authentication failure, 4xx greylist, etc.) and identify whether the credentials, the TLS path, or the relay itself is at fault.

**If the receiver fails silently with `email-config: TLS handshake failed`:**

Check whether the SMTP server expects implicit TLS (port 465) instead of STARTTLS (port 587). Switch the `smarthost` port and set `requireTLS: false` if the server uses implicit TLS — the receiver opens a TLS connection from the start instead of upgrading.

**If the AlertmanagerConfig is not picked up after edits:**

The user-workload Alertmanager re-loads on each generation change; if it is stuck, restart the StatefulSet:

```bash
kubectl -n cpaas-user-workload-monitoring rollout restart statefulset/alertmanager-user-workload
```

Confirm with `kubectl logs` that the new pod loads the latest AlertmanagerConfig generation.

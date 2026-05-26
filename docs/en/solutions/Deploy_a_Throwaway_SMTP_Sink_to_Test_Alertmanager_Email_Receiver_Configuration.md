---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500028
---

# Deploy a Throwaway SMTP Sink to Test Alertmanager Email Receiver Configuration

## Issue

When wiring up an Alertmanager email receiver (`smtp_smarthost`, `smtp_auth_username`, `smtp_from`, `smtp_require_tls`, an `email_configs[]` entry on the receiver), the production delivery path runs through corporate relays, anti-spam filters, and TLS chains that may quarantine, silently drop, or rate-limit the test alert. A failed delivery in any of those layers makes it hard to tell whether the misconfiguration is in Alertmanager itself, in the relay, or in the recipient mailbox. A disposable in-cluster SMTP sink lets the operator verify the Alertmanager pipeline end-to-end before swapping the smarthost back to the production relay. The standard `alertmanager.yaml` schema — `global.smtp_*` settings plus per-receiver `email_configs[]` — is accepted verbatim by the platform Alertmanager binary [ev:c2_a].

On Alauda Container Platform the platform Alertmanager configuration lives in the Opaque Secret `cpaas-system/alertmanager-kube-prometheus`, single data key `alertmanager.yaml`; the Secret carries an operator-editable marker so raw patches survive chart reconciliation [ev:c3]. The default rendered configuration ships zero `smtp_*` globals and zero `email_configs[]` entries, so any email receiver capability is something the operator adds [ev:c2_a].

## Resolution

The flow has four steps: deploy a throwaway in-cluster SMTP sink that exposes the captured messages over HTTP, point the Alertmanager configuration's `smtp_smarthost` at the sink Service, push a test alert (either through a `PrometheusRule` that always fires or directly via the Alertmanager v2 API), and verify the rendered message landed on the sink. Each of the four steps is anchored end-to-end on the platform Alertmanager binary `alertmanager:v0.32.1-v4.3.4` shipped by `chart-kube-prometheus` v4.3.3 [ev:c2_a][ev:c3].

### Step 1 — Deploy a disposable SMTP sink in-cluster [ev:c2_b]

Run the sink as a single Pod fronted by a ClusterIP Service. The image must come from the in-cluster registry. The sink does two jobs: (1) accept SMTP on port 1025 and append each delivered message to a JSONL file; (2) serve the captured messages over HTTP on port 8025. A pure-busybox shape avoids any package install on the disposable workload [ev:c2_b].

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: sink-scripts
  namespace: alertmanager-smoke
data:
  smtp_handler.sh: |
    #!/bin/sh
    # SMTP responder invoked per-connection by busybox tcpsvd.
    # Talks 220 / 250 / 354 SMTP, appends one JSON line per delivered
    # message to /var/sink/messages.jsonl.
    LOG=/var/sink/messages.jsonl
    mkdir -p /var/sink
    printf '220 sink ESMTP ready\r\n'
    mode=cmd; mailfrom=""; rcpt=""; body=""
    while IFS= read -r raw; do
      line=$(printf '%s' "$raw" | tr -d '\r')
      if [ "$mode" = data ]; then
        if [ "$line" = "." ]; then
          subj=$(printf '%s' "$body" | awk '/^Subject:/{sub(/^Subject: */,""); print; exit}')
          from=$(printf '%s' "$body" | awk '/^From:/{sub(/^From: */,""); print; exit}')
          to=$(printf '%s' "$body" | awk '/^To:/{sub(/^To: */,""); print; exit}')
          NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
          # JSON escape via sed (busybox awk's escape semantics differ from gawk).
          esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\r' | sed ':a;N;$!ba;s/\n/\\n/g'; }
          printf '{"received_at":"%s","mailfrom":"%s","rcpttos":["%s"],"headers":{"From":"%s","To":"%s","Subject":"%s"},"body":"%s"}\n' \
            "$NOW" "$(esc "$mailfrom")" "$(esc "$rcpt")" "$(esc "$from")" "$(esc "$to")" "$(esc "$subj")" "$(esc "$body")" \
            >> "$LOG"
          printf '250 2.0.0 Ok: queued\r\n'
          mode=cmd; mailfrom=""; rcpt=""; body=""
          continue
        fi
        if [ -z "$body" ]; then body="$line"; else body="$body
    $line"; fi
        continue
      fi
      upper=$(printf '%s' "$line" | tr '[:lower:]' '[:upper:]')
      case "$upper" in
        EHLO*|HELO*) printf '250-sink Hello\r\n'; printf '250 HELP\r\n' ;;
        "MAIL FROM:"*) mailfrom=$(printf '%s' "$line" | sed -e 's/^[Mm][Aa][Ii][Ll] [Ff][Rr][Oo][Mm]: *//' -e 's/^<//' -e 's/>.*$//'); printf '250 2.1.0 OK\r\n' ;;
        "RCPT TO:"*)   rcpt=$(printf '%s' "$line"     | sed -e 's/^[Rr][Cc][Pp][Tt] [Tt][Oo]: *//'   -e 's/^<//' -e 's/>.*$//'); printf '250 2.1.5 OK\r\n' ;;
        DATA) printf '354 End data with <CR><LF>.<CR><LF>\r\n'; mode=data ;;
        QUIT) printf '221 2.0.0 Bye\r\n'; break ;;
        STARTTLS) printf '454 4.7.0 TLS not available\r\n' ;;
      esac
    done
  messages.cgi: |
    #!/bin/sh
    echo "Content-Type: application/json"; echo ""
    if [ -s /var/sink/messages.jsonl ]; then
      awk 'BEGIN{print "["} NR>1{print ","} {print} END{print "]"}' /var/sink/messages.jsonl
    else
      echo "[]"
    fi
  httpd.conf: |
    A:*
  entrypoint.sh: |
    #!/bin/sh
    set -e
    mkdir -p /var/sink /www/cgi-bin
    cp /scripts/messages.cgi /www/cgi-bin/messages
    chmod +x /www/cgi-bin/messages
    busybox tcpsvd -E -v 0.0.0.0 1025 /bin/sh /scripts/smtp_handler.sh 2>&1 | sed 's/^/[smtp] /' &
    exec busybox httpd -f -p 8025 -h /www -c /scripts/httpd.conf
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sink
  namespace: alertmanager-smoke
  labels: {app: sink}
spec:
  replicas: 1
  selector: {matchLabels: {app: sink}}
  template:
    metadata: {labels: {app: sink}}
    spec:
      containers:
        - name: sink
          image: registry.alauda.cn:60080/ops/alpine:3.23.3-alauda-202604121100
          command: ["/bin/sh", "/scripts/entrypoint.sh"]
          ports:
            - {name: smtp, containerPort: 1025}
            - {name: http, containerPort: 8025}
          volumeMounts:
            - {name: scripts, mountPath: /scripts}
      volumes:
        - name: scripts
          configMap: {name: sink-scripts, defaultMode: 0755}
---
apiVersion: v1
kind: Service
metadata:
  name: sink
  namespace: alertmanager-smoke
spec:
  selector: {app: sink}
  ports:
    - {name: smtp, port: 1025, targetPort: 1025}
    - {name: http, port: 8025, targetPort: 8025}
```

Apply and confirm the sink Pod reaches Running, then port-forward the HTTP port and confirm the messages list is empty (this is the baseline before any alert is dispatched) [ev:c2_b]:

```bash
kubectl create ns alertmanager-smoke
kubectl apply -n alertmanager-smoke -f sink.yaml
kubectl rollout status deploy/sink -n alertmanager-smoke --timeout=120s

kubectl -n alertmanager-smoke port-forward svc/sink 18025:8025 &
curl -s http://localhost:18025/cgi-bin/messages
# expected: []
```

### Step 2 — Point Alertmanager at the sink [ev:c3]

The platform Alertmanager configuration lives in the Opaque Secret `cpaas-system/alertmanager-kube-prometheus`, data key `alertmanager.yaml`. Decode the current Secret, add the SMTP globals and an `email_configs[]` entry to the receiver, then re-apply [ev:c3]. The `alertmanager.yaml` schema is the standard form — `global.smtp_smarthost / smtp_from / smtp_require_tls / smtp_hello` plus per-receiver `email_configs[]` with `to` / `require_tls` / `send_resolved` — accepted verbatim by the Alertmanager binary [ev:c2_a]:

```yaml
global:
  smtp_smarthost: 'sink.alertmanager-smoke.svc.cluster.local:1025'
  smtp_from: 'alerts@example.com'
  smtp_require_tls: false
  smtp_hello: 'alertmanager'

route:
  receiver: smoke
  group_wait: 5s
  group_interval: 10s
  repeat_interval: 1h

receivers:
  - name: smoke
    email_configs:
      - to: 'oncall@example.com'
        require_tls: false
        send_resolved: true
```

Patch the platform Secret with the new payload, then restart the Alertmanager Pod so the new process loads the updated configuration; Alertmanager logs `Loading configuration file` and `Completed loading of configuration file` on the new process [ev:c3][ev:c5_b]:

```bash
kubectl -n cpaas-system patch secret alertmanager-kube-prometheus \
  --type=merge \
  -p "{\"data\":{\"alertmanager.yaml\":\"$(base64 -w0 < alertmanager.yaml)\"}}"

kubectl -n cpaas-system delete pod alertmanager-kube-prometheus-0
kubectl -n cpaas-system rollout status statefulset/alertmanager-kube-prometheus --timeout=180s
```

### Step 3 — Drive a test alert [ev:c4][ev:c6]

Two paths work. The deterministic path is to push a single alert straight to Alertmanager's v2 API and observe the dispatcher select the configured receiver [ev:c6]. The chart-managed path is to create a `PrometheusRule` that always fires and let the live Prometheus instance scrape and forward it; the live Prometheus instance is reconciled and available, with the standard `monitoring.coreos.com/v1` `PrometheusRule` CRD on the cluster [ev:c4].

Direct v2 API path — port-forward the platform Alertmanager and POST a single alert. The `/api/v2/alerts` endpoint accepts the upstream v2 schema; the dispatcher selects the configured receiver and emits the email via the configured smarthost [ev:c6][ev:c2_b]:

```bash
kubectl -n cpaas-system port-forward pod/alertmanager-kube-prometheus-0 19093:9093 &
curl -s -XPOST -H 'Content-Type: application/json' \
  http://localhost:19093/api/v2/alerts \
  -d '[{"labels":{"alertname":"SmoketestAlert","severity":"info","job":"smoke"},
       "annotations":{"summary":"Alertmanager email path smoke test",
                      "description":"throwaway smoke test against in-cluster sink"},
       "generatorURL":"http://example/smoke"}]'

# wait ~10s for the group_wait + group_interval window, then read back:
curl -s http://localhost:19093/api/v2/alerts \
  | python3 -c "import sys,json; a=json.load(sys.stdin); print([(x['labels']['alertname'], x.get('receivers'), x['status']['state']) for x in a])"
# expected: [('SmoketestAlert', [{'name': 'smoke'}], 'active')]
```

Chart-managed path — create a `PrometheusRule` with `expr: vector(1)` and `for: 0m`; the rule fires immediately, the live Prometheus instance in `cpaas-system` (`prometheus-kube-prometheus-0-0`) scrapes the rule, and within one or two scrape intervals the alert reaches Alertmanager which then dispatches via the configured email receiver [ev:c4]:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: smoketest-always-firing
  namespace: cpaas-system
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
            description: This alert always fires; safe to ignore once seen on the sink.
```

### Step 4 — Verify the message landed [ev:c5_a]

Port-forward the sink's HTTP port and read the captured messages through the sink's CGI endpoint. After a successful dispatch the captured record carries `mailfrom` equal to the configured `smtp_from`, `rcpttos` equal to the configured `email_configs[].to`, and a rendered Alertmanager body with a `[FIRING:N]  (<alertname> <labels>)` Subject and the standard `multipart/alternative` HTML body [ev:c5_a]:

```bash
kubectl -n alertmanager-smoke port-forward svc/sink 18025:8025 &
curl -s http://localhost:18025/cgi-bin/messages \
  | python3 -c "import sys,json; m=json.load(sys.stdin); print('count:',len(m)); print('headers:',m[0]['headers']); print('body_len:',len(m[0]['body']))"
# count: 1
# headers: {'From': 'alerts@example.com', 'To': 'oncall@example.com',
#           'Subject': '[FIRING:1]  (SmoketestAlert smoke info)', ...}
# body_len: ~9800 (rendered Alertmanager multipart/alternative)
```

### Step 5 — Cleanup [ev:c3]

Once the smoke test passes, switch `smtp_smarthost` back to the production relay (and `smtp_require_tls: true` if the production path enforces it) by patching the same operator-editable Secret `cpaas-system/alertmanager-kube-prometheus`, drop the `PrometheusRule`, and delete the disposable namespace [ev:c3]:

```bash
kubectl delete prometheusrule smoketest-always-firing -n cpaas-system
kubectl delete ns alertmanager-smoke
```

## Diagnostic Steps

If the captured-messages list stays empty after the test alert is dispatched, the failure is in the Alertmanager-to-sink path; the Alertmanager container log is the diagnostic surface — the `alertmanager` binary writes config-load lines on startup (`Starting Alertmanager version=0.32.1`, `Loading configuration file`, `Completed loading of configuration file`, `Listening on [::]:9093`) and SMTP-delivery error lines (dial / TLS / authentication failures) on the failure path. The success path is quiet on this version, so the absence of error lines combined with a non-empty sink is the green-light signal [ev:c5_b].

```bash
# Read the Alertmanager binary log directly (the alertmanager / config-reloader
# / proxy containers in this Pod are scratch images — no shell, no wget/curl
# inside the Pod; read the log from outside).
kubectl -n cpaas-system logs alertmanager-kube-prometheus-0 -c alertmanager --tail=200 \
  | grep -iE 'notify|smtp|email|integration|error|fail|connection refused' \
  | tail -20
```

Confirm the dispatcher selected the email receiver by reading `/api/v2/alerts` after the trigger; `receivers` should list the receiver name configured in `alertmanager.yaml` and the alert `state` should be `active` [ev:c6]:

```bash
kubectl -n cpaas-system port-forward pod/alertmanager-kube-prometheus-0 19093:9093 &
curl -s http://localhost:19093/api/v2/alerts | python3 -m json.tool
```

If the sink's HTTP endpoint returns `[]` but `/api/v2/alerts` shows the alert with the correct receiver, the SMTP TCP path itself is the culprit — DNS resolution of the sink Service name, NetworkPolicy on the namespace, or the sink Pod not Running. On Alauda Container Platform with `chart-kube-prometheus` v4.3.3 and `alertmanager:v0.32.1-v4.3.4`, the live Prometheus + Alertmanager surface accepts both the direct `/api/v2/alerts` POST and the `PrometheusRule` scrape-and-forward path verbatim, so the test is reproducible end-to-end against the platform pod [ev:c4][ev:c6].

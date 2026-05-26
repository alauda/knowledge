---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500028
sourceSHA: 0ae66ab61b00df995e339609e1915b6a71a5ab9bf596e997dc934fba2c6faa0b
---

# 部署一个临时 SMTP 接收器以测试 Alertmanager 邮件接收器配置

## 问题

在配置 Alertmanager 邮件接收器（`smtp_smarthost`、`smtp_auth_username`、`smtp_from`、`smtp_require_tls`、接收器上的 `email_configs[]` 条目）时，生产交付路径会经过公司中继、反垃圾邮件过滤器和 TLS 链，这可能会隔离、静默丢弃或限速测试告警。在这些层中的任何一个交付失败都很难判断配置错误是在 Alertmanager 本身、在中继，还是在收件人邮箱中。一个一次性集群内 SMTP 接收器可以让操作员在将 smarthost 切换回生产中继之前验证 Alertmanager 管道的端到端功能。标准的 `alertmanager.yaml` 架构——`global.smtp_*` 设置加上每个接收器的 `email_configs[]`——被平台 Alertmanager 二进制文件逐字接受 \[ev:c2_a]。

在 Alauda 容器平台上，平台 Alertmanager 配置存储在 Opaque Secret `cpaas-system/alertmanager-kube-prometheus` 中，单个数据键为 `alertmanager.yaml`；该 Secret 带有一个操作员可编辑的标记，以便原始补丁在图表协调中得以保留 \[ev:c3]。默认渲染的配置没有任何 `smtp_*` 全局设置和 `email_configs[]` 条目，因此任何邮件接收器功能都是操作员添加的 \[ev:c2_a]。

## 解决方案

该流程分为四个步骤：部署一个临时的集群内 SMTP 接收器，通过 HTTP 暴露捕获的消息，将 Alertmanager 配置的 `smtp_smarthost` 指向接收器服务，推送一个测试告警（可以通过一个始终触发的 `PrometheusRule` 或直接通过 Alertmanager v2 API），并验证渲染的消息是否到达接收器。四个步骤的每一步都与平台 Alertmanager 二进制文件 `alertmanager:v0.32.1-v4.3.4` 端到端锚定，由 `chart-kube-prometheus` v4.3.3 提供 \[ev:c2_a]\[ev:c3]。

### 步骤 1 — 在集群中部署一个一次性 SMTP 接收器 \[ev:c2_b]

将接收器作为一个单独的 Pod 运行，并由一个 ClusterIP 服务前端。镜像必须来自集群内注册表。接收器完成两个任务：（1）在 1025 端口接受 SMTP，并将每个传递的消息附加到 JSONL 文件中；（2）在 8025 端口通过 HTTP 提供捕获的消息。一个纯 busybox 形状避免了在一次性工作负载上安装任何包 \[ev:c2_b]。

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: sink-scripts
  namespace: alertmanager-smoke
data:
  smtp_handler.sh: |
    #!/bin/sh
    # SMTP 响应器由 busybox tcpsvd 每个连接调用。
    # 处理 220 / 250 / 354 SMTP，将每个传递的消息附加到 /var/sink/messages.jsonl。
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
          # 通过 sed 进行 JSON 转义（busybox awk 的转义语义与 gawk 不同）。
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

应用并确认接收器 Pod 达到运行状态，然后端口转发 HTTP 端口并确认消息列表为空（这是在任何告警被分发之前的基线） \[ev:c2_b]:

```bash
kubectl create ns alertmanager-smoke
kubectl apply -n alertmanager-smoke -f sink.yaml
kubectl rollout status deploy/sink -n alertmanager-smoke --timeout=120s

kubectl -n alertmanager-smoke port-forward svc/sink 18025:8025 &
curl -s http://localhost:18025/cgi-bin/messages
# 预期: []
```

### 步骤 2 — 将 Alertmanager 指向接收器 \[ev:c3]

平台 Alertmanager 配置存储在 Opaque Secret `cpaas-system/alertmanager-kube-prometheus` 中，数据键为 `alertmanager.yaml`。解码当前 Secret，添加 SMTP 全局设置和接收器的 `email_configs[]` 条目，然后重新应用 \[ev:c3]。`alertmanager.yaml` 架构是标准形式——`global.smtp_smarthost / smtp_from / smtp_require_tls / smtp_hello` 加上每个接收器的 `email_configs[]`，其中包含 `to` / `require_tls` / `send_resolved`——被 Alertmanager 二进制文件逐字接受 \[ev:c2_a]:

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

用新负载修补平台 Secret，然后重启 Alertmanager Pod，以便新进程加载更新的配置；Alertmanager 日志中会显示 `Loading configuration file` 和 `Completed loading of configuration file` \[ev:c3]\[ev:c5_b]:

```bash
kubectl -n cpaas-system patch secret alertmanager-kube-prometheus \
  --type=merge \
  -p "{\"data\":{\"alertmanager.yaml\":\"$(base64 -w0 < alertmanager.yaml)\"}}"

kubectl -n cpaas-system delete pod alertmanager-kube-prometheus-0
kubectl -n cpaas-system rollout status statefulset/alertmanager-kube-prometheus --timeout=180s
```

### 步骤 3 — 触发一个测试告警 \[ev:c4]\[ev:c6]

有两条路径可行。确定性路径是直接将单个告警推送到 Alertmanager 的 v2 API，并观察调度程序选择配置的接收器 \[ev:c6]。图表管理路径是创建一个始终触发的 `PrometheusRule`，让实时 Prometheus 实例抓取并转发；实时 Prometheus 实例已协调并可用，集群上有标准的 `monitoring.coreos.com/v1` `PrometheusRule` CRD \[ev:c4]。

直接 v2 API 路径——端口转发平台 Alertmanager 并 POST 一个单一告警。`/api/v2/alerts` 端点接受上游 v2 架构；调度程序选择配置的接收器并通过配置的 smarthost 发送邮件 \[ev:c6]\[ev:c2_b]:

```bash
kubectl -n cpaas-system port-forward pod/alertmanager-kube-prometheus-0 19093:9093 &
curl -s -XPOST -H 'Content-Type: application/json' \
  http://localhost:19093/api/v2/alerts \
  -d '[{"labels":{"alertname":"SmoketestAlert","severity":"info","job":"smoke"},
       "annotations":{"summary":"Alertmanager email path smoke test",
                      "description":"throwaway smoke test against in-cluster sink"},
       "generatorURL":"http://example/smoke"}]'

# 等待 ~10s 以便 group_wait + group_interval 窗口，然后读取：
curl -s http://localhost:19093/api/v2/alerts \
  | python3 -c "import sys,json; a=json.load(sys.stdin); print([(x['labels']['alertname'], x.get('receivers'), x['status']['state']) for x in a])"
# 预期: [('SmoketestAlert', [{'name': 'smoke'}], 'active')]
```

图表管理路径——创建一个 `PrometheusRule`，其 `expr: vector(1)` 和 `for: 0m`；该规则立即触发，位于 `cpaas-system` 的实时 Prometheus 实例（`prometheus-kube-prometheus-0-0`）抓取该规则，并在一到两个抓取间隔内，告警到达 Alertmanager，然后通过配置的邮件接收器进行调度 \[ev:c4]:

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

### 步骤 4 — 验证消息是否到达 \[ev:c5_a]

端口转发接收器的 HTTP 端口，并通过接收器的 CGI 端点读取捕获的消息。在成功调度后，捕获的记录将携带 `mailfrom` 等于配置的 `smtp_from`，`rcpttos` 等于配置的 `email_configs[].to`，以及带有 `[FIRING:N]  (<alertname> <labels>)` 主题和标准 `multipart/alternative` HTML 正文的渲染 Alertmanager 正文 \[ev:c5_a]:

```bash
kubectl -n alertmanager-smoke port-forward svc/sink 18025:8025 &
curl -s http://localhost:18025/cgi-bin/messages \
  | python3 -c "import sys,json; m=json.load(sys.stdin); print('count:',len(m)); print('headers:',m[0]['headers']); print('body_len:',len(m[0]['body']))"
# count: 1
# headers: {'From': 'alerts@example.com', 'To': 'oncall@example.com',
#           'Subject': '[FIRING:1]  (SmoketestAlert smoke info)', ...}
# body_len: ~9800 (rendered Alertmanager multipart/alternative)
```

### 步骤 5 — 清理 \[ev:c3]

一旦烟雾测试通过，将 `smtp_smarthost` 切换回生产中继（如果生产路径强制执行，则将 `smtp_require_tls` 设置为 true），通过修补相同的操作员可编辑 Secret `cpaas-system/alertmanager-kube-prometheus`，删除 `PrometheusRule`，并删除一次性命名空间 \[ev:c3]:

```bash
kubectl delete prometheusrule smoketest-always-firing -n cpaas-system
kubectl delete ns alertmanager-smoke
```

## 诊断步骤

如果在测试告警分发后捕获的消息列表仍然为空，则故障发生在 Alertmanager 到接收器的路径；Alertmanager 容器日志是诊断表面——`alertmanager` 二进制文件在启动时写入配置加载行（`Starting Alertmanager version=0.32.1`、`Loading configuration file`、`Completed loading of configuration file`、`Listening on [::]:9093`）和在故障路径上的 SMTP 交付错误行（拨号 / TLS / 身份验证失败）。在此版本中，成功路径是安静的，因此没有错误行的存在结合非空接收器是绿色信号 \[ev:c5_b]。

```bash
# 直接读取 Alertmanager 二进制日志（alertmanager / config-reloader
# / proxy 容器在此 Pod 中是 scratch 镜像——没有 shell，没有 wget/curl
# 在 Pod 内；从外部读取日志）。
kubectl -n cpaas-system logs alertmanager-kube-prometheus-0 -c alertmanager --tail=200 \
  | grep -iE 'notify|smtp|email|integration|error|fail|connection refused' \
  | tail -20
```

通过在触发后读取 `/api/v2/alerts` 确认调度程序选择了邮件接收器；`receivers` 应该列出在 `alertmanager.yaml` 中配置的接收器名称，告警 `state` 应为 `active` \[ev:c6]:

```bash
kubectl -n cpaas-system port-forward pod/alertmanager-kube-prometheus-0 19093:9093 &
curl -s http://localhost:19093/api/v2/alerts | python3 -m json.tool
```

如果接收器的 HTTP 端点返回 `[]`，但 `/api/v2/alerts` 显示告警及其正确接收器，则 SMTP TCP 路径本身是罪魁祸首——接收器服务名称的 DNS 解析、命名空间上的 NetworkPolicy，或接收器 Pod 未运行。在 Alauda 容器平台上，使用 `chart-kube-prometheus` v4.3.3 和 `alertmanager:v0.32.1-v4.3.4`，实时 Prometheus + Alertmanager 表面接受直接的 `/api/v2/alerts` POST 和 `PrometheusRule` 抓取和转发路径逐字，因此测试可以在平台 Pod 上端到端重现 \[ev:c4]\[ev:c6].

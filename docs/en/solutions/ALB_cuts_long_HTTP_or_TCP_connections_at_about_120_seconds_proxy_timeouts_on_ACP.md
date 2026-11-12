---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.10.x
  - 3.12.x
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# ALB cuts long HTTP or TCP connections at about 120 seconds: proxy timeouts on ACP

Related articles: [Finding which hop cuts a request through ALB on ACP: truncated large responses, 60-second cuts, 504 and SSE bursts](Finding_which_hop_cuts_a_request_through_ALB_on_ACP_truncated_large_responses_60_second_cuts_504_and_SSE_bursts.md); [ALB nginx settings are reverted after a restart or upgrade; change them through the overwrite ConfigMap on ACP](ALB_nginx_settings_are_reverted_after_a_restart_or_upgrade_change_them_through_the_overwrite_ConfigMap_on_ACP.md).

## Issue

A call through an Alauda Load Balancer (ALB) is cut off at about two minutes, while the same call inside the cluster succeeds. Typical reports:

- A long HTTP API call, a long-running task or a large-model call (streaming or not) through the ALB entry times out after about 2 minutes; the same call to the Service, the Pod or a NodePort returns after more than 2 minutes. A task that passes in a test environment times out in production.
- A frontend or rule timeout field (`spec.config.timeout`) is saved and then ignored.
- A database or other TCP service behind an ALB port drops connections after about two minutes, with `curl: (56) Recv failure: Connection reset by peer` or `curl: (8) Weird server reply` against the ALB port. The ALB `nginx` log shows `connection timed out (110: Operation timed out) while proxying connection, client: ..., server: 0.0.0.0:<alb-port>, upstream: "<pod-ip>:<port>"`, with a session time of about `120.001`.
- A TCP load test of a model service gets about half as many successful requests through the ALB as against the Pod.
- Someone asks whether `nginx.ingress.kubernetes.io/proxy-connect-timeout`, `proxy-send-timeout` and `proxy-read-timeout` apply to ALB and to an individual Ingress, or has set them and sees no change.

The usual request is to raise the timeouts to 600 seconds (10 minutes), or longer for slow generation.

## Root Cause

`proxy_read_timeout` in nginx is an idle timer: it restarts whenever the upstream sends a byte, and it is not a cap measured from the TCP handshake. `proxy_send_timeout` is the idle timer in the other direction, and `proxy_connect_timeout` bounds only the TCP handshake to the upstream. ALB long connections behave the same: the timeout is counted from the last communication, not from connection creation. A handler that stays silent until the final body therefore looks exactly like a timer that started at connect time; a handler that streams tokens does not, as long as each gap stays inside the idle limit.

### Cause 1: the ALB HTTP idle timers are still at the default 120 seconds

The ConfigMap with the same name as the ALB in `cpaas-system` shows the defaults:

```nginx
proxy_connect_timeout 5s;
proxy_send_timeout 120s;
proxy_read_timeout 120s;
proxy_buffering off;
keepalive_timeout 65;
proxy_next_upstream_tries 5;
```

Long-running calls, including large-model generation, that are silent for longer than 120 seconds are cut. An external load balancer in front of the ALB can also be the hop that closes first; its timer must be higher than the ALB timer or the client still dies at the outer limit.

### Cause 2: per-frontend or per-rule timeout fields are not honored on the running version

The Frontend and Rule fields `spec.config.timeout.proxy_connect_timeout_ms`, `proxy_read_timeout_ms` and `proxy_send_timeout_ms` are not supported by ALB on ACP 4.0.2: they can be saved, but the running proxy does not change. They are supported from the 4.0.4 patch release, and ALB on 4.3.2 supports them on a single forwarding rule. The ALB image moves with the platform and cannot be upgraded on its own. On a version without the fields, only the ALB-wide timeout can be changed; each ALB still has its own configuration, so two ALBs can have different values.

### Cause 3: TCP or UDP listeners are cut by the stream proxy_timeout

The ALB keeps separate timeouts for HTTP and for TCP/UDP forwarding, both 2 minutes by default. In the nginx stream configuration the idle timer is `proxy_timeout` in the `stream-tcp` and `stream-udp` sections. Raising the HTTP `proxy_*_timeout` values does not change it. A TCP port (for example a StarRocks query port forwarded to the FE Pod port 9030) drops connections after 120 seconds even when users estimate "about one minute"; the ALB log value decides. A long HTTP API published through an ALB TCP port is cut at 2 minutes even when the `http` block timeout is above 3 minutes, because `stream-tcp` still has `proxy_timeout 120s`. A TCP load test whose P99 latency (for example about 252 seconds) exceeds `proxy_timeout 120s` loses about half its requests.

### Cause 4: the nginx.ingress.kubernetes.io proxy timeout annotations on an Ingress

The annotations `nginx.ingress.kubernetes.io/proxy-connect-timeout`, `proxy-send-timeout` and `proxy-read-timeout` can be applied to ALB and to an individual Ingress; they correspond to the `proxy_*_timeout_ms` fields. Adding or removing them affects only that Ingress.

On ACP 3.12 and 3.18, however, the ALB Ingress did not support these annotations: with them already set, the rendered ALB configuration did not change. On those versions, use the ALB-wide overwrite (Cause 1).

## Resolution

### Cause 1: the ALB HTTP idle timers are still at the default 120 seconds

Decide the idle budget the application needs (600 seconds is the usual request), apply it on the ALB, then raise every device in front of the ALB so that the outer timer is strictly larger.

- **ACP 4.0.4 and later**: set milliseconds on the Frontend (`frontends.crd.alauda.io`, `crd.alauda.io/v1`, usually named `<alb-name>-<port>`) or on the Rule. 600000 ms is 10 minutes. The change is applied through Lua; nginx does not reload.

  ```yaml
  apiVersion: crd.alauda.io/v1
  kind: Frontend
  metadata:
    name: <alb-name>-<port>
    namespace: cpaas-system
  spec:
    config:
      timeout:
        proxy_connect_timeout_ms: 600000
        proxy_read_timeout_ms: 600000
        proxy_send_timeout_ms: 600000
  ```

  ```bash
  kubectl -n cpaas-system patch frontend <alb-name>-<port> --type merge -p '{"spec":{"config":{"timeout":{"proxy_read_timeout_ms":600000,"proxy_send_timeout_ms":600000}}}}'
  ```

- **ACP 3.10 to 3.18, or when one value for the whole ALB is acceptable**: set the directives in the `http_server` section of the ALB overwrite ConfigMap (setup in the related article on the overwrite ConfigMap), keep the indentation of the copied block, and trigger the `alb2` update. `proxy_connect_timeout` can stay at `5s`.

  ```yaml
  data:
    http_server: |2
      # keep the existing lines of the copied block, and change or add:
      proxy_send_timeout 600s;
      proxy_read_timeout 600s;
  ```

  ```bash
  kubectl -n cpaas-system annotate alb2 <alb-name> force-reload="$(date +%s)" --overwrite
  kubectl -n cpaas-system exec <alb-pod> -c nginx -- sh -c 'grep -R -n -E "proxy_(connect|send|read)_timeout" /alb/tweak | head'
  ```

  > **Warning:** These directives apply to every frontend on this ALB, and idle connections are held for the new duration, consuming connections, file descriptors and memory. Export the overwrite ConfigMap before editing. To roll back, restore the previous `proxy_*_timeout` values and trigger another `force-reload`.

There is no separate connection-lifetime setting; lengthen the idle timers if the goal is "count from the last byte".

### Cause 2: per-frontend or per-rule timeout fields are not honored on the running version

1. Read the running ALB image and the platform version. On a version without the fields, stop retrying them.
2. Either upgrade the platform to a version that supports them (4.0.4 or later) and then use the Frontend or Rule fields, or set one ALB-wide value in the overwrite ConfigMap (Cause 1) until then.

   > **Warning:** A platform upgrade restarts the ALB and other platform components. Do it in a maintenance window, export the `alb2` and the overwrite ConfigMap first, and keep the previous version available as the rollback. Do not pull a newer `alb-nginx` image into the cluster by hand.

### Cause 3: TCP or UDP listeners are cut by the stream proxy_timeout

1. Find the stream sections and current values:

   ```bash
   kubectl -n cpaas-system get configmap <alb-name> -o jsonpath='{.data}' | python3 -c 'import json,sys; print(list(json.load(sys.stdin)))'
   kubectl -n cpaas-system get configmap <alb-name> -o yaml | grep -n -E 'proxy_timeout|proxy_connect_timeout'
   ```

2. Raise `proxy_timeout` in `stream-tcp` (and `stream-udp` if used) in the overwrite ConfigMap, for example:

   ```nginx
   proxy_next_upstream_tries 5;
   proxy_connect_timeout 5s;
   proxy_timeout 360s;
   tcp_nodelay on;
   ```

   Values that fixed the examples above: 240s for the StarRocks connections, 360s for the API cut at 2 minutes, and 5 minutes for the large-model TCP load test. On versions that honor the Frontend timeout fields (Cause 2), a timeout set directly on a port's Frontend is used as an L4 timeout for that port only.

   > **Warning:** The change reloads nginx on every replica of this ALB, and longer idle timers keep idle TCP connections open longer. Keep a backup of the overwrite ConfigMap; if the ALB Pods are restarted to apply it, do it in a maintenance window. To roll back, restore the previous values and trigger the `alb2` update again.

3. Trigger the `alb2` update and confirm the value in `/alb/tweak/stream-tcp.conf` and `/alb/tweak/stream-udp.conf`. Check that the value you wrote matches the request.

### Cause 4: the nginx.ingress.kubernetes.io proxy timeout annotations on an Ingress

Put the annotations on the Ingress whose rules need a different timer, in the ingress-nginx format (seconds), and confirm with a timed request:

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
```

Only when the annotations are already set, the cluster is 3.12 or 3.18, and the timed request or the rendered configuration shows no change, move the timeout to the ALB-wide overwrite ConfigMap (Cause 1), with its warning.

## Diagnostic Steps

1. Show the image and the configured timers before changing them:

   ```bash
   kubectl -n cpaas-system get pods -l service_name=alb2-<alb-name> -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.containers[*].image}{"\n"}{end}'
   kubectl -n cpaas-system get alb2 <alb-name> -o jsonpath='{.spec.config.overwrite.configmap}{"\n"}'
   kubectl get frontends.crd.alauda.io -n cpaas-system -o yaml | grep -n -A6 timeout
   ```

2. Time the same path from outside, from the Service and from the Pod. A 120-second cliff only on the ALB URL is Cause 1 (HTTP) or Cause 3 (TCP port). The same cliff on the Pod is not the ALB:

   ```bash
   curl -k -o /dev/null -sS -w 'code=%{http_code} start=%{time_starttransfer} total=%{time_total}\n' --max-time 700 "https://app.example.com/<path>"
   kubectl -n <namespace> exec <backend-pod> -- wget -S -O /dev/null "http://<service>.<namespace>.svc:<port>/<path>"
   ```

3. For a TCP listener, compare the ALB port with the NodePort of the same Service, and read the ALB log for stream timeouts:

   ```bash
   nc -vz -w 3 192.0.2.10 <alb-tcp-port>
   kubectl -n cpaas-system logs <alb-pod> -c nginx --since=30m | grep -iE 'timed out|upstream' | tail
   ```

4. For the Ingress annotations, read what the Ingress carries, then time a request through the ALB as in step 2:

   ```bash
   kubectl -n <namespace> get ingress <ingress-name> -o jsonpath='{.metadata.annotations}{"\n"}'
   ```

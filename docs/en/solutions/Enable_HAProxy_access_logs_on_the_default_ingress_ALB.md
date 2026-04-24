---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The default ingress / load-balancer layer on ACP is implemented with HAProxy (under the ALB component). By default HAProxy access logging is disabled, so when a specific Ingress / route behaves unexpectedly there is no HTTP-level record of the incoming request, the back-end chosen, or the termination state. The operator wants to:

- temporarily turn access logging on for the default ALB / ingress deployment,
- capture the requests to a readable log stream,
- revert the change once the root cause is understood.

## Resolution

ACP uses the **ALB Operator** (`networking/operators/alb_operator`) as the ingress implementation. ALB is backed by HAProxy and exposes access-log configuration through the corresponding `ALB2` / `IngressController`-shaped custom resource. The pattern is the same as any HAProxy ingress: declare an access-log destination and a log format, and an additional sidecar container appears on the HAProxy pods that prints the access log on its stdout.

1. **Identify the ALB / ingress controller to modify.**

   ```bash
   kubectl get alb2 -A
   # or, for clusters using a generic IngressController CRD:
   kubectl get ingresscontroller -A
   ```

   In most clusters the default controller is named `default` and lives in the ALB operator namespace. Take a backup of the current spec before editing:

   ```bash
   kubectl -n <alb-operator-namespace> get alb2/default -o yaml > alb2_default.bkp.yaml
   ```

2. **Add an access-log destination and format to the spec.**

   Edit the resource:

   ```bash
   kubectl -n <alb-operator-namespace> edit alb2/default
   ```

   Insert a `logging.access` block under `spec`. The `type: Container` destination asks the operator to add a sidecar to each HAProxy pod that prints each line; the `httpLogFormat` is standard HAProxy `%`-escape syntax:

   ```yaml
   spec:
     logging:
       access:
         destination:
           type: Container
         httpLogFormat: >-
           log_source="haproxy-default" log_type="http"
           c_ip="%ci" c_port="%cp" req_date="%tr"
           fe_name_transport="%ft" be_name="%b" server_name="%s"
           res_time="%TR" tot_wait_q="%Tw" Tc="%Tc" Tr="%Tr" Ta="%Ta"
           status_code="%ST" bytes_read="%B" bytes_uploaded="%U"
           captrd_req_cookie="%CC" captrd_res_cookie="%CS"
           term_state="%tsc"
           actconn="%ac" feconn="%fc" beconn="%bc" srv_conn="%sc"
           retries="%rc" srv_queue="%sq" backend_queue="%bq"
           captrd_req_headers="%hr" captrd_res_headers="%hs"
           http_request="%r"
         logEmptyRequests: Log
   ```

   The operator reconciles and rolls out new ALB / HAProxy pods with an extra `logs` sidecar.

3. **Capture the access log.**

   The default ALB deployment typically runs two replicas behind a service, so both sidecars need to be tailed to be sure you catch every request:

   ```bash
   kubectl -n <alb-namespace> get pod -l app=alb2 -o name
   # tail each replica's logs sidecar:
   for p in $(kubectl -n <alb-namespace> get pod -l app=alb2 -o name); do
     kubectl -n <alb-namespace> logs -c logs "$p" --since=10m \
       | tee -a "${p##*/}.log" &
   done
   wait
   ```

   While the tail is running, reproduce the failure. Each HTTP request reaching HAProxy appears as one formatted line with the chosen fields — client IP, frontend, backend, chosen server, timers, status code, termination state. Match suspicious requests to the back-end they were routed to via the `be_name` / `server_name` fields.

4. **Revert when done.**

   Access logging is verbose and costs CPU on every request. Once you have the data you need, restore the original spec:

   ```bash
   kubectl -n <alb-operator-namespace> apply -f alb2_default.bkp.yaml
   ```

   The sidecars disappear on the next rollout and HAProxy returns to its previous throughput profile.

For longer-term access-log collection, point `destination.type` at `Syslog` (if the ALB resource supports it) or forward the sidecar's stdout into ACP's `observability/log` stack (Vector → Loki) and drop fields you do not need from the `httpLogFormat` to keep the volume manageable. Short-form formats (for example dropping the captured header / cookie fields) roughly halve the log size.

## Diagnostic Steps

Before editing, confirm access logging is currently off so the change produces visible output:

```bash
kubectl -n <alb-operator-namespace> get alb2/default -o \
  jsonpath='{.spec.logging.access}{"\n"}'
```

Verify the rollout completed:

```bash
kubectl -n <alb-namespace> rollout status deploy/<alb-deployment>
kubectl -n <alb-namespace> get pod -l app=alb2
# Each HAProxy pod should now have at least 2/2 containers (haproxy + logs).
```

Inspect one access-log line to confirm the format is valid HAProxy output:

```bash
kubectl -n <alb-namespace> logs -c logs <alb-pod> --tail=5
```

If you see no lines at all during a reproduction, check:

- whether `logEmptyRequests` is set to `Log` (otherwise empty health-check requests are dropped),
- whether the request actually reached this ALB / IngressController (use `c_ip="%ci"` plus the back-end name to triangulate),
- whether a NetworkPolicy or upstream gateway is absorbing the request before HAProxy sees it.

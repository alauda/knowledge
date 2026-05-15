---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RabbitMQ Exporter Metrics Collection Solution

## Background

`rabbitmq_exporter` collects metrics from the RabbitMQ Management API and exposes them in Prometheus format through `/metrics`.

This solution deploys the exporter as an external component:

- do not modify RabbitMQ operator logic
- deploy one exporter per RabbitMQ instance
- expose metrics through a Kubernetes `Service`
- integrate with Prometheus Operator through a `ServiceMonitor`

## Architecture

```text
Prometheus
  |
  v
ServiceMonitor
  |
  v
Service/<exporter>:9419
  |
  v
Deployment/<exporter>
  |
  v
RabbitMQ Management API
```

One exporter supports only one `RABBIT_URL`, so one RabbitMQ instance usually needs one exporter deployment.

## Prerequisites

- the RabbitMQ cluster already exists
- the `rabbitmq_management` plugin is enabled
- the management API is reachable on port `15672`
- a RabbitMQ account can access the management API
- Prometheus Operator is installed if `ServiceMonitor` will be used

RabbitMQ Cluster Operator usually creates a Secret named:

```text
<rabbitmq-name>-default-user
```

## Deployment

### Deployment Resource

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: <exporter-name>
  namespace: <namespace>
  labels:
    app.kubernetes.io/name: <exporter-name>
    app.kubernetes.io/part-of: <rabbitmq-name>
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: <exporter-name>
  template:
    metadata:
      labels:
        app.kubernetes.io/name: <exporter-name>
        app.kubernetes.io/part-of: <rabbitmq-name>
    spec:
      containers:
        - name: exporter
          image: registry.alauda.cn:60070/middleware/rabbitmq-exporter:v4.1.1
          imagePullPolicy: IfNotPresent
          ports:
            - name: metrics
              containerPort: 9419
          env:
            - name: RABBIT_URL
              value: http://<rabbitmq-name>.<namespace>.svc:15672
            - name: RABBIT_USER
              valueFrom:
                secretKeyRef:
                  name: <default-user-secret>
                  key: username
            - name: RABBIT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: <default-user-secret>
                  key: password
            - name: RABBIT_CONNECTION
              value: loadbalancer
            - name: RABBIT_EXPORTERS
              value: exchange,node,queue,aliveness
            - name: PUBLISH_PORT
              value: "9419"
            - name: LOG_LEVEL
              value: info
            - name: RABBIT_TIMEOUT
              value: "30"
          readinessProbe:
            httpGet:
              path: /health
              port: metrics
          livenessProbe:
            httpGet:
              path: /
              port: metrics
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
```

### Important Environment Variables

| Variable | Description |
| --- | --- |
| `RABBIT_URL` | RabbitMQ Management API URL |
| `RABBIT_USER` | Management username |
| `RABBIT_PASSWORD` | Management password |
| `RABBIT_CONNECTION` | Use `loadbalancer` when accessing through a Service |
| `RABBIT_EXPORTERS` | Enabled metric modules |
| `PUBLISH_PORT` | Exporter metrics port |
| `RABBIT_TIMEOUT` | Management API timeout in seconds |

Common modules:

- `exchange`
- `node`
- `queue`
- `aliveness`
- `connections`
- `shovel`
- `federation`
- `memory`

Recommended default modules:

```text
exchange,node,queue,aliveness
```

## Service and ServiceMonitor

### Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: <exporter-name>
  namespace: <namespace>
  labels:
    app.kubernetes.io/name: <exporter-name>
spec:
  type: ClusterIP
  ports:
    - name: metrics
      port: 9419
      targetPort: metrics
  selector:
    app.kubernetes.io/name: <exporter-name>
```

### ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: <exporter-name>
  namespace: <namespace>
  labels:
    app.kubernetes.io/name: <exporter-name>
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: <exporter-name>
  endpoints:
    - port: metrics
      path: /metrics
      interval: 60s
      scrapeTimeout: 30s
```

Notes:

- `ServiceMonitor.metadata.labels` must match the Prometheus instance `serviceMonitorSelector`.
- If your platform Prometheus uses a different selector, adjust the labels accordingly, for example `release: kube-prometheus`.
- `endpoints[].port` must match the Service port name, which is `metrics`.

## Verification

Check pod status and logs:

```bash
kubectl -n <namespace> get pod -l app.kubernetes.io/name=<exporter-name>
kubectl -n <namespace> logs deploy/<exporter-name> --tail=100
```

Create a test queue and publish messages:

```bash
RABBIT_USER=$(kubectl -n <namespace> get secret <default-user-secret> -o go-template='{{index .data "username" | base64decode}}')
RABBIT_PASSWORD=$(kubectl -n <namespace> get secret <default-user-secret> -o go-template='{{index .data "password" | base64decode}}')

kubectl -n <namespace> exec <rabbitmq-name>-server-0 -- \
  rabbitmqadmin --host localhost --port 15672 \
  --username "$RABBIT_USER" --password "$RABBIT_PASSWORD" \
  declare queue name=<check-queue> durable=true
```

Check metrics:

```bash
kubectl -n <namespace> exec deploy/<exporter-name> -- sh -c \
  "wget -qO- http://localhost:9419/metrics | grep '^rabbitmq_' | head"
```

## Useful Metrics

| Metric | Meaning |
| --- | --- |
| `rabbitmq_up` | Exporter can reach RabbitMQ |
| `rabbitmq_module_up{module="queue"}` | Queue module scrape health |
| `rabbitmq_queue_messages_ready` | Ready messages in a queue |
| `rabbitmq_queue_messages_unacknowledged` | Unacknowledged messages |
| `rabbitmq_queue_consumers` | Consumer count |
| `rabbitmq_queue_state` | Queue state such as `running`, `idle`, or `flow` |
| `rabbitmq_node_mem_used` | Node memory usage |
| `rabbitmq_node_disk_free` | Free disk bytes |
| `rabbitmq_shovel_state` | Shovel state when the shovel module is enabled |

## Recommended Alerts

```promql
rabbitmq_up == 0
```

```promql
rabbitmq_module_up{module="queue"} == 0
```

```promql
rabbitmq_queue_state{state="flow"} == 1
```

```promql
rabbitmq_queue_messages_ready > 0
```

```promql
rabbitmq_queue_consumers == 0
```

## Risks and Limitations

- one exporter can scrape only one RabbitMQ management endpoint
- queue metrics through a Service can depend on the management view of the selected backend node
- the `connections` module can create high-cardinality metrics
- `/health` reflects exporter scrape state, not full RabbitMQ business health

## Resource Recommendation

Recommended production resources:

```yaml
resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    cpu: 200m
    memory: 256Mi
```

## Uninstall

```bash
kubectl -n <namespace> delete servicemonitor <exporter-name>
kubectl -n <namespace> delete service <exporter-name>
kubectl -n <namespace> delete deployment <exporter-name>
```

---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A team forwards application logs from many namespaces to the same Kafka cluster but wants different namespaces to land on **different topics** — for example, `*-dev` namespaces into `dev-logs`, `*-stage` namespaces into `stage-logs`, `*-prod` namespaces into `prod-logs`.

The naive approach is one Kafka output per topic in the `ClusterLogForwarder` (3 outputs in the example above) plus a pipeline-with-input-selector for each. That works, but:

- Every output reopens its own Kafka producer connection and TLS session — N times the resource cost.
- Adding a new topic / namespace requires editing the CR (output + pipeline), generating churn.
- A typo in the per-output broker list silently halves the connection redundancy.

The administrator wants **one** Kafka output, with the topic chosen at write time from a field on the event.

## Resolution

The `ClusterLogForwarder.spec.outputs[].kafka.topic` field accepts a small expression language:

- A literal string, e.g., `"app-logs"`.
- A path reference to a field on the event, in single curly brackets `{ }`, with one or more fallback values separated by `||`. The chain **must** end in a static literal so the topic is always defined.

Examples (verbatim from the field's API docs):

```
foo-{.bar||"none"}
{.foo||.bar||"missing"}
foo.{.bar.baz||.qux.quux.corge||.grault||"nil"}-waldo.fred{.plugh||"none"}
```

A common usable choice for namespace-keyed routing: read a `topic` label off the namespace, fall back to a known sink topic for anything unlabelled.

### Step 1 — label the namespaces with the desired topic name

```bash
kubectl label ns/test1-dev   topic=dev-logs --overwrite
kubectl label ns/test2-dev   topic=dev-logs --overwrite
kubectl label ns/test1-stage topic=stage-logs --overwrite
kubectl label ns/prod-payments topic=prod-logs --overwrite
```

The label key (`topic` here) is arbitrary — pick a name that is unlikely to collide. The same key must appear on every namespace whose logs you want routed; namespaces without the label fall through to the static fallback topic.

For governance, enforce the label with a Kyverno policy so new namespaces cannot be created without one:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-namespace-topic-label
spec:
  validationFailureAction: enforce
  rules:
    - name: require-topic
      match:
        resources: { kinds: [Namespace] }
      validate:
        message: "Namespace must carry a 'topic' label so logs route to the right Kafka topic."
        pattern:
          metadata:
            labels:
              topic: "?*"
```

### Step 2 — collapse the multiple outputs into one with a dynamic topic

Edit the `ClusterLogForwarder`:

```bash
NS=<logging-namespace>
CR=<clusterlogforwarder-name>

kubectl -n "$NS" edit clusterlogforwarder "$CR"
```

Replace the multiple Kafka outputs with one whose `topic` is dynamic. The path
`.kubernetes.namespace.labels.topic` reads the namespace label set in Step 1; the static fallback `"missing"` is used for any event whose namespace was not labelled:

```yaml
apiVersion: observability.acp.io/v1   # CRD group — check kubectl api-resources on your cluster
kind: ClusterLogForwarder
spec:
  outputs:
    - name: kafka-multi-topic
      type: kafka
      kafka:
        brokers:
          - tls://kafka-01.example.com:9093
          - tls://kafka-02.example.com:9093
        topic: '{.kubernetes.namespace.labels.topic||"missing"}'
        # Optional batching / authentication knobs as before:
        # batch:    {maxBytes: 1048576, maxRecords: 1000}
        # tls:
        #   ca:          {key: ca-bundle.crt, secretName: kafka-secret}
        #   certificate: {key: tls.crt,       secretName: kafka-secret}
        #   key:         {key: tls.key,       secretName: kafka-secret}
  pipelines:
    - name: app-to-kafka
      inputRefs:
        - application
      outputRefs:
        - kafka-multi-topic
```

Apply / save. The collector operator regenerates Vector's config and rolls the DaemonSet:

```bash
kubectl -n "$NS" rollout status ds/collector
```

### Step 3 — confirm topic routing per namespace

Tail the Kafka cluster and observe events landing on the right topic:

```bash
# From a Kafka client pod or your local kafkacat with broker access:
kafkacat -b kafka-01.example.com:9093 -X security.protocol=ssl ... -t dev-logs   -C -q -e | head -3
kafkacat -b kafka-01.example.com:9093 -X security.protocol=ssl ... -t stage-logs -C -q -e | head -3
kafkacat -b kafka-01.example.com:9093 -X security.protocol=ssl ... -t missing    -C -q -e | head -3
```

Expected:

- `dev-logs` carries events from `test1-dev` / `test2-dev`.
- `stage-logs` carries events from `test1-stage`.
- `missing` is empty (or contains only events from namespaces you forgot to label — fix in Step 1).

If the wrong topic receives traffic, double-check the label spelling and the path used in `topic:` — an extra/missing dot in `.kubernetes.namespace.labels.topic` silently fails over to the fallback.

### Step 4 — extend to per-pod or per-container labels

The same pattern works with labels on the source pod or container. For per-pod routing, label the workload's pod template:

```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    metadata:
      labels:
        topic: payments-prod
```

And reference the path `.kubernetes.labels.topic` (or your collector's exact path — check `kubectl explain ClusterLogForwarder.spec.outputs.kafka.topic` for the supported field tree on your version).

For chained fallbacks — pod label, then namespace label, then static — write the chain in order:

```yaml
topic: '{.kubernetes.labels.topic||.kubernetes.namespace.labels.topic||"unrouted"}'
```

The first non-empty value wins. The static fallback is mandatory.

### Step 5 — verify the consolidation reduced overhead

Before / after metric to compare:

```promql
# Per-output Kafka producer connection count (collector exporter):
sum by (output) (vector_kafka_open_connections)
```

After the merge, the count for `kafka-multi-topic` should equal the brokers' fan-out (typically 1 connection per broker per collector pod), not N × brokers as before.

Vector's component config map shrinks proportionally — fewer outputs means fewer sinks declared:

```bash
kubectl -n "$NS" exec ds/collector -- cat /etc/vector/vector.yaml | yq '.sinks | keys'
```

### Step 6 — codify the runbook

Document the dynamic-topic pattern in the team's logging runbook:

- The label key (`topic`) and the path used in the `ClusterLogForwarder`.
- How to add a new topic: label namespace + create the topic on the Kafka side. **No CR change is needed** — that's the value of the consolidation.
- The fallback topic and its purpose ("anything unrouted lands here so we can find it").

## Diagnostic Steps

If the dynamic-topic field looks right but events still land on the fallback topic, check the field path against an actual event:

```bash
# Bump collector log to debug briefly to see the rendered event:
kubectl -n "$NS" set env ds/collector LOG=debug
sleep 30
kubectl -n "$NS" logs ds/collector --tail=200 | grep -B1 -A30 'kafka' | head -60
kubectl -n "$NS" set env ds/collector LOG-      # revert
```

In the JSON event the collector built, navigate to `kubernetes.namespace.labels` and confirm the `topic` key exists for the source namespace. If absent, the namespace was missed in Step 1 (or relabelled after the pod started — pods carry the namespace labels at admission time on most collectors; restart the source pod to pick up new labels).

If you see `field "kubernetes.namespace.labels.topic" missing` warnings, that is the same render-failure mode as the generic Vector labelKey-template-render case — the warning is loud but events still ship to the fallback because the `||"missing"` clause covers it.

For Kafka-side validation, list the topics receiving traffic and their throughput:

```bash
kafkacat -b kafka-01.example.com:9093 -L  # broker metadata, topic list
```

A topic that should be receiving traffic but is silent → the label is wrong / missing on the source side.
A topic appearing that you did not configure → the dynamic field rendered an unexpected value (someone labelled a namespace with a typoed topic name; the producer creates topics on demand on most Kafka cluster setups).

If your Kafka cluster has `auto.create.topics.enable=false`, the dynamic field can render a topic the broker rejects — Vector logs `Unknown topic` and the event is dropped. Either pre-create every topic name the dynamic field can produce, or enable auto-creation.

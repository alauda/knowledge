---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The cluster log collector on the ACP platform logging stack (`observability/log` + the **Logging Service** extension) is one of two open-source agents: the older Fluentd-based pipeline, or the current Vector-based pipeline. On recent releases, Fluentd has been retired from the list of supported collectors: fewer bugs are fixed against it, new output types and features land only in Vector, and its default configuration is on a path to removal. Operators still running the Fluentd collector should migrate to Vector to stay on a supported collection path.

The migration is an in-place switch — logs keep being collected during the changeover — provided the change is rolled through the same `ClusterLogForwarder` / collector CRs the cluster already has, and the downstream outputs are re-verified once Vector is live.

## Resolution

### 1. Pre-flight: confirm which collector is running and what outputs are in use

Inspect the collector DaemonSet and the forwarder CR. On a Fluentd cluster the pods are labelled `component=collector` with a container image whose name contains `fluentd`:

```bash
kubectl -n cluster-logging get ds -l component=collector \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}'

kubectl -n cluster-logging get clusterlogforwarder -o yaml
```

Note, for each output, its `type:` (e.g. `elasticsearch`, `kafka`, `syslog`, `splunk`, `loki`, `http`). Vector supports the same output types but validates the configuration more strictly than Fluentd — fields that Fluentd silently accepted and ignored can cause Vector admission to reject the CR. Budget for reviewing every output block in the next step.

### 2. Take a backup of the existing CRs

Save the live `ClusterLogForwarder` and any collector-level CRs (on a Fluentd-era deployment these may include a `ClusterLogging` or equivalent top-level CR) so the migration can be rolled back cleanly:

```bash
kubectl -n cluster-logging get clusterlogforwarder -o yaml \
  > clf-pre-migration.yaml
kubectl -n cluster-logging get clusterlogging -o yaml \
  > cl-pre-migration.yaml 2>/dev/null || true
```

### 3. Switch the collector type

The platform logging stack selects the collector implementation through a single field on the top-level CR (the exact field name is release-specific — on current ACP releases it is `spec.collection.type` on the cluster-logging CR, with values `fluentd` or `vector`). Patch it to `vector`:

```bash
kubectl -n cluster-logging patch clusterlogging instance \
  --type=merge \
  -p '{"spec":{"collection":{"type":"vector"}}}'
```

The operator reacts by:

1. Rendering a fresh collector DaemonSet using the Vector image.
2. Rolling the DaemonSet one node at a time (the default strategy), so log collection continues on nodes that have not yet been updated.
3. Retiring the Fluentd Pods and their per-node buffer directories at the end of the roll.

Watch the roll:

```bash
kubectl -n cluster-logging rollout status ds/collector
kubectl -n cluster-logging get pods -l component=collector -o wide
```

### 4. Review each output block for Vector-only syntax

Vector uses a subset of Fluentd's output configuration plus a handful of fields Fluentd does not have. Common adjustments per output type:

- **Elasticsearch / Loki / HTTP**: `tls.insecureSkipVerify`, bearer-token via `authentication:`, and `hosts:` form. Fluentd-era `tls.tlsVerify: false` maps to Vector's `tls.insecureSkipVerify: true`.
- **Syslog**: Vector's syslog sink is strict about RFC version (`rfc: RFC5424` vs `RFC3164`) and will not accept an RFC5424 URL over a UDP transport beyond ~2 KiB records. Prefer TCP.
- **Kafka**: Vector expects the SASL block under `authentication.sasl.*`; Fluentd's `auth:` alternatives do not round-trip.
- **Splunk HEC**: Vector's `splunk_hec_logs` sink populates HEC event-metadata keys (`host`, `source`) only when `host_key` / `source_key` are set.

Apply any required adjustments before the Vector collector finishes rolling on all nodes, so the collector does not flap between "installed" and "admission rejected" states:

```bash
kubectl -n cluster-logging edit clusterlogforwarder instance
```

### 5. Confirm logs are flowing end-to-end

After the rollout finishes, check on the Vector collector itself for accepted events and zero error rate:

```bash
POD=$(kubectl -n cluster-logging get pods -l component=collector \
        -o jsonpath='{.items[0].metadata.name}')

kubectl -n cluster-logging exec $POD -- vector top
```

`vector top` shows each component's input-event and output-event counters; sustained growth on the input side with no output errors is the healthy steady state. Then verify records arriving on the downstream:

- For a Loki output, a spot query on the Loki query endpoint:

  ```bash
  kubectl -n <loki-ns> exec deploy/loki-query-frontend -- \
    logcli query '{kubernetes_namespace_name="kube-system"}' --limit 5
  ```

- For an Elasticsearch output, a range search on the expected index alias.
- For an HEC / Splunk output, a Splunk search scoped to the last five minutes on the expected sourcetype.

### 6. Clean up Fluentd-era artefacts

Once the Vector collector has been running cleanly for a rollout period (typically 24 h), remove any Fluentd-only configuration files that may be mounted into the collector, and delete the backup CRs if the rollback window has passed:

```bash
kubectl -n cluster-logging get configmap -l fluentd=true
```

### Rollback

If Vector admission rejects the forwarder and logs stop flowing, patch `spec.collection.type` back to `fluentd` using the CR saved in step 2. The operator re-renders the Fluentd DaemonSet and log collection resumes within a rollout interval.

## Diagnostic Steps

Compare the running image with what the CR requested — a mismatch after the patch usually means the operator has not yet reconciled:

```bash
kubectl -n cluster-logging get clusterlogging instance \
  -o jsonpath='{.spec.collection.type}{"\n"}'
kubectl -n cluster-logging get ds/collector \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

If the Vector rollout stalls, inspect the collector pod that did not come up:

```bash
kubectl -n cluster-logging describe pod <stuck-collector-pod>
kubectl -n cluster-logging logs <stuck-collector-pod> --previous --tail=200
```

Common failure lines and what they mean:

- `parse error: ... unknown field ...` — the `ClusterLogForwarder` has a field Vector does not recognise; fix the CR (step 4).
- `failed to bind to tcp/<port>` — a metrics or health port collides with another host process; only a concern on hostNetwork collectors, which the Vector default does not use.
- `permission denied ... /var/log/pods/...` — SELinux/AppArmor context lost on the mount; the operator re-applies the correct security context on its next reconcile, restart the pod.

Collector-level metrics exposed by Vector at `127.0.0.1:8686/metrics` give the per-sink error rate; a non-zero and climbing `component_errors_total` on a specific sink points the investigation directly at that output's configuration.
</content>
</invoke>
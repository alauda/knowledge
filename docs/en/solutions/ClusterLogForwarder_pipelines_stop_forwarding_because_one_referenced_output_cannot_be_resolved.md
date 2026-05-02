---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The cluster's log query view shows "No datapoints found" for application or infrastructure logs that were arriving normally yesterday. The collector pods are `Running` but their logs are full of repeated DNS resolution failures pointing at one specific sink endpoint:

```text
ERROR sink{component_kind="sink" component_id=otel_svc component_type=socket
  component_name=otel_svc}: vector::internal_events::common: Unable to connect.
  error=Unable to resolve DNS: Unable to resolve name:
    failed to lookup address information: Name or service not known
```

After a while the Internal log "[Unable to connect.]" message starts being rate-limited by the collector itself. The forwarding pipeline never recovers on its own.

## Root Cause

The ClusterLogForwarder describes a directed graph: `inputs` feed `pipelines`, each pipeline lists one or more `outputRefs`, and the collector instantiates one sink per output. The collector treats the graph as a single program — all sinks must initialise successfully or the topology fails the healthcheck and stops shipping logs through pipelines that touch the broken sink.

When an output references a hostname that DNS cannot resolve, the corresponding sink fails its healthcheck on every reconnection attempt. Vector retries, the backoff grows, and any pipeline that lists this output in `outputRefs` blocks at the broken stage. Even logs destined for other (working) outputs in the same pipeline can be impacted while the topology is in this partially-initialised state.

The trigger is almost always a stale or mis-typed output. Common variants:

- A test sink (`otel_svc`, `myloki`, `dev-kafka`) that was created during bring-up and forgotten — the target Service was later deleted.
- A typo in the hostname that escaped review (`myloki.svc.local` vs `myloki.svc.cluster.local`).
- A namespace rename that broke the FQDN.
- A cross-cluster sink that depended on a DNS record which the platform team has since removed.

The pipeline configuration was valid at admission time — the schema doesn't require the destination to actually resolve — so the only way to notice the broken reference is the collector log.

## Resolution

Identify the broken sink from the collector log: the `component_id` field in the error message names the failing output. For the example above, `component_id=otel_svc` means an output called `otel-svc` (Vector normalises the name) is the culprit.

Two clean ways forward, depending on whether the output should still exist:

If the output is genuinely stale, remove the `outputRefs` entry from every pipeline that references it, then delete the output from `spec.outputs`:

```yaml
spec:
  pipelines:
    - name: application-logs
      inputRefs:
        - input0-logs
        - input1-logs
      outputRefs:
        - default
        # - otel-svc        # remove the broken reference
    - name: infra-logs
      inputRefs:
        - infrastructure
      outputRefs:
        - default
```

Apply the change. The collector reloads its configuration in place; within a few seconds the sink errors stop and the working pipelines resume forwarding:

```bash
kubectl -n logging apply -f clusterlogforwarder.yaml
kubectl -n logging logs daemonset/collector --tail=50 | grep -i error
```

If the output should exist but the hostname is wrong, fix the URL on the output definition rather than removing the reference. After applying, verify DNS resolution works from inside the cluster:

```bash
kubectl run -n logging --rm -it dns-debug --image=busybox --restart=Never -- \
  nslookup <fixed-hostname>
```

Once both checks (collector log free of `Unable to resolve DNS`, DNS lookup succeeds) pass, the pipeline is back to forwarding for all referenced outputs.

For long-term hygiene, treat ClusterLogForwarder outputs the same way GitOps treats any other declarative manifest — keep them in source control, review additions and removals, and do not let one-off test outputs accumulate.

## Diagnostic Steps

Pull the collector log on any one node and grep for the sink-level errors. The component name is the most direct way back to the broken output:

```bash
kubectl -n logging logs daemonset/collector --tail=500 \
  | grep -E 'component_id|Unable to resolve'
```

List the active ClusterLogForwarder configuration to map the failing component back to a pipeline. Depending on the API version the resource is `clusterlogforwarder` (v5) or `obsclusterlogforwarder` (v6):

```bash
kubectl -n logging get clusterlogforwarder -o yaml
# or
kubectl -n logging get obsclusterlogforwarder -o yaml
```

For the broken output's URL, confirm that DNS does not resolve from within the cluster:

```bash
kubectl run -n logging --rm -it dns-debug --image=busybox --restart=Never -- \
  nslookup <broken-hostname>
```

A clean reproduction looks like the lookup failing while a working sink in the same forwarder resolves correctly.

If the cluster has multiple ClusterLogForwarder instances (per-namespace forwarders, for example), repeat the inspection per instance — a broken output on one CR does not impact pipelines on a different CR but does break every pipeline that references it on its own CR.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A log-forwarding pipeline based on Vector is configured to ship cluster logs to a Splunk HEC endpoint, but no events arrive at the indexer. The collector pods stay healthy, yet a steady stream of error lines indicates that every batch is being rejected and dropped on the floor:

```text
ERROR sink{component_kind="sink" component_id=remote_splunk
  component_type=splunk_hec component_name=remote_splunk}:request{request_id=45341}:
  vector::sinks::util::retries: Not retriable; dropping the request.
  reason="response status: 404 Not Found"
```

The collector is reachable, TLS handshakes succeed, and the upstream queue is not building back-pressure — Splunk simply answers `404 Not Found` to every POST and Vector classifies the response as non-retriable.

## Root Cause

The `splunk_hec_logs` sink in Vector expects the **base URL** of the HEC endpoint and appends the API path itself (typically `/services/collector/event` or `/services/collector/raw`, depending on the codec). When the user-supplied URL already includes a path component, Vector concatenates the two and posts to a route that does not exist on the Splunk side, which returns `404`.

A common misconfiguration looks like this:

```text
url: https://splunkhec.example.com:8088/services/collector/event/1.0
```

The trailing `/services/collector/event/1.0` overrides what Vector would have generated and never resolves to a real handler on the HEC.

## Resolution

The platform-preferred path on ACP is to manage log shipping through the in-core observability area (`observability/log`) or the Logging Service extension, both of which wrap Vector's `splunk_hec_logs` sink behind a Splunk output type and validate the URL field at admission time. Configure the Splunk output through that surface where it is available — operators get schema validation, secret wiring, and per-stream rate limits without hand-editing collector configuration.

When operating closer to the OSS layer (custom `ClusterLogForwarder` instances or a self-managed Vector deployment), correct the URL to be the bare scheme + host + port of the HEC listener:

1. **Strip the path from the configured URL.** Keep only the scheme, host, and port:

   ```yaml
   apiVersion: logging.alauda.io/v1
   kind: ClusterLogForwarder
   metadata:
     name: instance
   spec:
     outputs:
       - name: remote-splunk
         type: splunk
         secret:
           name: vector-splunk-secret
         tls:
           insecureSkipVerify: true
         url: https://splunkhec.example.com:8088
   ```

   Vector will route to `https://splunkhec.example.com:8088/services/collector/event` automatically, which is the endpoint Splunk actually serves.

2. **Roll the collector pods.** The forwarder controller will reconcile the change and redeploy the collector DaemonSet. Watch for the `404 Not Found` events to stop and for delivery counters to climb:

   ```bash
   kubectl -n <logging-namespace> rollout status ds/collector
   kubectl -n <logging-namespace> logs -l component=collector -c collector --since=2m | grep -E "splunk|hec" | head
   ```

3. **Confirm in Splunk.** Search the HEC index for events with the cluster identifier or a known label. Records should begin appearing within seconds of the rollout completing.

4. **Pin the URL shape going forward.** Add a CI check (or a policy in the platform's admission stack) that rejects any Splunk output whose URL contains a path. The error mode is silent — pods stay healthy, drops only show up in collector logs — so a guard at submission time is cheaper than detecting it after the fact.

## Diagnostic Steps

Confirm Vector is the active collector and inspect the forwarder URL:

```bash
kubectl -n <logging-namespace> get clusterlogging instance -o jsonpath='{.spec.collection.type}{"\n"}'
kubectl -n <logging-namespace> get clusterlogforwarder instance -o jsonpath='{.spec.outputs[?(@.type=="splunk")].url}{"\n"}'
```

If the URL ends in anything past the port (for example `/services/...`), that is the root cause.

Reproduce the 404 against a single collector pod to rule out network or TLS confusion:

```bash
for pod in $(kubectl -n <logging-namespace> get pods -l component=collector -o name); do
  kubectl -n <logging-namespace> logs "$pod" -c collector --since=5m | grep "404 Not Found" | head -n 2
done
```

A non-empty result on every pod, all pointing at the same sink id, isolates the failure to the URL configuration rather than to a per-node connectivity problem. Once the URL is corrected, the same query should return empty within a couple of minutes.

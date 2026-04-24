---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A cluster log forwarding pipeline pushes application and infrastructure logs from the ACP platform logging stack (`observability/log` + the **Logging Service** extension) to a Splunk HTTP Event Collector (HEC) endpoint. On the Splunk side, operators expect the event-level metadata keys named in the Splunk HEC data-format reference — `host`, `source`, `sourcetype`, `index`, `time` — to be populated at the top level of each record.

What arrives instead is:

```json
{
  "file": "/var/log/pods/<ns>_<pod>_<uid>/<container>/0.log",
  "hostname": "worker-02.example.com",
  "kubernetes": {
    "namespace_name": "…",
    "pod_name": "…",
    "container_name": "…"
  },
  "message": "…",
  "@timestamp": "2026-02-18T13:42:46Z"
}
```

The collector is writing the node identity into `hostname` and the log-file path into `file`, not into `host` and `source`. Splunk indexes the events but does not apply its host-based search, source-based grouping, or source-type routing because the keys Splunk looks for are not present at the top level.

## Root Cause

The platform log stack is a generic collector pipeline built on two open-source agents — Vector on current releases, Fluentd on older ones. The shape of the record it emits is determined by the collector's own content model, not by any specific downstream sink. For Splunk HEC specifically:

- **Vector**'s `splunk_hec_logs` sink serialises the full record into the HEC `event` field and populates only the `host` key that the sink is explicitly configured to derive (from `host_key:`). It does **not** auto-translate `hostname` → `host` or `file` → `source` on the way out.
- **Fluentd**'s Splunk HEC output plugin behaves the same way: it takes whatever keys exist in the record and emits them under `event`, and requires per-field remapping for the HEC metadata slots.

Until a recent pipeline update to the collector's output-schema defaults, there was no built-in mapping for `hostname` → `host` or `file` → `source`, so the Splunk side saw the collector's internal field names rather than the HEC event-metadata names.

Upstream has since added the mapping in the Vector sink's HEC event-metadata handling; the change flows downstream through the platform logging updates. The fix is therefore: update to a collector release that includes the mapping, or — on older releases — remap the fields yourself in the `ClusterLogForwarder` output.

## Resolution

### Preferred: update the logging stack

The mapping from internal collector fields to Splunk HEC event-metadata fields is a defect fix in the OSS collectors and has been shipped in newer releases of the platform logging component. On ACP, upgrade the Logging Service / `observability/log` component to a release that carries the updated default Splunk output schema, and the `host` / `source` keys appear at the top level without configuration change.

Confirm which version is running:

```bash
kubectl -n cluster-logging get csv \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.version}{"\n"}{end}'
```

After the upgrade, verify the outgoing event shape — the next section describes exactly how.

### Fallback on older collector versions: remap in the forwarder

Until the upgrade lands, add an explicit Vector transform (or Fluentd record-reformer) that renames the fields before the Splunk sink consumes them. In the `ClusterLogForwarder` CR, attach the transform through a filter or a custom configuration block:

```yaml
apiVersion: logging.k8s.io/v1
kind: ClusterLogForwarder
metadata:
  name: instance
  namespace: cluster-logging
spec:
  outputs:
    - name: splunk-hec
      type: splunk
      url: https://hec.splunk.example.com:8088
      secret:
        name: splunk-hec-token
  filters:
    - name: splunk-hec-metadata
      type: parse
      parse:
        parseAs: json
  pipelines:
    - name: to-splunk
      inputRefs:
        - application
      outputRefs:
        - splunk-hec
      filterRefs:
        - splunk-hec-metadata
```

Where the filter surface does not expose field renames directly, write a `vector.toml` fragment through the collector's advanced configuration channel:

```toml
[transforms.hec_metadata]
type = "remap"
inputs = ["route_to_splunk"]
source = '''
  .host   = .hostname
  .source = .file
  del(.hostname)
  del(.file)
'''
```

Then wire the Splunk HEC sink after this transform:

```toml
[sinks.splunk]
type        = "splunk_hec_logs"
inputs      = ["hec_metadata"]
endpoint    = "https://hec.splunk.example.com:8088"
default_token = "${SPLUNK_HEC_TOKEN}"
host_key    = "host"
source_key  = "source"
```

`host_key` and `source_key` tell the HEC sink which record fields to lift into the HEC event metadata envelope. Without them the sink still writes the keys into the `event` payload but does not populate the envelope that Splunk uses for search.

## Diagnostic Steps

Confirm what the collector is actually emitting before it reaches Splunk. Vector exposes a live tap for any configured sink; dump a sample of events leaving the Splunk sink:

```bash
POD=$(kubectl -n cluster-logging get pods -l component=collector \
        -o jsonpath='{.items[0].metadata.name}')

kubectl -n cluster-logging exec $POD -- vector top
# note the numeric component_id for the splunk sink
kubectl -n cluster-logging exec $POD -- \
  vector tap --inputs-of <sink-id> --format json
```

A healthy event shows both envelope and payload keys:

```json
{
  "host": "worker-02.example.com",
  "source": "/var/log/pods/<ns>_<pod>_<uid>/<container>/0.log",
  "sourcetype": "kube:container:…",
  "event": { "message": "…", "kubernetes": { … } }
}
```

If `host` and `source` appear only inside `event`, the remap is either missing or the sink's `host_key` / `source_key` are still pointing at the old names.

On the Splunk side, run a search for a single well-known record and inspect the fields panel:

```spl
index=<your-index> pod_name="<pod>" | head 1 | table host source sourcetype
```

An empty `host` column (while `hostname` is populated inside the event body) confirms the collector is not lifting the value into the HEC envelope. Once the mapping is in place — either from the collector upgrade or the remap transform — the same query returns the node name under `host` and the pod log-file path under `source`.
</content>
</invoke>
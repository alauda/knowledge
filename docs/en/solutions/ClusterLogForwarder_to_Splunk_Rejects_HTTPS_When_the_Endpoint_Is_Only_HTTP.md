---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A log-forwarding pipeline that ships cluster logs to Splunk's HTTP Event Collector (HEC) fails to deliver events when the forwarder is configured with an `https://` URL. The pod's log shows TLS errors such as `SSL routines::wrong version number`, and the same HEC token works fine when the endpoint is probed with plain HTTP.

This shows up whether the forwarding is expressed through Alauda Logging Service (the ACP-native path, backed by Vector) or through a self-managed Vector / Fluentd deployment in the cluster — in both cases the forwarder insists on doing a TLS handshake and HEC replies with bytes that are not a TLS ServerHello.

## Root Cause

The `wrong version number` diagnostic from OpenSSL is the standard signature of a client that sent a TLS ClientHello to a server which is not, in fact, terminating TLS on that port. In the Splunk deployment the HEC listener has been provisioned in plaintext mode (`enableSSL = 0` in `inputs.conf` for the HEC input, or the HEC receiver behind a load balancer that terminates TLS upstream and forwards plain HTTP to port 8088).

The forwarder is therefore correct to complain — the target is not an HTTPS endpoint — but the pipeline is wired as if it were, so every batch is dropped at the handshake and nothing reaches the index.

## Resolution

Align the forwarder URL with what HEC is actually serving.

### Confirm what HEC is serving on that port

From any host that has IP reachability to the Splunk HEC, probe both schemes and compare. A working endpoint returns `HTTP/1.1 200 OK` with a JSON body of `{"text":"Success","code":0}`; a mismatched scheme fails at the transport layer before any HTTP exchange happens.

```bash
# Plain HTTP probe — succeeds if HEC was stood up without SSL
curl -v \
  -H "Authorization: Splunk <hec-token>" \
  -d '{"event":"probe"}' \
  http://<splunk-hec-host>:8088/services/collector/event

# HTTPS probe — succeeds if HEC was stood up with SSL
curl -v \
  -H "Authorization: Splunk <hec-token>" \
  -d '{"event":"probe"}' \
  https://<splunk-hec-host>:8088/services/collector/event
```

Whichever scheme prints `Success` is the one the forwarder must use.

### Point the forwarder at that URL

On the preferred ACP path, logs are shipped through Alauda Logging Service, which wraps Vector. Edit the `ClusterLogForwarder` (the CRD is the same schema that upstream Vector uses, because Logging Service runs Vector under the hood) and set the Splunk output URL to match the probe result:

```yaml
apiVersion: logging.alauda.io/v1
kind: ClusterLogForwarder
metadata:
  name: cluster-log-forwarder
  namespace: cpaas-system
spec:
  outputs:
    - name: splunk-hec
      type: splunk
      splunk:
        # Use http://... if HEC is plaintext; https://... only if HEC
        # genuinely terminates TLS on this port.
        url: http://<splunk-hec-host>:8088
        authentication:
          token:
            key: hec_token
            secretName: splunk-hec-token
  pipelines:
    - name: app-and-infra-to-splunk
      inputRefs: [application, infrastructure]
      outputRefs: [splunk-hec]
```

Re-apply with `kubectl -n cpaas-system apply -f clusterlogforwarder.yaml`, then watch the collector DaemonSet pods (`kubectl -n cpaas-system logs -l app.kubernetes.io/component=collector -f`) until the TLS error stops and batches start being acked by HEC.

On a self-managed Vector deployment (bare OSS, no Logging Service), the equivalent is the Vector sink block — set the same URL and reload:

```toml
[sinks.splunk]
type     = "splunk_hec_logs"
inputs   = ["app_logs"]
endpoint = "http://<splunk-hec-host>:8088"
default_token = "${SPLUNK_HEC_TOKEN}"
```

### If HTTPS is actually required

If the security posture requires TLS from cluster to HEC, the fix is on the Splunk side: enable SSL on the HEC input (`enableSSL = 1` in `inputs.conf`, restart `splunkd`), or put HEC behind a TLS-terminating load balancer and point the forwarder at the load balancer's `https://` URL. Do not change the forwarder back to HTTPS until the probe in the first step actually returns `Success` over HTTPS — otherwise the TLS error simply returns.

## Diagnostic Steps

The decisive signal is the curl output. `wrong version number` against an `https://` probe, coupled with a successful `http://` probe, is sufficient to conclude that the endpoint is HTTP-only and the forwarder URL is the variable to fix. No Splunk-side log is strictly needed at that point, but the same conclusion can be reached by reading `$SPLUNK_HOME/etc/system/local/inputs.conf` (or the HEC input's GUI configuration) and confirming `enableSSL = 0`.

Once the URL is corrected, verify the pipeline end-to-end: send a synthetic log line from a workload pod, watch the forwarder pod log for a `200 OK` from HEC for that batch, and query the event in Splunk.

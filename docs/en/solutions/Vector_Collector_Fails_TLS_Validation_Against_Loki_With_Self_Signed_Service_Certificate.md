---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The Vector-based log collector DaemonSet emits repeated TLS handshake failures when forwarding logs to a Loki output. Records do not reach Loki; the collector retries indefinitely and the failure surfaces in the collector's stderr stream:

```text
WARN sink{component_kind="sink" component_id=output_default_loki_audit
  component_type=loki}: vector::internal_events::http_client: HTTP error.
  error=error trying to connect: error:0A000086:SSL routines:
  tls_post_process_server_certificate:certificate verify failed:
  ssl/statem/statem_clnt.c:2102:: self-signed certificate in certificate chain
  error_type="request_failed" stage="processing"
```

Logs back up locally on the node; downstream querying via Loki shows a hole starting from the moment the issue began.

## Root Cause

Loki's distributor and gateway endpoints are exposed over HTTPS using server certificates issued by the in-cluster service certificate authority. Service CA certificates are signed by a CA that is private to the cluster — they do not chain up to any public root, so a client must be told explicitly which CA bundle to trust before the TLS handshake will succeed.

Vector uses the system trust store by default. The system store does not contain the cluster's service CA, so Vector marks the Loki server certificate as untrusted (`self-signed certificate in certificate chain`) and aborts the connection. The fix is to point Vector at the service CA via the `tls.ca` block on the Loki output of the log forwarder.

## Resolution

Edit the log forwarder custom resource and add a `tls.ca` reference that points at the ConfigMap containing the service CA bundle. The ConfigMap is propagated into application namespaces by the cluster's CA-injection controller; it carries the cluster CA under the key `service-ca.crt`.

```yaml
apiVersion: logging.alauda.io/v1
kind: LogForwarder
metadata:
  name: instance
  namespace: cpaas-logging
spec:
  serviceAccount:
    name: default-loki
  outputs:
    - name: loki-out
      type: loki
      loki:
        target:
          name: loki-uat
          namespace: cpaas-logging
        authentication:
          token:
            from: serviceAccount
      # Add this block. Without it the Vector sink uses the host trust
      # store and fails to validate the Loki gateway's service-CA-signed
      # certificate.
      tls:
        ca:
          key: service-ca.crt
          configMapName: trusted-ca-bundle
```

Apply with:

```bash
kubectl apply -f log-forwarder.yaml -n cpaas-logging
```

The collector pods reconcile the change in seconds — they reload their generated `vector.toml` and pick up the new CA path. No DaemonSet restart is required.

## Diagnostic Steps

Confirm the failure mode by tailing the collector pods. The error message text is the discriminating signal — generic connection refused or DNS errors point at a different problem.

```bash
kubectl logs -n cpaas-logging ds/collector --tail=50 | grep -i loki
```

The `self-signed certificate in certificate chain` substring is the diagnostic; if it is absent, this article does not apply.

Confirm the service CA ConfigMap actually exists in the namespace where the collector runs and contains the expected key:

```bash
kubectl get cm trusted-ca-bundle -n cpaas-logging
kubectl get cm trusted-ca-bundle -n cpaas-logging \
  -o jsonpath='{.data.service-ca\.crt}' | head -c 60
```

The output should begin with `-----BEGIN CERTIFICATE-----`. If the ConfigMap is missing, the namespace was created without the CA-injection annotation; create a ConfigMap with the platform's CA-injection annotation (consult your platform documentation for the exact key), wait for the controller to populate it, and reference that ConfigMap in `tls.ca`.

After applying the fix, confirm the collector resumed shipping:

```bash
kubectl logs -n cpaas-logging ds/collector --since=2m | grep -iE 'loki|sink' | head -20
```

The `error trying to connect` lines should stop and be replaced by routine batch-flush messages. Cross-check from the Loki side by querying for the namespace's recent log stream — gaps in the timestamp series end at the moment the fix took effect.
</content>

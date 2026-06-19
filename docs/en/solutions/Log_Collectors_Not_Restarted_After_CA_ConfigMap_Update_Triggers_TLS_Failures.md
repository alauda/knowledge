---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Log Collectors Not Restarted After CA ConfigMap Update Triggers TLS Failures
## Issue

The CA ConfigMap referenced by a `ClusterLogForwarder` output (`spec.outputs[*].tls.ca.configMapName`) is updated — for example because the upstream Loki / log receiver had its server certificate rotated and a new CA bundle was published. Within minutes, log collector pods on Alauda Container Platform start failing to deliver logs and emit:

```text
WARN sink{component_kind="sink" component_id=output_lokistack_audit
          component_type=loki}: vector::internal_events::http_client:
  HTTP error. error=error trying to connect:
  error:0A000086:SSL routines:tls_post_process_server_certificate:
  certificate verify failed:ssl/statem/statem_clnt.c:1889::
  self-signed certificate in certificate chain
  error_type="request_failed" stage="processing"
```

The collector pods themselves never restart, so they keep using the old CA bundle that was loaded into memory at start-up time, and the new CA in the ConfigMap is ignored.

## Root Cause

The Logging operator computes a pod-template hash annotation that triggers a rolling restart of the collector DaemonSet whenever any **Secret** referenced in the `ClusterLogForwarder` outputs changes. That mechanism does not currently include **ConfigMaps**: the operator does fetch the CA ConfigMap and mount it into each collector pod, but it does not hash the contents to detect a change. The collectors stay running with the old CA mounted in their TLS trust store until something else triggers a rollout.

Because Vector loads the trust store at process start, the new CA never makes it into the running collector and every onward connection to the receiver fails the TLS handshake until the pod is bounced.

## Resolution

Two paths — restart by hand once, or wire up a future-proof bounce when the CA is rotated.

### Manual restart after a CA update

Whenever you intentionally update the CA ConfigMap, also bounce the collector and metric-exporter pods so they pick the new CA:

```bash
NS=kube-logging      # adjust to the namespace running the collector
CR=collector         # adjust to the ClusterLogForwarder CR name

kubectl -n "$NS" delete pod -l app.kubernetes.io/instance="$CR"
kubectl -n "$NS" delete pod -l app.kubernetes.io/component=logfilesmetricexporter
```

Ingress should resume within a few seconds. Verify with `kubectl logs -n "$NS" <collector-pod> | grep -i "certificate verify"` — the message should be gone.

### Automated rotation: wire the ConfigMap to a deployment annotation

If the CA is renewed on a schedule (cert-manager-managed, for example) you do not want to remember to bounce pods every time. Add a hash-watcher that bumps a Deployment annotation whenever the CA ConfigMap content changes; the kubelet then rolls the pods automatically.

A simple recipe using a small CronJob and a known-format annotation:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: watch-loki-ca
  namespace: kube-logging
spec:
  schedule: "*/15 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: ca-rollout
          restartPolicy: OnFailure
          containers:
          - name: rollout
            image: bitnami/kubectl:latest
            command:
            - /bin/sh
            - -c
            - |
              HASH=$(kubectl -n kube-logging get cm loki-ca \
                       -o jsonpath='{.data}' | sha256sum | cut -c1-12)
              kubectl -n kube-logging annotate ds collector \
                ca-bundle/sha=$HASH --overwrite
```

The annotation propagates into the pod template hash; any change in the CA ConfigMap content yields a new SHA, which forces the DaemonSet to roll. The same `ca-rollout` ServiceAccount needs `get` on ConfigMaps and `patch` on DaemonSets in `kube-logging`.

For environments that already use a controller for CA distribution (cert-manager `trust-manager`, or a custom operator), prefer wiring the same annotation update into that controller's reconcile loop rather than running an out-of-band CronJob.

### Receiver-side: confirm Loki itself rotated cleanly

If the collectors' restart does not fix the TLS error, make sure the receiver presented the new certificate. For example, on a Loki stack managed by a Loki operator:

```bash
kubectl logs -n <loki-ns> -l app.kubernetes.io/name=loki-operator -c manager \
  | grep -i "Certificate expired"
```

If the operator reports its own server certs expired, the receiver itself needs a rotation; bouncing collectors will not help until the receiver is re-issued.

## Diagnostic Steps

1. Confirm the collector is failing on TLS specifically:

   ```bash
   kubectl -n "$NS" logs -l app.kubernetes.io/instance="$CR" --tail=100 \
     | grep -i 'certificate'
   ```

   The exact `tls_post_process_server_certificate: certificate verify failed` line confirms it is a TLS validation problem and not an auth one.

2. Capture the CA the collector pod actually loaded. Vector mounts the CA at `/etc/vector/certs/<output>/ca.crt` (path varies by collector image). Compare to the new content:

   ```bash
   kubectl -n "$NS" exec <collector-pod> -- \
     md5sum /etc/vector/certs/<output>/ca.crt
   kubectl -n "$NS" get cm <ca-configmap> -o jsonpath='{.data.ca\.crt}' \
     | md5sum
   ```

   If the in-pod hash does not match the in-ConfigMap hash, the pod is using a stale mount — restart it.

3. Validate the new CA actually verifies the receiver's certificate end-to-end. Run an `openssl s_client` from a debug pod on the same network:

   ```bash
   kubectl run tlsdbg --rm -it --image=alpine \
     --image-pull-policy=IfNotPresent -- sh -c '
       apk add --no-cache openssl ca-certificates
       openssl s_client -connect <loki-host>:<port> \
         -CAfile /tmp/ca.crt -showcerts < /dev/null'
   ```

   If `Verify return code` is non-zero, the new CA does not match the certificate chain the receiver is presenting — investigate the receiver, not the collector.

4. After applying the workaround, watch the failed-delivery rate decay to zero in the platform monitoring stack. The Vector internal metric `vector_component_errors_total{component_kind="sink"}` should stop incrementing.

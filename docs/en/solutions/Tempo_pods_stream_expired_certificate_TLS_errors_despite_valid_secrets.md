---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Tempo pods stream "expired certificate" TLS errors despite valid secrets
## Issue

A `TempoStack` deployed by the Tempo Operator stops serving traces in the platform's tracing UI. Symptoms:

- The tracing console shows `remote error: tls: expired certificate` and no traces render.
- The Tempo gateway pod logs the same expiry against the upstream proxy:

  ```text
  level=warn name=observatorium ts=... caller=reverseproxy.go:675
    msg="http: proxy error: remote error: tls: expired certificate"
  ```

- The Tempo distributor / query-frontend / querier pods log the TLS handshake error from the gateway side:

  ```text
  http: TLS handshake error from 10.0.0.1:47088:
    tls: failed to verify certificate: x509: certificate has expired or is not yet valid:
    current time 2025-08-29T13:04:41Z is after 2025-08-29T12:35:31Z
  ```

- Yet inspecting the certificate `Secret` objects in the `TempoStack` namespace shows valid `not-after` timestamps well in the future. The certificates on disk are not expired; only the *running* pods believe they are.

## Root Cause

The Tempo Operator rotates the internal TLS material that secures the gateway / distributor / querier mesh by writing fresh certificates into Secrets. The pods are mounted read-only and reload the material from the Secret without restarting — but in the affected Operator versions, the in-process certificate cache holds a stale copy across the rotation. Running pods continue to present (and verify against) the old certificate, while the Secret on disk already holds a valid replacement. A restart of the affected pods is the only path that flushes the in-memory copy and lets the gateway pick up the rotated material.

This is an upstream-tracked Tempo Operator regression. Until the fixed Operator build lands, a manual restart after every rotation is required.

## Resolution

Restart the pods that the Tempo Operator manages in the affected `TempoStack`. The Operator owns them via labels (`app.kubernetes.io/managed-by=tempo-operator`); deleting the pods is safe — the underlying Deployments / StatefulSets recreate them and they pick up the fresh Secrets:

```bash
TEMPO_NS=<tempostack-namespace>
kubectl -n "$TEMPO_NS" delete pod -l app.kubernetes.io/managed-by=tempo-operator
```

Watch the new pods come up and confirm the gateway log no longer carries the expired-certificate line:

```bash
kubectl -n "$TEMPO_NS" rollout status deployment -l app.kubernetes.io/managed-by=tempo-operator
kubectl -n "$TEMPO_NS" logs -l app.kubernetes.io/component=gateway --tail=50 | grep -iE 'expired|tls'
```

After the restart, traces should render again in the tracing UI. If the same error reappears at the next rotation cycle (typical: rotation cadence is days / weeks depending on the Operator's certificate-lifetime configuration), repeat the restart — or stage a rolling restart on a CronJob until the Operator-side fix is rolled out.

### Workaround that survives the next rotation

Schedule a periodic rolling restart of the Tempo deployments slightly more frequent than the certificate lifetime. A CronJob that runs `kubectl rollout restart` on the Tempo workloads avoids the manual response after each rotation:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: tempo-rotation-bounce
  namespace: <tempostack-namespace>
spec:
  schedule: "0 3 */3 * *"               # every 3 days at 03:00; tune to your rotation
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: tempo-bouncer
          restartPolicy: OnFailure
          containers:
            - name: kubectl
              image: bitnami/kubectl:latest
              command:
                - sh
                - -c
                - |
                  kubectl -n <tempostack-namespace> rollout restart \
                    deploy -l app.kubernetes.io/managed-by=tempo-operator
                  kubectl -n <tempostack-namespace> rollout restart \
                    statefulset -l app.kubernetes.io/managed-by=tempo-operator
```

This is a workaround, not a fix — remove the CronJob once the cluster runs a Tempo Operator build with the cache-flush fix.

## Diagnostic Steps

1. Confirm the Secret-side certificates are themselves valid — that is, the failure is the cache, not real expiry:

   ```bash
   TEMPO_NS=<tempostack-namespace>
   for s in $(kubectl -n "$TEMPO_NS" get secret -o name | grep tls); do
     echo "=== $s ==="
     kubectl -n "$TEMPO_NS" get "$s" -o jsonpath='{.data.tls\.crt}' \
       | base64 -d \
       | openssl x509 -noout -dates -subject
   done
   ```

   `notAfter` in the future on every Secret while the running pods still log expiry confirms the in-memory cache theory.

2. Pull the gateway and querier logs, scope to TLS errors, and capture the timestamps:

   ```bash
   kubectl -n "$TEMPO_NS" logs -l app.kubernetes.io/component=gateway --tail=200 \
     | grep -iE 'tls|expired'
   kubectl -n "$TEMPO_NS" logs -l app.kubernetes.io/component=tempo --tail=200 \
     | grep -iE 'tls|certificate has expired'
   ```

3. After restarting, confirm the new pods serve a non-expired chain. From any pod that talks to the gateway:

   ```bash
   kubectl -n "$TEMPO_NS" exec -it <client-pod> -- bash -c '
     openssl s_client -connect tempo-gateway:8443 -showcerts </dev/null 2>/dev/null \
       | openssl x509 -noout -dates -subject
   '
   ```

   The `notAfter` shown by `s_client` should match the Secret's `notAfter`; before the restart, it would have been the older, pre-rotation date.

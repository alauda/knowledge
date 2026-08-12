---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# TargetDown alert for Tempo gateway after upgrade due to incomplete operator-managed NetworkPolicy
## Issue

After upgrading the Tempo operator, Prometheus fires a `TargetDown` alert
covering the Tempo gateway:

```text
100% of the Job <ns>/gateway/tempo-<stack>-gateway targets in <ns>
have been unreachable for more than 15 minutes
```

The Tempo `ingester`, `compactor`, and `querier` pods are healthy and the
Tempo data plane continues to ingest and serve spans. The gateway pods
themselves are `Running`. Only the metrics scrape against the gateway
fails, so the alert keeps firing despite Tempo being functional.

## Root Cause

The Tempo operator reconciles a set of `NetworkPolicy` resources to
isolate the stack's pods. After the upgrade, the gateway pod's container
exposes its metrics endpoint on port `8081`, but the operator-managed
`NetworkPolicy` that fronts the gateway only allows ingress on `8080` and
`8090`. Prometheus, which scrapes from the monitoring namespace, is
blocked by the NetworkPolicy when it tries to reach `8081`. The scrape
times out, the target is reported `Down`, and `TargetDown` fires for
every gateway replica.

The same shape applies to any upgrade that adds a new metrics or admin
port to a workload: if the workload is fronted by a NetworkPolicy that
enumerates allowed ports explicitly, adding a new listener without
extending the policy cuts that listener off from any client outside the
policy's allowed peers.

## Resolution

Add a small additional `NetworkPolicy` that opens the missing port to
namespace-selector traffic. Keep it as a separate object so the operator's
reconciliation does not overwrite it on the next reconcile loop:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: tempo-gateway-metrics-allow
  namespace: <tempo-ns>
  labels:
    app.kubernetes.io/component: gateway
    app.kubernetes.io/instance: <stack-name>
    app.kubernetes.io/managed-by: tempo-operator
    app.kubernetes.io/name: tempo
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: gateway
      app.kubernetes.io/instance: <stack-name>
      app.kubernetes.io/managed-by: tempo-operator
      app.kubernetes.io/name: tempo
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector: {}
      ports:
        - port: 8081
          protocol: TCP
```

Apply with:

```bash
kubectl apply -f tempo-gateway-metrics-allow.yaml
```

Once the policy is in place Prometheus's next scrape succeeds and
`TargetDown` clears within one evaluation window. For tighter scopes,
narrow the `namespaceSelector` to the monitoring namespace specifically by
labelling that namespace and matching on the label.

If you prefer not to layer a second NetworkPolicy, an alternative is to
silence the alert in Alertmanager until the operator publishes a fix that
covers the new port — but this hides the gap from anyone who later looks
at Tempo's scrape health, so the additive policy is the cleaner approach.

## Diagnostic Steps

1. Confirm the Tempo data plane is actually healthy by querying spans
   directly against the gateway service. A successful query means the
   alert is metrics-only, not a real outage.

2. Inspect the gateway service's endpoints and confirm `8081` is in the
   list:

   ```bash
   kubectl get endpoints -n <tempo-ns> tempo-<stack>-gateway -o yaml \
     | yq '.subsets'
   ```

3. Inspect the operator-managed NetworkPolicy and confirm it does not
   include `8081`:

   ```bash
   kubectl get networkpolicy -n <tempo-ns> tempo-<stack>-gateway -o yaml \
     | yq '.spec.ingress'
   ```

4. From the monitoring namespace, drive a curl from a debug pod to the
   gateway's metrics port. A timeout confirms the policy block; a 200 with
   metrics confirms the path is healthy.

5. After applying the additive policy, watch the alert clear:

   ```bash
   kubectl get prometheusrule -A -o yaml | yq '.items[].spec.groups[].rules[] | select(.alert=="TargetDown")'
   ```

   The corresponding Prometheus target turns `up` and the `TargetDown`
   alert resolves.

---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.4.x
---

# Envoy Gateway hides 503 from a failing backend Pod because the HTTPRoute has an empty retry block on ACP

## Issue

A Deployment behind a Service has two Pods. One of them returns HTTP `503` for every request (for example, deliberately for a test). The responses carry the Pod IP, so it is visible which Pod answered.

- Requests sent to the Service ClusterIP reach both Pods: the healthy Pod returns `200`, the failing Pod returns `503`.
- Requests sent through Envoy Gateway only ever return `200` from the healthy Pod. No response carries the failing Pod's IP, so it looks as if the gateway sends all traffic to one Pod or never selects the failing one.

The Service has no session affinity, and both Pods are `Ready` and listed in the EndpointSlice.

## Root Cause

The HTTPRoute rule contains an empty retry object:

```yaml
rules:
  - backendRefs:
      - name: <service-name>
        port: <port>
    retry: {}
```

Even with no parameters, `retry: {}` makes Envoy Gateway (as shipped with ACP 4.4) apply its default retry policy to the route. That default treats `503` as retryable and uses Envoy's `previous_hosts` retry predicate, which picks a different backend host for the retry.

A request that first reaches the failing Pod gets `503`, is retried automatically on the healthy Pod, and the client receives `200`. The failing Pod does receive traffic, but its `503` responses are never returned to the client.

This is the expected behavior of the retry configuration. It is not a Service load-balancing problem, and the failing Pod is not excluded by the gateway.

## Resolution

Choose one of the following for each affected route.

1. **The route does not need retries:** remove the `retry` field from the rule entirely. Do not leave `retry: {}` in place.

   ```bash
   kubectl -n <namespace> edit httproute <httproute-name>
   ```

   Delete the `retry:` line under `spec.rules[]`, save, and send requests through the gateway again. Both `200` and `503` responses now reach the client.

2. **The route needs retries:** configure them explicitly instead of relying on the defaults, so that you decide which status codes are retried and how often. For example:

   ```yaml
   rules:
     - backendRefs:
         - name: <service-name>
           port: <port>
       retry:
         codes:
           - 503
         attempts: 2
         backoff: 100ms
   ```

   Enable retries on `503` with care for external interfaces, write operations and other non-idempotent requests: a retried request can be executed twice by the backend, and the retries hide backend failures from clients and from client-side monitoring.

If routes are created from the console or from generated YAML, check whether they contain an empty `retry: {}` object that nobody added on purpose.

## Diagnostic Steps

1. Look for an empty or default retry configuration on the route:

   ```bash
   kubectl -n <namespace> get httproute <httproute-name> -o yaml | grep -n -A4 'retry'
   ```

   `retry: {}` matches this issue.

2. Confirm that the failing Pod still receives requests through the gateway. Its own access log shows requests coming from the Envoy Gateway proxy Pods even though no client sees its `503`:

   ```bash
   kubectl -n <namespace> get pod -o wide | grep <app-name>
   kubectl -n <namespace> logs <failing-pod-name> --tail=50
   ```

3. Rule out look-alikes:

   - Session affinity or consistent hashing would pin clients to one Pod; check the Service and any `BackendTrafficPolicy` that targets the route:

     ```bash
     kubectl -n <namespace> get svc <service-name> -o jsonpath='{.spec.sessionAffinity}{"\n"}'
     kubectl -n <namespace> get backendtrafficpolicy -o yaml
     ```

   - A Pod that is not `Ready` is removed from the EndpointSlice and gets no traffic at all; check that both Pods are listed with `ready: true`:

     ```bash
     kubectl -n <namespace> get endpointslice -l kubernetes.io/service-name=<service-name> -o yaml
     ```

4. After removing `retry: {}`, repeat the test through the gateway. Responses from both Pods appear, which confirms the cause.

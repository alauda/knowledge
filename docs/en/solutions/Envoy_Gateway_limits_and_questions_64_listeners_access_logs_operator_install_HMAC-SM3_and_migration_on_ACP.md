---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.2"
  - "4.3"
---

# Envoy Gateway limits and questions: 64 listeners, access logs, operator install, HMAC-SM3 and migration on ACP

## Issue

Questions about what Envoy Gateway on ACP can do:

- A single Gateway needs more than 64 listeners; how can the cap be raised?
- Gateway access logs cannot be found: Administrator > Operations Center > Logs > Query returns `共 0 条日志` (0 logs) for the Envoy Gateway Pod while the log collector already collects Kubernetes logs. How are access logs enabled, or put in a defined format?
- Does installing the Envoy Gateway Operator take over existing Ingress or ALB traffic?
- The Gateway must verify HMAC-SM3 signatures.
- After an upgrade to 4.2.2, how can every ALB entry be moved to Envoy Gateway?
- ingress-nginx is going out of maintenance; what is the migration plan?

Related articles: "Envoy Gateway setup fails: Backend is disabled, platform certificate not selectable, TLS-RSA ciphers or Wasm x509 on ACP".

## Root Cause

### Cause 1: one Gateway is limited to 64 listeners

The product cap is 64 listeners on a single Gateway. It is not a field on `EnvoyGatewayCtl` or on the Gateway and cannot be changed in the current product.

### Cause 2: access logs are on the Envoy data-plane stdout and are not shown in the platform log query

The Envoy data-plane Pod (named `envoy-<gateway-namespace>-<gateway-name>-<hash>`, container `envoy`, next to `shutdown-manager`) writes access logs as JSON lines to standard output, with fields such as `"method"`, `"protocol"`, `"response_code"`, `"response_code_details"` and `"route_name"`. The data-plane Pod can run in the operator namespace `envoy-gateway-operator`. Gateway logs cannot be displayed or queried in **Operations Center > Logs > Query**: the Pod can be selected as a filter, but the query returns no data. This is a product limitation, with log query support for the gateway component planned for a future version. `kubectl logs` on the data-plane Pod is the way to read them.

When the Pod prints no access lines, or a defined text format is needed, access logging is configured with `spec.telemetry.accessLog` on the `EnvoyProxy` that the Gateway references.

### Cause 3: installing the operator does not intercept Ingress or ALB traffic

Installing the Envoy Gateway Operator alone changes no traffic. Traffic moves only when an `EnvoyGatewayCtl`, a `Gateway` and its data-plane Service exist and clients are pointed at it.

### Cause 4: HMAC-SM3 signature verification is not an Envoy Gateway capability

The installed Envoy Gateway features cannot verify HMAC-SM3 signatures, and there is no policy field for it. The external authorization guide does not add it either.

### Cause 5: there is no whole-cluster procedure to replace ALB with Envoy Gateway

No supported procedure exists to switch all ALB entries of a cluster to Envoy Gateway (asked after a 4.2.2 upgrade). Exposing an individual service through a new Gateway and HTTPRoute is a separate task, not a replacement plan for every ALB.

### Cause 6: the ingress-nginx to Gateway API migration is documentation-based

The recommended replacement for ingress-nginx is Gateway API with Envoy Gateway, and standard support covers it with documentation. A plan customized for one environment needs a feature request that includes all of the cluster's Ingress resources.

## Resolution

### Cause 1: one Gateway is limited to 64 listeners

Count the listeners before assuming the cap is the failure. A higher number is a product requirement.

```bash
kubectl get gateway <gateway-name> -n <gateway-namespace> -o jsonpath='{.spec.listeners[*].name}{"\n"}' | wc -w
```

### Cause 2: access logs are on the Envoy data-plane stdout and are not shown in the platform log query

Read the data-plane Pod, not the operator or controller Pod:

```bash
kubectl get pods -A -o wide -l gateway.envoyproxy.io/owning-gateway-name=<gateway-name>
kubectl logs -n <data-plane-namespace> <envoy-pod> -c envoy --tail=100
```

A permission error for a developer account is an RBAC question about who may read Pod logs, not a missing log switch.

When the lines are missing or a defined format is required, add telemetry to the `EnvoyProxy` named by the Gateway's `spec.infrastructure.parametersRef`. Confirm the field path with `kubectl explain envoyproxy.spec.telemetry.accessLog` and follow it if it differs. Request headers can be added as `%REQ(HEADER_NAME)%` and response headers as `%RESP(HEADER_NAME)%`.

```yaml
spec:
  telemetry:
    accessLog:
      settings:
        - format:
            type: Text
            text: '[%START_TIME%] "%REQ(:METHOD)% %REQ(X-ENVOY-ORIGINAL-PATH?:PATH)% %PROTOCOL%" %RESPONSE_CODE% %RESPONSE_FLAGS% %BYTES_RECEIVED% %BYTES_SENT% %DURATION% "%REQ(X-FORWARDED-FOR)%" "%REQ(USER-AGENT)%" "%REQ(X-REQUEST-ID)%" "%REQ(:AUTHORITY)%" "%UPSTREAM_HOST%"'
          sinks:
            - type: File
              file:
                path: /dev/stdout
```

> **Warning:** Changing `EnvoyProxy` telemetry rolls the data-plane Deployment and closes connections on the replaced Pods. Merge the block into the existing object; a file with only `telemetry` drops `provider` and other settings. Save the object first; applying the saved copy is the rollback.

```bash
kubectl get envoyproxy <envoyproxy-name> -n <gateway-namespace> -o yaml > /tmp/envoyproxy-before.yaml
kubectl edit envoyproxy <envoyproxy-name> -n <gateway-namespace>
kubectl logs -n <data-plane-namespace> <envoy-pod> -c envoy --tail=50
```

### Cause 3: installing the operator does not intercept Ingress or ALB traffic

No traffic change is needed to answer it. Empty results below mean no data plane exists yet and existing Ingress and ALB listeners keep their traffic:

```bash
kubectl get envoygatewayctl -A
kubectl get gateway -A
```

### Cause 4: HMAC-SM3 signature verification is not an Envoy Gateway capability

Raise a product requirement that names the signature algorithm and the Gateway that needs it.

### Cause 5: there is no whole-cluster procedure to replace ALB with Envoy Gateway

Plan the move per service: create a Gateway and HTTPRoute for each service and move its clients, keeping the ALB entry until the new one is verified.

### Cause 6: the ingress-nginx to Gateway API migration is documentation-based

Follow "How to Migrate Ingress to Gateway API with Envoy Gateway on ACP" (ACP 4.3.x and later). It maps one ingress controller entry to one `Gateway` and one `Ingress` to one `HTTPRoute`, and converts annotations to filters and policies. For a plan made for one environment, export the Ingress resources and IngressClasses and attach them to a feature request, after removing anything the site does not allow to leave the environment:

```bash
kubectl get ingressclass -o yaml > /tmp/ingressclass-all.yaml
kubectl get ingress -A -o yaml > /tmp/ingress-all.yaml
kubectl get ingress -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,CLASS:.spec.ingressClassName,HOSTS:.spec.rules[*].host'
```

## Diagnostic Steps

- Listener count of 64 and an extra listener rejected: Cause 1.
- An empty result in the platform log query for the gateway Pod: Cause 2; run `kubectl logs` on the data-plane Pod. Lines present there confirm logging works; none means the telemetry block is needed.
- No `EnvoyGatewayCtl` and no `Gateway` in the cluster: Cause 3.
- An explicit HMAC-SM3 requirement and no matching field in `kubectl explain securitypolicy.spec`: Cause 4.
- A request for a whole-cluster ALB replacement: Cause 5. A migration plan from ingress-nginx: Cause 6.

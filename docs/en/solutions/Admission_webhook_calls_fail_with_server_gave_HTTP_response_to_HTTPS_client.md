---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Admission webhook calls fail with "server gave HTTP response to HTTPS client"
## Issue

API requests, deployments, and namespace operations fail intermittently with an admission webhook error of the shape:

```text
Internal error occurred: failed calling webhook
  "namespace.sidecar-injector.istio.io":
  failed to call webhook:
    Post "https://istiod.istio-system.svc:443/inject?timeout=10s":
    http: server gave HTTP response to HTTPS client.
```

The webhook itself is healthy — its pod is running, its certificate is valid, manual `curl` from a debug pod in the same namespace works. The failure is reproducible only on a subset of operations (creating Pods, applying ConfigMaps, calling list/watch from a controller), and only when those calls go through the API server.

## Root Cause

The API server runs in the host network namespace of the control-plane node. When it dispatches an admission webhook call, the source IP it presents is the **host's IP**, not a pod IP. From the destination namespace's point of view, that source is a host-network pod — and a NetworkPolicy that does not include host-network as an allowed source will drop or reset the connection.

The misleading message `server gave HTTP response to HTTPS client` is a side effect of how the rejection looks at the TLS layer: the client (kube-apiserver) opens a TLS handshake, the NetworkPolicy drops the SYN/ACK or the controller manager retries against a wrong target, and the next read returns either nothing or an HTTP error from a fallback path. The Go TLS stack reports it as "the server appears to be speaking plain HTTP". The real cause is that the apiserver's connection never got to the webhook pod's TLS listener at all.

The trip-wire is having other ingress NetworkPolicies in the same namespace — `allow-same-namespace`, `allow-from-monitoring`, `allow-from-ingress` — and **not** having one that whitelists the host-network source. Once any ingress policy is present, traffic that does not match an `allow` rule is denied by default.

## Resolution

Add a NetworkPolicy in the webhook's namespace that allows ingress from host-network pods. Hosts (control-plane and workers running in the host netns) are identified by a label that the cluster's CNI applies to a synthetic namespace selector. The exact label key depends on the platform's CNI; the policy below uses the conventional `host-network` group label — read the cluster's docs for the precise key if it differs.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-from-hostnetwork
  namespace: <webhook-namespace>      # e.g. istio-system
spec:
  podSelector: {}                     # all pods in the namespace
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              policy-group.network.<your-cni>/host-network: ""
```

Apply with:

```bash
kubectl apply -f allow-from-hostnetwork.yaml
```

After the policy lands, the webhook calls from the API server start arriving on the webhook pod's TLS listener and the admission failures stop. There is no need to bounce the API server or the webhook — NetworkPolicy changes take effect on the next packet.

### Tightening the policy

The version above accepts host-network traffic on every port the webhook pod exposes. If the webhook listens on a single port (typically 443/TCP or 9443/TCP), restrict the rule:

```yaml
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            policy-group.network.<your-cni>/host-network: ""
    ports:
      - protocol: TCP
        port: 9443
```

That keeps the surface tight while still letting the API server reach the webhook.

### Multiple webhook namespaces

Every namespace that exposes an admission webhook (Service Mesh, cert-manager, the policy engine, custom in-house webhooks) needs its own copy of the rule — NetworkPolicies are namespaced. A good operational pattern is to ship the policy as part of each webhook's chart so it is created together with the Service.

## Diagnostic Steps

1. Confirm the failing call is hitting an admission webhook and not, for example, a misconfigured proxy. The error message includes the webhook name (`name` field on the `MutatingWebhookConfiguration`/`ValidatingWebhookConfiguration`) and the target URL (`https://<svc>.<ns>.svc:<port>/<path>`). Both must match an existing object:

   ```bash
   kubectl get mutatingwebhookconfigurations,validatingwebhookconfigurations \
     -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'
   kubectl get svc -n <webhook-namespace>
   ```

2. List the NetworkPolicies in the webhook namespace and look specifically for the absence of a host-network allow rule:

   ```bash
   kubectl get netpol -n <webhook-namespace>
   # typical bad shape: the three policies below exist, but no
   # allow-from-hostnetwork policy:
   #   allow-from-ingress
   #   allow-from-monitoring
   #   allow-same-namespace
   ```

   That set of three with no host-network rule is the signature of this issue.

3. Reproduce the path manually. From a debug pod that runs **on the host network** (so it shares the source-address class the API server uses), curl the webhook service directly:

   ```bash
   kubectl debug node/<control-plane-node> -it --profile=sysadmin --image=<utility-image> \
     -- curl -kv https://<webhook-svc>.<ns>.svc:9443/healthz
   ```

   A connection that hangs / resets / produces "server gave HTTP response" reproduces the failure outside the apiserver code path and proves the NetworkPolicy is the cause.

4. After applying the `allow-from-hostnetwork` policy, retry the original operation and confirm the webhook call now succeeds. Watch the admission logs on the webhook pod — the request should arrive within a second:

   ```bash
   kubectl logs -n <webhook-namespace> <webhook-pod> --tail=20 -f
   ```

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A client attempting to reach a workload over an `Ingress` (or equivalent route object) configured for TLS **passthrough** receives connection failures — typically `TLS handshake failed`, `unknown SNI`, or an HTTP `404` from the wrong backend — when the cluster sits behind an external Layer-7 load balancer (cloud ALB/NLB in HTTP/HTTPS mode, F5 in "HTTPS" profile, NGINX in reverse-proxy mode, etc.). The same client succeeds when it bypasses the external LB and hits the cluster ingress directly with a `Host:` override, which tells you the path through the cluster itself is fine.

Indirectly: the workload's own certificate is served on the client's end of the connection, but the SNI extension that reached the cluster proxy either does not match any configured host (hence `404` / `SSL handshake failed`) or was stripped entirely.

## Root Cause

A passthrough route is contractual: the cluster ingress proxy does **not** terminate TLS. It looks at the **SNI** extension of the `ClientHello`, picks the backend, and hands the encrypted bytes straight through. This only works if the client's SNI survives every hop between the client and the cluster ingress proxy intact.

A Layer-7 external load balancer, by definition, terminates TLS at the LB itself: it decrypts, inspects the HTTP layer, and opens a **new** connection toward the backend (the cluster ingress). That new connection carries whatever SNI the LB chooses to set — often the LB's own certificate name, or nothing — and the original client SNI is gone by the time the cluster proxy sees the handshake. The cluster proxy then either routes to a default backend, fails the handshake, or returns `404`.

This is structural: an L7 LB cannot preserve end-to-end TLS with passthrough semantics. Either the LB must run in L4 (TCP) mode, or the cluster-side must switch off passthrough.

## Resolution

ACP's ingress is provided by the **ALB Operator** (`networking/operators/alb_operator`). The same two options apply regardless of the ingress implementation, and the correct choice depends on whether end-to-end TLS is a requirement.

### Preferred (when end-to-end TLS is required): external LB in L4/TCP mode

Keep passthrough on the cluster side, and configure the external LB as a pure TCP forwarder on port `443`. It will not terminate TLS, will not inspect headers, and will not alter SNI — the `ClientHello` reaches the cluster ingress unmodified and the cluster proxy routes it correctly by SNI.

- Cloud NLBs (AWS NLB, GCP TCP LB, Azure Load Balancer) all support a pure L4 listener; use that, not their L7 offering.
- F5/NGINX: configure a Virtual Server with an `fastL4` profile or a `stream` block, not an HTTP virtual server.
- Health checks should be TCP to `:443`, not HTTPS, so the LB does not try to do its own TLS handshake against a backend whose certificate may not match the LB's view of the hostname.

The downside of L4 mode is that the external LB cannot do per-path routing, WAF inspection, or HTTP-level metrics; those belong at a different layer.

### Alternative (when L7 external LB is required): switch to edge or reencrypt termination at the cluster

If the external LB must stay in L7 (WAF rules, per-path routing, centralised access logs), change the cluster side so it is also L7 — terminate TLS at the cluster ingress. Two patterns are supported:

- **Edge termination.** The cluster ingress presents its own certificate and speaks plain HTTP to the backend pod. This is the simplest option when the in-cluster network is trusted.
- **Reencrypt termination.** The cluster ingress terminates the client-side TLS, then opens a new TLS connection to the backend using either the service-CA certificate or one explicitly configured on the Ingress object. This preserves encryption in the pod-to-pod path.

Both modes let the external LB and the cluster ingress independently manage their TLS contexts. Neither needs SNI from the hop upstream, so the original termination happens cleanly.

#### ALB Ingress example: edge termination

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-edge
  namespace: myapp
  annotations:
    # Bind this Ingress to the named ALB CR.
    project.cpaas.io/alb-name: cpaas-alb
spec:
  tls:
    - hosts:
        - myapp.example.com
      secretName: myapp-tls
  rules:
    - host: myapp.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: myapp
                port:
                  number: 80
```

The `tls` block terminates TLS at the ALB using the certificate in `myapp-tls`; the backend is reached as plain HTTP on port 80. Annotations that previously marked the Ingress as passthrough must be removed.

#### ALB Ingress example: reencrypt (backend HTTPS)

When the backend pod speaks HTTPS natively — for instance, a Java service presenting a keystore cert — switch the Ingress to talk TLS to the backend as well. The exact annotation name varies by ALB version; the reference is the ALB CR's annotation documentation. The typical pattern is:

- The Ingress has the same `tls:` block as above (client-side termination).
- An ALB-specific annotation sets the backend protocol to `https` and optionally pins a trusted-CA certificate for the backend's self-signed cert.

This terminates TLS twice (once at the ALB, once between ALB and backend) but removes the SNI transparency requirement across the external LB hop entirely.

### Fallback: stock Kubernetes Ingress (no ALB)

If the cluster runs a plain Kubernetes Ingress controller (NGINX Ingress, Traefik, etc.), the same two choices apply. NGINX has an `ssl-passthrough` annotation that behaves identically to ALB's passthrough; switching it off and supplying `tls.secretName` puts the controller in edge mode. Traefik has `TLSOption` resources for the same purpose. The external-LB-in-L4 pattern is orthogonal and works for any Ingress controller.

## Diagnostic Steps

Confirm the Ingress is actually in passthrough mode:

```bash
kubectl get ingress -A -o json \
  | jq -r '.items[]
           | select(.metadata.annotations
                    | to_entries[]?
                    | select(.key|test("passthrough|ssl-passthrough")))
           | "\(.metadata.namespace)/\(.metadata.name)"'
```

Prove the cluster path works in isolation. Bypass the external LB by resolving the hostname directly to the cluster ingress's public IP:

```bash
curl -vk --resolve myapp.example.com:443:<cluster-ingress-ip> \
  https://myapp.example.com
```

A successful response here and a failure through the LB pinpoints the problem to the LB hop.

Confirm what the external LB is doing with TLS. On most clouds this is visible in the LB's listener configuration:

- If the listener uses **HTTPS / HTTP/2** or an L7 product (ALB, Application Gateway, Classic LB `https` listener), the LB is terminating — that matches the failure mode described.
- If the listener is **TCP / TLS passthrough / L4 NLB**, the LB is forwarding — something else is the problem.

As a quick end-to-end SNI check, capture the `ClientHello` at the cluster ingress (on one of the ingress pod replicas):

```bash
kubectl exec -it -n <ingress-ns> <ingress-pod> -- \
  tcpdump -i any -nn -A -s 0 'tcp port 443' | head -n 50
```

(This requires `tcpdump` in the pod image; otherwise use a debug sidecar or port-forward and capture on the client machine.) If the `SNI=` field in the captured `ClientHello` is empty or matches the external LB's own certificate hostname rather than the client's intended hostname, the diagnosis is confirmed.

Finally, check the cluster-side proxy's own logs for the handshake attempt:

```bash
kubectl logs -n <ingress-ns> <ingress-pod> --tail=200 | grep -iE "handshake|sni"
```

Repeated handshake failures correlated with requests from the LB's source IPs make the last mile of evidence: whatever SNI the LB is offering does not match any configured passthrough host in the cluster.

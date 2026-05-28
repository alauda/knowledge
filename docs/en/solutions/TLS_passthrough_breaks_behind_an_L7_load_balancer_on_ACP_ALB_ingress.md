---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# TLS passthrough breaks behind an L7 load balancer on ACP ALB ingress

## Issue

On Alauda Container Platform the cluster ingress is served by ALB (`alb2`); the running data plane is the `global-alb2` instance in the `cpaas-system` namespace, registered through the `global-alb2` IngressClass with controller `cpaas.io/alb2`, and live Ingresses are fronted by this class. A TLS-passthrough configuration forwards the encrypted TLS connection unchanged to the backend service rather than terminating it at the ingress; on ALB this rides a frontend whose per-port protocol is `tcp` (L4) rather than `https` (L7), so the connection is passed through without being decrypted. When an external HTTP/HTTPS-terminating Layer-7 load balancer sits in front of this ingress, passthrough stops working and client requests fail to reach the intended backend.

## Root Cause

A passthrough frontend on ALB does not terminate TLS; the ALB frontend protocol is what selects L4 versus L7 handling, and on the `alb-nginx` data plane (image `registry.alauda.cn:60080/acp/alb-nginx:v4.3.1`, an nginx/openresty engine) a TCP frontend passes the TLS bytes through untouched. Because the connection is never decrypted at the ingress, the backend is chosen from the TLS Server Name Indication (SNI) value carried in the ClientHello instead of from inspected HTTP headers. ALB binds the backend selection to the requested host: a routing rule (`rules.crd.alauda.io`) matches on `spec.domain` (the hostname), and the matching certificate is keyed to that hostname, so the host/SNI value is what picks the backend and its TLS material.

An external Layer-7 load balancer operating in HTTP/HTTPS mode terminates the incoming TLS connection at the load balancer itself; ALB exhibits the same behavior in its L7 form, where a frontend with `protocol=https` and a bound `certificate_name` terminates TLS at the frontend. When the fronting L7 load balancer terminates TLS and then re-encrypts or forwards the request as a new connection, the original client SNI is lost or altered before traffic reaches the ingress. Since the ingress relies on SNI to select the passthrough backend, a lost or altered SNI leaves the request unmatched and the client request fails.

## Resolution

Keep TLS passthrough end-to-end by ensuring nothing in front of the ingress decrypts the connection. Configure the ALB ingress frontend in TCP/L4 mode so it forwards the encrypted connection unchanged and selects the backend by SNI; the frontend per-port protocol is the knob that determines L4 versus L7 handling, and only the L4/`tcp` form preserves passthrough. Any external load balancer placed in front of the cluster ingress must likewise operate at Layer 4 / TCP so the TLS connection and the client SNI reach ALB intact; a fronting load balancer that terminates and re-encrypts at Layer 7 strips the SNI the ingress needs and breaks passthrough.

The ALB frontend protocol that governs this is observable per port — for example the running `global-alb2` exposes `global-alb2-00080` as `http` and `global-alb2-00443` as `https`; a passthrough port is instead defined with `protocol=tcp` so TLS is forwarded rather than terminated.

Where Layer-7 fronting and TLS termination are an explicit requirement, the alternative is to terminate TLS at the ALB frontend itself rather than passing it through: the per-port frontend protocol is the selector here too — a frontend defined with `protocol=https` and a bound `certificate_name` terminates TLS at the ingress, while a `protocol=tcp` frontend passes it through. The ALB also exposes a configurable SSL strategy field (`alb2.spec.config.defaultSSLStrategy`), but it is the per-port frontend protocol that decides terminate-vs-passthrough. In the L7-terminating mode backend selection no longer depends on an intact end-to-end SNI, because the ingress is the TLS endpoint.

## Diagnostic Steps

Confirm which mode the ingress frontend is in. The ALB frontend's per-port protocol determines whether TLS is terminated (`https`, L7) or passed through (`tcp`, L4); inspect the `global-alb2` frontend definitions in `cpaas-system` to see the protocol bound to the listening port.

```bash
kubectl get frontend -n cpaas-system -l alb2.cpaas.io/name=global-alb2 \
  -o custom-columns=NAME:.metadata.name,PORT:.spec.port,PROTOCOL:.spec.protocol
```

Confirm the routing rule keys backend selection on the hostname. ALB selects the backend by matching the requested host against a rule's `spec.domain`, and the rule's certificate is bound to that same hostname, so a request arriving without the original SNI does not match the host-keyed rule.

```bash
kubectl get rule.crd.alauda.io -n cpaas-system \
  -o custom-columns=NAME:.metadata.name,DOMAIN:.spec.domain,CERT:.spec.certificate_name
```

When the symptom only appears with the external load balancer in the path, the lost or altered SNI introduced by an L7 terminating front is the discriminator: passthrough requires the SNI to survive end to end, and an L7 load balancer that terminates and re-encrypts the connection does not preserve it (kube v1.34.5, ALB data plane `registry.alauda.cn:60080/acp/alb2:v4.3.1`).

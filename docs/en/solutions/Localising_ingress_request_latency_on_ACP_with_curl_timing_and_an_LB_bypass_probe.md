---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500233
---

# Localising ingress request latency on ACP with curl timing and an LB-bypass probe

## Issue

Slow or intermittently slow HTTPS requests that arrive over the ingress wildcard domain can have their delay introduced at one of several distinct hops on the path between client and backend: the external load balancer that sits in front of the cluster, the ingress data-plane pods that terminate the request, or the backend application itself. On Alauda Container Platform the in-cluster ingress data plane is the ALB front of class `global-alb2` (controller `cpaas.io/alb2`), reachable on its node host address (the `ADDRESS` shown for Ingress objects on that class), with the HTTPS listener served by the ALB frontend `global-alb2-00443` on port 443; the external load balancer, by contrast, is not a cluster object and can only be observed indirectly through the timing comparison below.

## Root Cause

Because the external load balancer is outside the cluster and the ingress data plane is inside it, a single end-to-end timing measurement cannot, on its own, say which hop is responsible for elevated latency. Where the latency originates is localised by sending the same HTTP probe two ways — once through the external load balancer along the normal client path, and once bypassing it so the request lands directly on the ingress data-plane pod — and reading which of the two paths carries the elevated timing.

## Resolution

Use `curl` with `--write-out` to expose per-request timing for each path. The fields `%{time_connect}` and `%{time_total}` give the TCP-connect time and the total request time, and `%{remote_ip}`, `%{local_ip}` and `%{response_code}` confirm which endpoint actually answered; this instrumentation is libcurl-generic and works in any image that ships `curl`, with no platform-specific dependency. A typical probe form is:

```bash
curl -sS -o /dev/null \
  -w 'connect=%{time_connect} total=%{time_total} remote=%{remote_ip} local=%{local_ip} code=%{response_code}\n' \
  https://<ingress-host>/
```

The through-the-load-balancer probe resolves the endpoint hostname normally via DNS, so the request traverses the external load balancer before reaching the ingress data plane. A standing platform Ingress published on the `global-alb2` class (its host answers on the ingress address, port 443) makes a convenient always-present target for this leg, since it is reachable on the same wildcard ingress path that application traffic uses.

The bypass probe pins the same hostname to a chosen ingress data-plane pod IP with `curl --resolve <host>:443:<ingress_pod_ip>`, so the identical request is sent straight to that pod and skips the external load balancer entirely. The pod IPs to pin against are the node host addresses of the ALB data-plane pods, which on ACP are enumerated directly with `kubectl`, reading the host IP from the data-plane pods (label `service_name=alb2-global-alb2`) in the `cpaas-system` namespace:

```bash
kubectl get pod -n cpaas-system -l service_name=alb2-global-alb2 \
  -o jsonpath='{range .items[*]}{.status.hostIP}{"\n"}{end}'
```

```bash
curl -sS -o /dev/null \
  --resolve <ingress-host>:443:<ingress_pod_ip> \
  -w 'connect=%{time_connect} total=%{time_total} remote=%{remote_ip} local=%{local_ip} code=%{response_code}\n' \
  https://<ingress-host>/
```

Comparing the two outputs localises the hop: if the through-LB probe shows high `time_connect`/`time_total` while the bypass probe to the ingress data-plane pods stays fast, the latency is attributable to the external load balancer rather than to the ingress pods or the backend.

## Diagnostic Steps

To capture intermittent latency rather than a single sample, run the comparison continuously from a pod that loops the `curl` command and logs each result. The pod shape is a plain `kubectl run` driving a `while` loop around the timing `curl`; reading the pod logs with timestamps then builds a latency timeline that exposes when the slow path appears. This pod shape is a valid Pod on Kubernetes v1.34.5 and carries no platform-specific dependency, since the timing is pure libcurl `--write-out`. The ALB data-plane container image on this platform is `registry.alauda.cn:60080/acp/alb-nginx:v4.3.1`.

```bash
kubectl run ingress-latency-probe --image=<image-with-curl> --restart=Never -- \
  sh -c 'while true; do \
    curl -sS -o /dev/null \
      -w "%(date)T connect=%{time_connect} total=%{time_total} code=%{response_code}\n" \
      https://<ingress-host>/; \
    sleep 5; done'
```

For a quick one-shot check without deploying anything, the same comparison can be run by `kubectl exec` into an existing pod that already ships `curl`, issuing the through-LB request and the `--resolve` bypass request back-to-back and comparing their reported timings.

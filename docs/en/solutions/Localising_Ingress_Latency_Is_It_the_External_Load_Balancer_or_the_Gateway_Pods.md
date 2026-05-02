---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

Requests to an application reachable at `*.apps.<cluster>.example.com` intermittently time out or slow down. The path in front of every exposed application typically has three hops:

```text
client → external load balancer (hardware or software LB) → ingress gateway pods → service pods
```

A single latency spike in any of those hops shows up the same way at the client: slow or failed HTTP. To fix it you have to localise it. The technique below spins up two long-running probes that sample the same URL:

- one **through** the external load balancer (the normal path),
- one **bypassing** the external load balancer, hitting each ingress gateway pod directly via TLS SNI.

If the bypass is fast but the LB-fronted probe is slow, the problem is the LB. If both are slow, the gateway pods (or what they are routing to) are at fault.

## Resolution

The probes run in a dedicated namespace so cleanup is a single `kubectl delete ns`.

1. **Create the workspace.**

   ```bash
   kubectl create namespace ingress-latency-probe
   ```

2. **Export the URL you want to probe and the gateway pod IPs.** Pick any reliable health endpoint that the gateway routes to — the cluster authentication `/healthz` is common, but any stable backend path works. For ACP the gateway pods live under the `cpaas-system` namespace; the dataplane pods (`global-alb2-*`) carry the label `alb2.cpaas.io/pod_type=alb`. The `alb-operator-ctl-*` pod is the controller and is not on the data path — do not point the bypass probe at it.

   ```bash
   URL=https://auth.apps.example.com/healthz

   GATEWAY_NS=cpaas-system       # ACP ALB namespace; edit for your platform
   GATEWAY_SELECTOR=alb2.cpaas.io/pod_type=alb

   GATEWAY_IPS=$(kubectl -n $GATEWAY_NS get pod -l $GATEWAY_SELECTOR \
                   -o jsonpath='{range .items[*]}{.status.hostIP}{"\n"}{end}' \
                 | sort -u)
   echo "$GATEWAY_IPS"
   ```

3. **Run the LB-fronted probe** — this is what your users see. It records per-request latency and HTTP response code:

   ```bash
   kubectl -n ingress-latency-probe run curl-lb --restart=Never \
     --image=curlimages/curl:8.10.1 --command -- sh -ec '
       while :; do
         curl -sk --noproxy "*" --connect-timeout 2 \
           -w "remote_ip=%{remote_ip} code=%{response_code} connect=%{time_connect} total=%{time_total}\n" \
           -o /dev/null "'$URL'" || true
         sleep 5
       done'
   ```

4. **Run the bypass probe** — same URL, but resolve the hostname to each gateway IP in turn via `curl --resolve`. TLS SNI still matches the certificate because the Host header and SNI host stay the same.

   ```bash
   kubectl -n ingress-latency-probe run curl-bypass --restart=Never \
     --image=curlimages/curl:8.10.1 --command -- sh -ec '
       HOST=$(printf "%s" "'$URL'" | awk -F/ "{print \$3}")
       while :; do
         for ip in '"$(echo $GATEWAY_IPS | tr "\n" " ")"'; do
           curl -sk --noproxy "*" --connect-timeout 2 \
             --resolve "$HOST:443:$ip" \
             -w "remote_ip=%{remote_ip} code=%{response_code} connect=%{time_connect} total=%{time_total}\n" \
             -o /dev/null "'$URL'" || true
         done
         sleep 5
       done'
   ```

5. **Compare the two.** Tail both logs for a few minutes while the issue is reproducing:

   ```bash
   kubectl -n ingress-latency-probe logs curl-lb     --tail=50 -f &
   kubectl -n ingress-latency-probe logs curl-bypass --tail=50 -f
   ```

6. **Interpret the result.**

   | `curl-lb` | `curl-bypass` | Conclusion |
   |---|---|---|
   | fast | fast | Latency originates further upstream of the LB — client network, DNS, or the client itself. |
   | slow | fast | External LB (or its health checks, SNAT rules, connection reuse) is the bottleneck. Work with the LB owner. |
   | fast | slow on one pod | That single gateway pod is degraded. Cordon/drain its node or restart the pod. |
   | slow | slow on every pod | The gateway plane or its downstream is the issue — check gateway pod CPU/memory, backend service latency, or cluster network. |

7. **Clean up** when the investigation is done:

   ```bash
   kubectl delete namespace ingress-latency-probe
   ```

## Diagnostic Steps

If both probes show clean runs but users still complain, the problem is almost certainly outside the path this probe covers. Useful next steps:

- Confirm the probe pods resolve the same DNS name the client does:

  ```bash
  kubectl -n ingress-latency-probe run curl-dns --rm -it \
    --image=curlimages/curl:8.10.1 --restart=Never \
    -- sh -c 'getent hosts auth.apps.example.com; nslookup auth.apps.example.com'
  ```

- Run a client-side trace from outside the cluster (`mtr`, `traceroute`) to rule out an upstream WAN issue.

- For the LB-fronted side, have the LB owner capture packets on its ingress side while the probe is running; a parallel capture on the gateway pod node confirms where the delay is introduced.

- Check the gateway's own metrics: request rate, request duration P99, pod CPU throttling, upstream RTT. A degraded backend looks identical to a slow gateway from the probe's perspective — `--bypass` does not isolate gateway-vs-backend, only LB-vs-gateway.

Treat the probe pods as short-lived. Leaving them running indefinitely is fine operationally but the loop runs forever — delete the namespace when finished to avoid surprise costs on the LB.

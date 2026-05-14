---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# \"rejected connection\" EOF Warnings in etcd Pod Logs Are TLS-Probe Noise
## Overview

The etcd pods in ACP's control plane periodically log `rejected connection` warnings with an `"error":"EOF"` tail and a `remote-addr` that points at another control-plane node. The warning repeats at irregular intervals — every few seconds to a few minutes — and can add up to a visible fraction of the etcd log volume on a busy cluster.

A typical line looks like this:

```text
{"level":"warn","ts":"2026-02-05T14:37:27.018363Z",
 "caller":"embed/config_logging.go:169",
 "msg":"rejected connection",
 "remote-addr":"10.128.0.250:52864",
 "server-name":"","error":"EOF"}
```

The observation is harmless on its own. Nothing in cluster health degrades, etcd quorum remains intact, request latencies do not rise, and no alert fires. The question operators ask is whether the line is a symptom of something that will fail later, or noise that can be filtered.

## Root Cause

The log entry is emitted by etcd's embedded gRPC/TLS server when a client terminates a TCP connection immediately after the TLS handshake completes — before sending the first byte of application data. Concretely:

1. The peer opens a TCP connection to etcd's serving port.
2. The TLS handshake succeeds; certificates are exchanged and validated.
3. The peer closes the TCP connection with an `EOF` without issuing any gRPC request.

From etcd's point of view, the handshake was fine but the client walked away. The `server-name` field is empty because the probe does not send an SNI header, and the `error` field records the `EOF` that the server read when it tried to consume the first gRPC frame.

The behaviour is driven by upstream `api-server` and `kube-controller-manager` components that perform TCP-level liveness/readiness checks against the etcd endpoint. They open a connection, complete the handshake to confirm the serving certificate is valid, and close without issuing a request — this is a cheap way to verify that etcd is accepting TLS traffic without consuming any API quota or writing to the raft log.

The same pattern can also arise from:

- Node-level health probes (e.g. a kubelet readiness probe against the etcd static pod's probe endpoint).
- External monitoring tools that port-scan the control plane.
- etcd's own peer-to-peer handshake when a member re-establishes a peer connection during raft leader elections.

None of these represent a data-plane fault. The etcd server side is simply reporting that a peer spoke TLS and then hung up.

## Resolution

No corrective action is needed on a healthy cluster. The warnings are informational and do not indicate a broken TLS chain, an authentication failure, or a peer partition. Confirm cluster health once, then either ignore the warnings or filter them at the log-collection layer if they create noise in downstream tooling.

### Confirm cluster health

Run the following checks and proceed only if all three pass:

```bash
# 1. etcd endpoint health — every member reports HEALTH=true.
#    etcdctl in the etcd pod requires the peer certificate bundle that
#    the static pod mounts under /etc/kubernetes/pki/etcd/.
POD=$(kubectl -n kube-system get pod -l component=etcd \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n kube-system exec "$POD" -- etcdctl \
  --endpoints https://127.0.0.1:2379 \
  --cacert /etc/kubernetes/pki/etcd/ca.crt \
  --cert   /etc/kubernetes/pki/etcd/peer.crt \
  --key    /etc/kubernetes/pki/etcd/peer.key \
  endpoint health --cluster

# 2. API server readyz — non-empty output means each gate returns 'ok'.
kubectl get --raw=/readyz?verbose

# 3. No Degraded/Progressing conditions on the cluster's etcd operator
#    (or equivalent control-plane component managed by the platform).
kubectl get co etcd -o jsonpath='{range .status.conditions[*]}{.type}={.status}{"\n"}{end}' 2>/dev/null \
  || kubectl -n kube-system get pod -l component=etcd \
       -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\n"}{end}'
```

If all three return healthy state, the `rejected connection` lines are safe to ignore.

### Filter the warning at the collection layer

When the log volume from these lines is a problem for downstream indexing or alerting, drop them at ingest rather than editing etcd's verbosity (which also suppresses genuinely useful lines). A field-based filter is the simplest form:

```yaml
# Example filter applied by the cluster's log forwarder / collector stack.
# Drops etcd pod entries whose message is exactly the probe-close warning.
- drop:
    match:
      kubernetes.container_name: etcd
      message: 'rejected connection'
      error: 'EOF'
```

Keep the filter conditional on `error=EOF` so that genuine TLS errors (expired certificate, unknown CA, version mismatch) still reach the log system — those produce a different `error` string and are **not** safe to ignore.

### When the warning is not noise

A cluster that is actually unhealthy will show the same line **together** with one of the following, and this is the case that needs investigation:

- etcdctl endpoint health returns FAIL or timeout for any member.
- API server `/readyz` fails the `etcd` gate (`[-]etcd failed`).
- The frequency of `rejected connection` jumps by an order of magnitude after a control-plane event (certificate rotation, member restart, network flap) and does not recede.
- The error field in the log line is not `EOF` — values like `tls: bad certificate`, `remote error: tls: handshake failure`, or `x509: certificate has expired` indicate a real TLS fault and need the corresponding certificate or trust-bundle fix.

These signatures point at a different root cause and should be triaged independently; do not attribute them to the probe-noise pattern this note describes.

## Diagnostic Steps

Count the warnings over a bounded window to distinguish baseline probe noise from a real burst:

```bash
POD=$(kubectl -n kube-system get pod -l component=etcd \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n kube-system logs --since=10m "$POD" \
  | grep -c '"msg":"rejected connection"'
```

On a steady-state cluster the count is proportional to the number of probers times the number of etcd members — tens to low hundreds of entries over a ten-minute window is typical. A count three or more orders of magnitude higher, or a sudden change between consecutive windows, is the signal to investigate further.

Identify which peers are probing. The `remote-addr` field in the warning carries the source IP:

```bash
kubectl -n kube-system logs --since=10m "$POD" \
  | grep '"msg":"rejected connection"' \
  | sed -n 's/.*"remote-addr":"\([^"]*\)".*/\1/p' \
  | awk -F: '{print $1}' | sort | uniq -c | sort -rn
```

Each IP should resolve to a control-plane node or a known monitoring endpoint:

```bash
kubectl get node -o wide | awk '{print $1, $6}'
```

If an IP cannot be identified, it may be an external scanner that happens to reach the etcd serving port — tighten the network policy guarding the control-plane nodes, since etcd's serving port should never be exposed outside the cluster's management network.

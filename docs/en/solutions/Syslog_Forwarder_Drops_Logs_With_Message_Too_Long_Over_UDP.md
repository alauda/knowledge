---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The cluster log collector — Vector or, on older platform releases, Fluentd — fails to forward a subset of log records to a downstream syslog server. The collector emits a `Message too long` error for each oversize record and a high-error-rate alert (`CollectorHighErrorRate` / `FluentDHighErrorRate`) appears on the platform monitoring stack.

For Vector:

```text
ERROR sink{component_kind="sink" component_id=output_rsyslog_*
            component_type=socket}:
  vector::internal_events::socket: Error sending data.
  error=Message too long (os error 90) error_code="socket_send"
  error_type="writer_failed" stage="sending" mode=udp
```

For Fluentd:

```text
[warn]: [syslog] failed to flush the buffer.
  chunk="..." error_class=Errno::EMSGSIZE
  error="Message too long - sendto(2) for \"<host>\" port 514"
```

The collector retries (and keeps re-failing) on the same chunks, so disk-buffered backlog grows until the collector either drops the records or runs out of buffer.

## Root Cause

The forwarder's `syslog` output is using UDP. UDP is a single-datagram-per-write transport: the kernel cannot fragment an oversize application payload into multiple syslog packets, so when the rendered record exceeds the path's MTU-derived UDP payload limit, the `sendto(2)` call returns `EMSGSIZE` and the record is rejected at the kernel boundary, before it ever reaches the downstream collector.

The two syslog standards cap message size at very different points:

- **RFC 3164** ("BSD syslog") — total packet length ≤ **1024 bytes**.
- **RFC 5424** (structured syslog) — total packet length ≤ **2048 bytes** for UDP transport.

ACP container logs routinely exceed both limits: a single Java stack trace, a JSON-formatted application log, or a long Kubernetes audit record can be 8–32 KiB. UDP gives no way to chunk the record across packets the way TCP would, and Vector's socket sink does not expose a `maxWrite` knob that would let the operator request payload truncation — that option is rejected at parse time.

The fix is therefore at the transport, not at the record size: switch the syslog output to TCP and, where possible, to RFC 5424.

## Resolution

1. **Inspect the current forwarder configuration.** ACP's `observability/log` surface (and the **Logging Service** extension) reconciles a `ClusterLogForwarder` resource that maps cluster log streams to one or more outputs. Locate the syslog output in the running CR:

   ```bash
   kubectl -n cluster-logging get clusterlogforwarders.logging.k8s.io \
     instance -o yaml | sed -n '/outputs:/,/pipelines:/p'
   ```

   A line of the form `url: udp://<host>:514` confirms the diagnosis.

2. **Switch the output to TCP / RFC 5424.** Edit the same CR and replace the UDP URL with a TCP one. Pin `rfc: RFC5424` so the structured framing is used end-to-end.

   ```yaml
   apiVersion: logging.k8s.io/v1
   kind: ClusterLogForwarder
   metadata:
     name: instance
     namespace: cluster-logging
   spec:
     outputs:
       - name: syslog
         type: syslog
         syslog:
           rfc: RFC5424
           facility: user
           severity: informational
         url: tcp://<syslog-host>:514
     pipelines:
       - name: forward-to-syslog
         inputRefs:
           - application
         outputRefs:
           - syslog
   ```

   Apply the change. The collector DaemonSet picks up the new sink configuration on its next reconcile (a few seconds for Vector, up to a minute for Fluentd) and reopens the connection over TCP.

3. **Confirm the downstream syslog server accepts TCP on the chosen port.** Many existing receivers listen on UDP/514 by default and need a separate TCP/514 (or TCP/6514 for TLS) listener enabled. From a debug pod:

   ```bash
   kubectl run -it --rm netcheck \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     --restart=Never -- nc -vz <syslog-host> 514
   ```

   `open` confirms the listener is reachable. If the receiver only speaks UDP, raising its MTU does **not** fix the problem — even a fully MTU-correct UDP path still tops out at the protocol-level cap (1024 / 2048 bytes).

4. **Add TLS where the receiver supports it.** TCP syslog typically pairs with `tcp+tls://...` in the URL and a Secret holding the CA bundle (and optional client cert) referenced under `secret.name` on the output. Encrypting the transport is essentially free once TCP is in use.

5. **Consider an in-cluster aggregator for very large records.** Where the downstream syslog server is firmly UDP-only, deploy an in-cluster syslog relay (Vector, rsyslog, or syslog-ng configured for both transports) that accepts TCP from the platform forwarder and re-emits to UDP only the records small enough to survive the cap, dropping or truncating the rest in a controlled way.

6. **Do not reach for `maxWrite` on Vector syslog outputs.** The collector validates outputs at admission and rejects unknown tuning fields on the syslog sink; configuration applied this way will simply not be reconciled. Truncation has to be done upstream of the sink (a `transforms.remap` step, for example) if it is needed at all.

## Diagnostic Steps

Watch collector errors aggregate by sink and protocol:

```bash
kubectl -n cluster-logging get pods -l component=collector -o name \
  | xargs -I{} kubectl -n cluster-logging logs {} --tail=200 \
  | grep -E 'Message too long|EMSGSIZE'
```

For Vector specifically, the internal metrics endpoint exposes the failure counter directly:

```bash
POD=$(kubectl -n cluster-logging get pods -l component=collector \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n cluster-logging exec $POD -- \
  curl -sS http://127.0.0.1:8686/metrics \
  | grep -E 'component_errors_total.*output_rsyslog|component_errors_total.*syslog'
```

A non-zero, climbing counter is the live evidence of the drop. After switching the output to TCP, the counter should plateau and then stop incrementing within one or two reconcile intervals; the alert clears after its `for:` duration elapses.

Validate end-to-end delivery by emitting a deliberately large record and grepping for it on the receiver:

```bash
kubectl run -it --rm bigrecord --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  --restart=Never -- /bin/sh -c '
    echo "BIGRECORD:$(yes A | head -c 8192)"
  '
```

A matching `BIGRECORD:` line appearing on the syslog receiver confirms the new TCP path carries records well above the old UDP cap.

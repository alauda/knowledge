---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

The log-collection agents that the ACP observability stack uses (Vector and, for legacy pipelines, Fluentd) can accept logs pushed to them from external sources via HTTP and Syslog "input receivers." Operators sometimes want to re-use the same cluster-local collector pool as a general-purpose ingestion endpoint for workloads that are not running as pods on the same cluster — for example, a VM fleet, a legacy appliance, or a sibling cluster's control plane. This article describes the scenarios in which enabling those receivers is the intended design, and the scenarios in which it is outside the collector's supported scope.

Both receivers are configured through the same `ClusterLogForwarder` mechanism that drives output routing. A receiver is declared as an `input` of type `http` or `syslog`, exposed through a Service, and referenced from a `pipeline` that forwards to the desired destination (LokiStack, an external SIEM, or an object store).

## Supported scenarios

Enabling HTTP or Syslog input receivers on the cluster logging collector is considered part of the supported design only in the following cases:

1. **Receiving logs from a hosted control plane whose workers run elsewhere.** A hosted control plane (HCP) hosts its control-plane components — API server, controller manager, scheduler — as workloads inside a management cluster, and the guest worker nodes live on separate infrastructure. The collector running on the management cluster is the natural aggregation point for logs emitted by the guest's audit and component processes. This topology is supported and is the primary driver for shipping the receivers in the first place.

2. **Receiving logs from a platform-adjacent product running on the same ACP cluster** whose log output is not a native container stdout/stderr stream. Typical examples are:

   - The ACP virtualization stack, where VM guest application logs are forwarded from the guest OS into the same cluster's collector through a Syslog pipe.
   - Other platform services that surface logs over HTTP / Syslog because they run as VMs or appliances alongside the cluster, not as pods.

   In these cases the receiver is an integration point between two first-party components that the cluster is already running, and operating it through `ClusterLogForwarder` is the sanctioned path.

## Out-of-scope scenarios

Using the cluster logging collector's HTTP / Syslog receivers as a general third-party log ingestion endpoint — that is, as a cluster-owned replacement for a dedicated log aggregator — is outside the supported design. Concretely, the following are not covered:

- Arbitrary external applications (non-ACP-aligned products) pushing logs into the collector from outside the cluster for convenience.
- Hardware appliances or network devices writing Syslog to a receiver exposed by the cluster's collector as a substitute for a purpose-built log aggregator.
- Any scenario where the receiver is load-balanced behind a public endpoint for multi-tenant external producers.

For those use cases, stand up a purpose-built log aggregation system (a dedicated Vector / Fluentd / rsyslog deployment separate from the cluster's observability collector, or a commercial aggregator) and forward its output into the ACP logging stack at the far end. That keeps the collector's receiver scope narrow and its failure modes tied to first-party producers only.

## Resolution

Adopt the following rule of thumb when deciding whether to enable an input receiver on the cluster's logging collector:

- The log producer is either a hosted control plane that belongs to the same platform, or a first-party ACP service running alongside the cluster that cannot expose container-native stdout/stderr. Enable the receiver through `ClusterLogForwarder`.
- The log producer is anything else. Use a dedicated aggregator and forward its output into the cluster logging stack as one more upstream source — do not expose the cluster-level receiver directly.

Reference configuration for a supported pipeline (Vector-based collector receiving Syslog input from a first-party virtualization service on the same cluster and forwarding into LokiStack):

```yaml
apiVersion: logging.alauda.io/v1
kind: ClusterLogForwarder
metadata:
  name: collector
  namespace: <logging-namespace>
spec:
  inputs:
    - name: vm-syslog
      type: syslog
      syslog:
        rfc: RFC5424
  outputs:
    - name: default-lokistack
      type: lokiStack
      lokiStack:
        target:
          name: <lokistack-name>
          namespace: <logging-namespace>
  pipelines:
    - name: vm-to-loki
      inputRefs:
        - vm-syslog
      outputRefs:
        - default-lokistack
```

The exact API group used for `ClusterLogForwarder` depends on the logging-stack release installed on the cluster — consult the ACP logging service documentation for the group/version pairing that matches the installed operator. The spec structure above (`inputs` / `outputs` / `pipelines`) is stable across releases.

When the input is HTTP rather than Syslog, swap `type: syslog` for `type: http` and configure the listen port accordingly. In both cases, front the receiver with a `Service` inside the logging namespace and restrict who can reach it through `NetworkPolicy` — the receiver is intended as an intra-cluster aggregation point, not as an internet-facing ingestion URL.

## Diagnostic Steps

1. Confirm the intended topology matches one of the two supported scenarios before enabling the receiver. If the source is external and not a first-party platform component, re-evaluate whether a dedicated aggregator is the correct architecture.

2. Once the receiver is configured, verify the collector pods have picked up the input definition:

   ```bash
   kubectl -n <logging-namespace> get clusterlogforwarder collector -o yaml \
     | sed -n '/spec:/,/status:/p'
   kubectl -n <logging-namespace> get pods -l app.kubernetes.io/component=collector
   ```

3. Check that the Service exposing the receiver is listening on the expected port and that clients inside the cluster can reach it:

   ```bash
   kubectl -n <logging-namespace> get svc
   kubectl -n <logging-namespace> exec -it <collector-pod> -- \
     ss -ltn | grep -E "8443|514|601"
   ```

4. Watch the collector log for receiver-side errors (malformed payloads, TLS handshake failures, authentication rejects):

   ```bash
   kubectl -n <logging-namespace> logs <collector-pod> \
     | grep -Ei "receiver|syslog|http"
   ```

5. Correlate the receiver throughput with the downstream Loki ingester's acceptance rate via Prometheus (`vector_events_in_total`, `loki_distributor_lines_received_total`) so that any pile-up between the two is caught before it becomes a back-pressure incident.
</content>
</invoke>
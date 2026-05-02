---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# node_exporter Exposes Fibre Channel Metrics Because the Collector Is on by Default
## Overview

`node_exporter` surfaces a `--collector.fibrechannel` metrics group on clusters where the monitoring stack ships an unmodified upstream build. Operators sometimes flag this during scrape review — the metrics appear even on clusters that have no Fibre Channel HBAs — and wonder whether the collector was enabled by cluster configuration or is always on.

The short answer: the Fibre Channel collector is one of `node_exporter`'s default-on collectors. The exporter ships with a fixed list of collectors it auto-enables; `fibrechannel` is on that list, alongside the common ones like `cpu`, `filesystem`, `netdev`, and `diskstats`. When the platform installs `node_exporter` through the cluster monitoring stack (Prometheus Operator managing a `DaemonSet`), the default set is what ends up running unless the deployment is explicitly narrowed.

Metrics emitted by this collector all live under the `node_fibrechannel_*` prefix — for example `node_fibrechannel_fabric_name`, `node_fibrechannel_port_speed_bytes`, `node_fibrechannel_node_name`. On a host without Fibre Channel hardware the collector reports zero series (or just the `node_scrape_collector_success{collector="fibrechannel"} 1` probe entry), so it is essentially free in terms of Prometheus storage. It does cost one extra pass over `/sys/class/fc_host` per scrape.

## Resolution

Two paths are available depending on how the monitoring stack is installed.

### ACP monitoring stack (observability/monitor)

ACP's in-core monitoring (`observability/monitor`) and the separate Logging/Observability extensions install `node_exporter` through the Prometheus Operator chain. The DaemonSet is reconciled by an operator, so hand-editing the pod spec is reverted on the next reconcile. The clean way to narrow the collector set is through the monitoring stack's configuration surface (typically a `ClusterMonitorConfig` or equivalent CR, or a values bundle held by the operator). Add explicit `--no-collector.fibrechannel` (or the equivalent toggle for whatever collectors are undesired) to the `nodeExporter` section of the config.

Before disabling the collector, check whether downstream alerts or dashboards reference `node_fibrechannel_*`. The default bundles for ACP monitoring do not, but any operator-added dashboards might.

### Vanilla Prometheus Operator (OSS fallback)

On a plain Kubernetes cluster that runs `kube-prometheus-stack` or an equivalent chart directly, edit the chart values so the rendered `DaemonSet` drops the collector:

```yaml
# Chart: prometheus-community/kube-prometheus-stack
prometheus-node-exporter:
  extraArgs:
    - --no-collector.fibrechannel
```

If the deployment shape is custom, the same flag goes on the `node_exporter` container's `args` list. `node_exporter --help` lists the full set of `--no-collector.<name>` toggles; everything defaulted on can be defaulted off this way.

## Diagnostic Steps

Confirm which collectors the running `node_exporter` considers successful on a given node. Every exporter instance publishes a `node_scrape_collector_success` gauge per collector, which is the cleanest way to observe the active set without reading flags off the pod spec:

```bash
# Pick one node-exporter pod from the monitoring DaemonSet
POD=$(kubectl -n monitoring get pod \
  -l app.kubernetes.io/name=node-exporter \
  -o jsonpath='{.items[0].metadata.name}')

# Metric endpoint — node_exporter listens on 9100 by default
kubectl -n monitoring exec "$POD" -- \
  wget -qO- http://localhost:9100/metrics | \
  grep '^node_scrape_collector_success'
```

A line of the form:

```text
node_scrape_collector_success{collector="fibrechannel"} 1
```

means the collector executed successfully during the last scrape. `0` means it ran but hit an error parsing sysfs; absence of the line means the collector is not enabled. Use the same endpoint to confirm no `node_fibrechannel_*` series are actually emitted on nodes without Fibre Channel hardware.

For a view of which collectors the running binary was invoked with, inspect the pod spec directly:

```bash
kubectl -n monitoring get daemonset <node-exporter-daemonset> \
  -o jsonpath='{.spec.template.spec.containers[*].args}{"\n"}'
```

Look for `--collector.*` and `--no-collector.*` flags. The combination defines the final set; the precedence rules are documented in `node_exporter --help`.

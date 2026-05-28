---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Fibre Channel collector enabled by default on ACP node-exporter

## Issue

On Alauda Container Platform the node-exporter DaemonSet shipped by the prometheus module plugin (kube-prometheus chart v4.3.3, sub-chart exporter-node, in the `cpaas-system` namespace) runs the upstream node_exporter binary v1.11.1 from image tag `node-exporter:v1.11.1-v4.3.4`. Its container arguments are `--web.config.file`, `--path.rootfs=/host`, `--no-collector.ipvs`, and `--collector.processes` — there is no `--no-collector.fibrechannel` among them, so the `fibrechannel` collector keeps its upstream default-enabled state. The collector therefore runs on every node in the cluster, which raises the question of whether it produces any useful data on hosts that have no Fibre Channel hardware.

## Root Cause

The `fibrechannel` collector reads Fibre Channel host attributes from `/sys/class/fc_host`, so it only produces meaningful series on hosts that actually have Fibre Channel HBAs. The collector is enabled by default — the node-exporter DaemonSet arguments carry no `--no-collector.fibrechannel` flag. On nodes without that hardware — for example KVM virtual machines — the collector stays enabled but, with no `/sys/class/fc_host` entries to read, emits no Fibre Channel series. The collector is thus inert rather than harmful on such hosts: it is on by default, but contributes nothing on a node where no FC HBA exists.

## Resolution

Where the `fibrechannel` collector should be switched off explicitly — for instance to keep the enabled collector set minimal on clusters that will never have Fibre Channel hardware — pass the `--no-collector.<name>` flag for that collector in the node-exporter command-line arguments. For the Fibre Channel collector this is `--no-collector.fibrechannel`. This is the same flag mechanism already in use on the ACP node-exporter DaemonSet, which disables the ipvs collector with `--no-collector.ipvs`; adding `--no-collector.fibrechannel` to the argument list turns the Fibre Channel collector off the same way.

Because the argument list is part of the node-exporter DaemonSet rendered by the kube-prometheus chart, change the collector flags through the prometheus module plugin configuration that owns the chart rather than editing the rendered DaemonSet directly, so the change survives reconciliation.

## Diagnostic Steps

The node-exporter metrics endpoint is served on container port 9100 (named `metrics`). On ACP this endpoint is served over HTTPS with basic authentication configured through the node-exporter `web.config.file`, so reaching it requires the TLS scheme and credentials rather than a plain unauthenticated request.

To confirm the collector's enabled/disabled state, inspect the node-exporter DaemonSet arguments rather than querying Prometheus. Note that on ACP the prometheus ServiceMonitor keep-list drops `node_fibrechannel_*` series before ingest, so an empty result for that prefix in Prometheus does not indicate the absence of FC hardware — it is dropped at scrape time regardless. The absence of `--no-collector.fibrechannel` from the argument list means the collector is at its default-enabled state; the presence of `--no-collector.ipvs` shows the disable flag mechanism in effect for another collector:

```bash
kubectl -n cpaas-system get daemonset kube-prometheus-exporter-node \
  -o jsonpath='{.spec.template.spec.containers[*].args}'
```

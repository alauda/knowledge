---
products: 
  - Alauda Container Platform
kind:
  - Solution
---

# How to Add Metrics for Monitoring Collection

## Issue

If the allowlist in ServiceMonitor is directly modified to add metrics for Prometheus to collect, more metric data can be gathered for both Prometheus and VictoriaMetrics systems. However, this poses a risk: platform upgrades may cause ServiceMonitor to fail to update due to ResourcePatch(RPCH), resulting in failures in the integrated Prometheus and VictoriaMetrics monitoring.

## Environment Information

Applicable Versions: 4.0.x,4.1.x

## Supported Platform Components

* exporter-coredns
* exporter-kube-controller-manager
* exporter-kube-dns
* exporter-kube-etcd
* exporter-kube-scheduler
* exporter-kube-state
* exporter-kubelets
* exporter-kubernetes
* exporter-node

> **Note**  
> For the VictoriaMetrics monitoring plugin, the resource type corresponding to exporter-kubelets is `VMNodeScrape`, rather than `ServiceMonitor`.

## Modification Steps

Log in to the master node of the global cluster and modify the MInfo resource of Prometheus/Victoriametrics to add additionalKeepMetrics.

### Step 1: Retrieve the corresponding ModuleInfo(minfo)

If the monitoring component is Prometheus

```shell
kubectl get minfo -A | grep prometheus | grep <cluster-name>
```

If the monitoring component is Victoriametrics

```shell
kubectl get minfo -A | grep victoriametrics  | grep <cluster-name>
```

### Step 2: Edit the MInfo resource

```shell
kubectl edit minfo <minfo-name>
```

Add the following content under spec, replacing <component-name> with the target component and <metric> with the metric to be added (ensure the metric is exposed by the component):
If the monitoring component is Prometheus

```yaml
spec:
  valuesOverride:
    ait/chart-kube-prometheus:
      <component-name>:
        additionalKeepMetrics:
        - XXX
```

If the monitoring component is Victoriametrics

```yaml
spec:
  valuesOverride:
    ait/chart-victoriametrics:
      <component-name>:
        additionalKeepMetrics:
        - XXX
```

Example: Adding IPVS-related metrics for exporter-node

If the monitoring component is Prometheus

```yaml
spec:
  valuesOverride:
    ait/chart-kube-prometheus:
      exporter-node:
        additionalKeepMetrics:
        - node_ipvs_connections_total
        - node_ipvs_incoming_packets_total
        - node_ipvs_outgoing_packets_total
        - node_ipvs_incoming_bytes_total
        - node_ipvs_outgoing_bytes_total
        - node_ipvs_backend_connections_active
        - node_ipvs_backend_connections_inactive
        - node_ipvs_backend_weight
```

If the monitoring component is Victoriametrics

```yaml
spec:
  valuesOverride:
    ait/chart-victoriametrics:
      exporter-node:
        additionalKeepMetrics:
        - node_ipvs_connections_total
        - node_ipvs_incoming_packets_total
        - node_ipvs_outgoing_packets_total
        - node_ipvs_incoming_bytes_total
        - node_ipvs_outgoing_bytes_total
        - node_ipvs_backend_connections_active
        - node_ipvs_backend_connections_inactive
        - node_ipvs_backend_weight
```

After configuration changes, ensure the AppRelease (AR) is updated and the monitoring component status is Ready:

```shell
kubectl -n cpaas-system get ars
```

## Verification Steps

Access the Prometheus UI page via `https://<platform-domain>/clusters/<cluster-name>/prometheus-0`, then query the additional metrics added through the aforementioned operation on the UI page. If data is returned normally, it confirms that the modification has taken effect.

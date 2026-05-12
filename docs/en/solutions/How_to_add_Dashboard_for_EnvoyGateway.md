---
kind:
   - How To
products:
  - Alauda Container Platform
ProductsVersion:
   - 4.2.x and later
---

# How to Add Dashboards for EnvoyGateway

## Overview

This document describes how to add monitoring dashboards for EnvoyGateway after EnvoyGateway has been installed in a target cluster.

The procedure creates the following resources:

- `envoygateway-adminspace-control-panel-dashboard`: the dashboard for EnvoyGateway control plane metrics.
- `envoygateway-adminspace-data-panel-dashboard`: the dashboard for Envoy proxy data plane metrics.
- `envoy-gateway-controlplane-monitoring`: the PodMonitor used to collect EnvoyGateway control plane metrics.
- `envoy-gateway-proxy-monitoring`: the PodMonitor used to collect Envoy proxy data plane metrics.

## Environment Information

Applicable Versions: ACP 4.2.x and later

## Prerequisites

Before applying the dashboard manifest, ensure that the following conditions are met:

- EnvoyGateway has been installed in the corresponding cluster.
- You can access the cluster with `kubectl` and have permission to create `MonitorDashboard` and `PodMonitor` resources in the `cpaas-system` namespace.
- The monitoring stack in the cluster supports `PodMonitor` resources.

## Operational Steps

### Step 1: Create the EnvoyGateway dashboard manifest

Save the following content as `envoy-gateway-dashboard.yaml`:

```yaml
apiVersion: ait.alauda.io/v1alpha2
kind: MonitorDashboard
metadata:
  labels:
    cpaas.io/dashboard.folder: container-platform
    cpaas.io/dashboard.is.home.dashboard: "false"
    cpaas.io/dashboard.tag.built-in: "true"
    cpaas.io/dashboard.tag.applications: "true"
    cpaas.io/published: "true"
  name: envoygateway-adminspace-control-panel-dashboard
  namespace: cpaas-system
spec:
  body:
    panels:
      # --- Watching Components ---
      - fieldConfig:
          defaults:
            custom:
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: green
                  value: "0"
        gridPos:
          h: 7
          id: watch-depth
          w: 8
          x: 0
          "y": 0
        id: watch-depth
        targets:
          - expr: sum by(runner) (watchable_depth{namespace=~"$namespace"})
            legendFormat: '{{.runner}}'
            refId: depth
        title: Watch Depth by Runner
        type: stat
      - fieldConfig:
          defaults:
            custom:
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: green
                  value: "0"
        gridPos:
          h: 7
          id: subscribe-status
          w: 8
          x: 8
          "y": 0
        id: subscribe-status
        targets:
          - expr: sum by(status,runner) (watchable_subscribe_total{namespace=~"$namespace"})
            legendFormat: '{{.runner}}/{{.status}}'
            refId: sub
        title: Subscribe Status
        type: stat
      - fieldConfig:
          defaults:
            custom:
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: green
                  value: "0"
        gridPos:
          h: 7
          id: panics
          w: 8
          x: 16
          "y": 0
        id: panics
        targets:
          - expr: sum(watchable_panics_recovered_total{namespace=~"$namespace"})
            legendFormat: recovered
            refId: panics
        title: Recovered Panics
        type: stat
      # --- Status Updater ---
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
          overrides: []
        gridPos:
          h: 7
          id: status-update-total
          w: 8
          x: 0
          "y": 7
        id: status-update-total
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(kind) (status_update_total{namespace=~"$namespace"})
            legendFormat: '{{.kind}}'
            refId: total
        title: Status Updates by Kind
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
          overrides: []
        gridPos:
          h: 7
          id: status-update-status
          w: 8
          x: 8
          "y": 7
        id: status-update-status
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(status) (status_update_total{namespace=~"$namespace"})
            legendFormat: '{{.status}}'
            refId: status
        title: Status Updates by Status
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
            unit: s
          overrides: []
        gridPos:
          h: 7
          id: status-update-duration
          w: 8
          x: 16
          "y": 7
        id: status-update-duration
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: histogram_quantile(0.99, sum by(le) (rate(status_update_duration_seconds_bucket{namespace=~"$namespace"}[2m])))
            legendFormat: p99
            refId: p99
          - expr: histogram_quantile(0.9, sum by(le) (rate(status_update_duration_seconds_bucket{namespace=~"$namespace"}[2m])))
            legendFormat: p90
            refId: p90
          - expr: histogram_quantile(0.5, sum by(le) (rate(status_update_duration_seconds_bucket{namespace=~"$namespace"}[2m])))
            legendFormat: p50
            refId: p50
        title: Status Update Duration
        type: timeseries
      # --- xDS Server ---
      - fieldConfig:
          defaults:
            custom:
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: green
                  value: "0"
        gridPos:
          h: 7
          id: snapshot-status
          w: 8
          x: 0
          "y": 14
        id: snapshot-status
        targets:
          - expr: sum(xds_snapshot_create_total{namespace=~"$namespace"})
            legendFormat: total
            refId: total
          - expr: sum by(status) (xds_snapshot_create_total{namespace=~"$namespace"})
            legendFormat: '{{.status}}'
            refId: status
        title: xDS Snapshot Creation
        type: stat
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
          overrides: []
        gridPos:
          h: 7
          id: xds-update-total
          w: 8
          x: 8
          "y": 14
        id: xds-update-total
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(nodeID) (xds_snapshot_update_total{namespace=~"$namespace"})
            legendFormat: '{{.nodeID}}'
            refId: total
        title: xDS Snapshot Updates
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
          overrides: []
        gridPos:
          h: 7
          id: xds-update-status
          w: 8
          x: 16
          "y": 14
        id: xds-update-status
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(status) (xds_snapshot_update_total{namespace=~"$namespace"})
            legendFormat: '{{.status}}'
            refId: status
        title: xDS Update Status
        type: timeseries
      # --- Infrastructure Manager ---
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
          overrides: []
        gridPos:
          h: 7
          id: resource-apply-total
          w: 8
          x: 0
          "y": 21
        id: resource-apply-total
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(kind) (resource_apply_total{namespace=~"$namespace"})
            legendFormat: '{{.kind}}'
            refId: total
        title: Applied Resources by Kind
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
          overrides: []
        gridPos:
          h: 7
          id: resource-apply-status
          w: 8
          x: 8
          "y": 21
        id: resource-apply-status
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(status) (resource_apply_total{namespace=~"$namespace"})
            legendFormat: '{{.status}}'
            refId: status
        title: Applied Resources Status
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
            unit: s
          overrides: []
        gridPos:
          h: 7
          id: resource-apply-duration
          w: 8
          x: 16
          "y": 21
        id: resource-apply-duration
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: histogram_quantile(0.99, sum by(le) (rate(resource_apply_duration_seconds_bucket{namespace=~"$namespace"}[2m])))
            legendFormat: p99
            refId: p99
          - expr: histogram_quantile(0.9, sum by(le) (rate(resource_apply_duration_seconds_bucket{namespace=~"$namespace"}[2m])))
            legendFormat: p90
            refId: p90
          - expr: histogram_quantile(0.5, sum by(le) (rate(resource_apply_duration_seconds_bucket{namespace=~"$namespace"}[2m])))
            legendFormat: p50
            refId: p50
        title: Resource Apply Duration
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
          overrides: []
        gridPos:
          h: 7
          id: reconcile-errors
          w: 8
          x: 0
          "y": 28
        id: reconcile-errors
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(controller) (rate(controller_runtime_reconcile_errors_total{job=~".*/envoy-gateway-controlplane-monitoring",namespace=~"$namespace"}[2m]))
            legendFormat: 'envoy-gateway/{{.controller}}'
            refId: envoy-gateway-errors
        title: Reconcile Errors
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
          overrides: []
        gridPos:
          h: 7
          id: resource-apply-by-name
          w: 8
          x: 8
          "y": 28
        id: resource-apply-by-name
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(name) (rate(resource_apply_total{namespace=~"$namespace"}[2m]))
            legendFormat: '{{.name}}'
            refId: apply
        title: Resource Applies by Name
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
          overrides: []
        gridPos:
          h: 7
          id: resource-delete-by-name
          w: 8
          x: 16
          "y": 28
        id: resource-delete-by-name
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(name) (rate(resource_delete_total{namespace=~"$namespace"}[2m]))
            legendFormat: '{{.name}}'
            refId: delete
        title: Resource Deletes by Name
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
            unit: core
          overrides: []
        gridPos:
          h: 7
          id: controlplane-cpu
          w: 12
          x: 0
          "y": 35
        id: controlplane-cpu
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(namespace,pod) (container_cpu_usage_seconds_total_irate5m{namespace=~"$namespace",pod=~"envoy-gateway-[0-9a-f].*"})
            legendFormat: '{{.pod}}'
            refId: cpu
        title: Control Plane CPU Usage
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
            unit: bytes
          overrides: []
        gridPos:
          h: 7
          id: controlplane-memory
          w: 12
          x: 12
          "y": 35
        id: controlplane-memory
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(namespace,pod) (container_memory_working_set_bytes{namespace=~"$namespace",container!="",pod=~"envoy-gateway-[0-9a-f].*"})
            legendFormat: '{{.pod}}'
            refId: memory
        title: Control Plane Memory Usage
        type: timeseries
    tags: []
    templating:
      list:
        - allValue: ".*"
          current: {}
          definition: label_values(watchable_depth,namespace)
          hide: 0
          includeAll: false
          label: Namespace
          multi: false
          name: namespace
          options: []
          query:
            query: label_values(watchable_depth,namespace)
            refId: StandardVariableQuery
          regex: ""
          sort: 1
          type: query
    time:
      from: now-30m
      to: now
    title: EnvoyGateway AdminSpace Control Panel Dashboard
    titleZh: EnvoyGateway AdminSpace Control Panel Dashboard
---
apiVersion: ait.alauda.io/v1alpha2
kind: MonitorDashboard
metadata:
  labels:
    cpaas.io/dashboard.folder: container-platform
    cpaas.io/dashboard.is.home.dashboard: "false"
    cpaas.io/dashboard.tag.built-in: "true"
    cpaas.io/dashboard.tag.applications: "true"
    cpaas.io/published: "true"
  name: envoygateway-adminspace-data-panel-dashboard
  namespace: cpaas-system
spec:
  body:
    panels:
      # --- Overview stats ---
      - fieldConfig:
          defaults:
            custom:
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: green
                  value: "0"
          overrides: []
        gridPos:
          h: 4
          id: live-servers
          w: 6
          x: 0
          "y": 0
        id: live-servers
        targets:
          - expr: sum(envoy_server_live{gateway_namespace="$gateway_ns",gateway="$gateway_name"})
            instant: true
            legendFormat: live
            refId: live
        title: Live Servers
        type: gauge
      - fieldConfig:
          defaults:
            custom:
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: green
                  value: "0"
            unit: s
          overrides: []
        gridPos:
          h: 4
          id: avg-uptime
          w: 6
          x: 6
          "y": 0
        id: avg-uptime
        options:
          wideLayout: false
        targets:
          - expr: avg by(pod) (envoy_server_uptime{gateway_namespace="$gateway_ns",gateway="$gateway_name"})
            instant: true
            legendFormat: '{{.pod}}'
            refId: uptime
        title: Avg Uptime
        type: stat
      - fieldConfig:
          defaults:
            custom:
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: green
                  value: "0"
            unit: bytes
          overrides: []
        gridPos:
          h: 4
          id: heap-size
          w: 6
          x: 12
          "y": 0
        id: heap-size
        options:
          wideLayout: false
        targets:
          - expr: sum by(pod) (envoy_server_memory_heap_size{gateway_namespace="$gateway_ns",gateway="$gateway_name"})
            instant: true
            legendFormat: '{{.pod}}'
            refId: heap
        title: Heap Size
        type: stat
      - fieldConfig:
          defaults:
            custom:
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: green
                  value: "0"
            unit: bytes
          overrides: []
        gridPos:
          h: 4
          id: alloc-mem
          w: 6
          x: 18
          "y": 0
        id: alloc-mem
        options:
          wideLayout: false
        targets:
          - expr: sum by(pod) (envoy_server_memory_allocated{gateway_namespace="$gateway_ns",gateway="$gateway_name"})
            instant: true
            legendFormat: '{{.pod}}'
            refId: alloc
        title: Allocated Memory
        type: stat
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
            unit: core
          overrides: []
        gridPos:
          h: 8
          id: cpu-usage
          w: 8
          x: 0
          "y": 4
        id: cpu-usage
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: 'sum by(gateway_namespace,gateway,pod) (container_cpu_usage_seconds_total_irate5m{pod=~"envoy-.*"} * on(namespace,pod) group_left(gateway_namespace,gateway) envoy_server_live{gateway_namespace="$gateway_ns",gateway="$gateway_name"})'
            legendFormat: '{{.pod}}'
            refId: cpu
        title: CPU Usage
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
            unit: bytes
          overrides: []
        gridPos:
          h: 8
          id: mem-usage
          w: 8
          x: 8
          "y": 4
        id: mem-usage
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: 'sum by(gateway_namespace,gateway,pod) (container_memory_working_set_bytes{container="envoy",pod=~"envoy-.*"} * on(namespace,pod) group_left(gateway_namespace,gateway) envoy_server_live{gateway_namespace="$gateway_ns",gateway="$gateway_name"})'
            legendFormat: '{{.pod}}'
            refId: mem
        title: Memory Usage
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
            unit: binBps
          overrides: []
        gridPos:
          h: 8
          id: network-io
          w: 8
          x: 16
          "y": 4
        id: network-io
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: 'sum by(gateway_namespace,gateway,pod) (container_network_receive_bytes_total_irate5m{pod=~"envoy-.*"} * on(namespace,pod) group_left(gateway_namespace,gateway) envoy_server_live{gateway_namespace="$gateway_ns",gateway="$gateway_name"})'
            legendFormat: '{{.pod}} receive'
            refId: rx
          - expr: 'sum by(gateway_namespace,gateway,pod) (container_network_transmit_bytes_total_irate5m{pod=~"envoy-.*"} * on(namespace,pod) group_left(gateway_namespace,gateway) envoy_server_live{gateway_namespace="$gateway_ns",gateway="$gateway_name"})'
            legendFormat: '{{.pod}} transmit'
            refId: tx
        title: Network Receive/Transmit
        type: timeseries
      # --- Downstream (gateway level) ---
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
            unit: reqps
          overrides: []
        gridPos:
          h: 7
          id: downstream-rps
          w: 8
          x: 0
          "y": 12
        id: downstream-rps
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(gateway_namespace,gateway) (rate(envoy_http_downstream_rq_total{gateway_namespace="$gateway_ns",gateway="$gateway_name"}[2m]))
            legendFormat: '{{.gateway_namespace}}/{{.gateway}}'
            refId: rps
        title: Downstream Requests Per Second
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
            unit: reqps
          overrides: []
        gridPos:
          h: 7
          id: downstream-cps
          w: 8
          x: 8
          "y": 12
        id: downstream-cps
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(gateway_namespace,gateway) (rate(envoy_http_downstream_cx_total{gateway_namespace="$gateway_ns",gateway="$gateway_name"}[2m]))
            legendFormat: '{{.gateway_namespace}}/{{.gateway}}'
            refId: cps
        title: Downstream Connections Per Second
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
            unit: ms
          overrides: []
        gridPos:
          h: 7
          id: downstream-latency
          w: 8
          x: 16
          "y": 12
        id: downstream-latency
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: histogram_quantile(0.99, sum by(le,gateway_namespace,gateway) (rate(envoy_http_downstream_rq_time_bucket{gateway_namespace="$gateway_ns",gateway="$gateway_name"}[2m])))
            legendFormat: '{{.gateway_namespace}}/{{.gateway}} p99'
            refId: p99
          - expr: histogram_quantile(0.9, sum by(le,gateway_namespace,gateway) (rate(envoy_http_downstream_rq_time_bucket{gateway_namespace="$gateway_ns",gateway="$gateway_name"}[2m])))
            legendFormat: '{{.gateway_namespace}}/{{.gateway}} p90'
            refId: p90
          - expr: histogram_quantile(0.5, sum by(le,gateway_namespace,gateway) (rate(envoy_http_downstream_rq_time_bucket{gateway_namespace="$gateway_ns",gateway="$gateway_name"}[2m])))
            legendFormat: '{{.gateway_namespace}}/{{.gateway}} p50'
            refId: p50
        title: Downstream Latency
        type: timeseries
      # --- Upstream (route level) ---
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
            unit: reqps
          overrides: []
        gridPos:
          h: 7
          id: upstream-rps-route
          w: 8
          x: 0
          "y": 19
        id: upstream-rps-route
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(envoy_cluster_name) (rate(envoy_cluster_upstream_rq_total{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"}[2m]))
            legendFormat: '{{.envoy_cluster_name}}'
            refId: rps
        title: Upstream Requests Per Second (Route)
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
            unit: ms
          overrides: []
        gridPos:
          h: 7
          id: upstream-latency-route
          w: 8
          x: 8
          "y": 19
        id: upstream-latency-route
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: histogram_quantile(0.99, sum by(le,envoy_cluster_name) (rate(envoy_cluster_upstream_rq_time_bucket{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"}[2m])))
            legendFormat: '{{.envoy_cluster_name}} p99'
            refId: p99
          - expr: histogram_quantile(0.9, sum by(le,envoy_cluster_name) (rate(envoy_cluster_upstream_rq_time_bucket{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"}[2m])))
            legendFormat: '{{.envoy_cluster_name}} p90'
            refId: p90
          - expr: histogram_quantile(0.5, sum by(le,envoy_cluster_name) (rate(envoy_cluster_upstream_rq_time_bucket{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"}[2m])))
            legendFormat: '{{.envoy_cluster_name}} p50'
            refId: p50
        title: Upstream Latency (Route)
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
          overrides: []
        gridPos:
          h: 7
          id: upstream-connections-route
          w: 8
          x: 16
          "y": 19
        id: upstream-connections-route
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(envoy_cluster_name) (envoy_cluster_upstream_cx_active{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"})
            legendFormat: '{{.envoy_cluster_name}}'
            refId: cx
        title: Upstream Active Connections (Route)
        type: timeseries
      # --- Response Codes (route level) ---
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: green
          overrides:
            - matcher:
                id: byName
                options: 4xx
              properties:
                - id: color
                  value: orange
            - matcher:
                id: byName
                options: 5xx
              properties:
                - id: color
                  value: red
        gridPos:
          h: 7
          id: response-codes-route
          w: 8
          x: 0
          "y": 26
        id: response-codes-route
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(envoy_cluster_name) (rate(envoy_cluster_upstream_rq_xx{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route",envoy_response_code_class=~"2"}[2m]))
            legendFormat: '{{.envoy_cluster_name}} 2xx'
            refId: "2xx"
          - expr: sum by(envoy_cluster_name) (rate(envoy_cluster_upstream_rq_xx{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route",envoy_response_code_class=~"3"}[2m]))
            legendFormat: '{{.envoy_cluster_name}} 3xx'
            refId: "3xx"
          - expr: sum by(envoy_cluster_name) (rate(envoy_cluster_upstream_rq_xx{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route",envoy_response_code_class=~"4"}[2m]))
            legendFormat: '{{.envoy_cluster_name}} 4xx'
            refId: "4xx"
          - expr: sum by(envoy_cluster_name) (rate(envoy_cluster_upstream_rq_xx{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route",envoy_response_code_class=~"5"}[2m]))
            legendFormat: '{{.envoy_cluster_name}} 5xx'
            refId: "5xx"
        title: Response Codes (Route)
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
            unit: percentunit
          overrides: []
        gridPos:
          h: 7
          id: endpoint-health-route
          w: 8
          x: 8
          "y": 26
        id: endpoint-health-route
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: 'avg by(envoy_cluster_name) (envoy_cluster_membership_healthy{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"}) / avg by(envoy_cluster_name) (envoy_cluster_membership_total{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"})'
            legendFormat: '{{.envoy_cluster_name}}'
            refId: health
        title: Endpoint Health Percentage (Route)
        type: timeseries
      - fieldConfig:
          defaults:
            custom:
              drawStyle: line
              thresholdsStyle:
                mode: "off"
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
          overrides: []
        gridPos:
          h: 7
          id: endpoints-route
          w: 8
          x: 16
          "y": 26
        id: endpoints-route
        options:
          legend:
            calcs:
              - latest
            placement: bottom
            showLegend: true
          tooltip:
            mode: multi
            sort: desc
        targets:
          - expr: sum by(envoy_cluster_name) (envoy_cluster_membership_total{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"})
            legendFormat: '{{.envoy_cluster_name}} total'
            refId: total
          - expr: sum by(envoy_cluster_name) (envoy_cluster_membership_healthy{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"})
            legendFormat: '{{.envoy_cluster_name}} healthy'
            refId: healthy
        title: Endpoints (Route)
        type: timeseries
      - description: "Last 5 minutes: QPS, Error Rate, P50/P90/P99 Latency by Route"
        fieldConfig:
          defaults:
            custom:
              align: center
            thresholds:
              mode: absolute
              steps:
                - color: '#007AF5'
          overrides:
            - matcher:
                id: byName
                options: Error Rate
              properties:
                - id: unit
                  value: percentunit
            - matcher:
                id: byName
                options: P50
              properties:
                - id: unit
                  value: ms
            - matcher:
                id: byName
                options: P90
              properties:
                - id: unit
                  value: ms
            - matcher:
                id: byName
                options: P99
              properties:
                - id: unit
                  value: ms
            - matcher:
                id: byName
                options: QPS
              properties:
                - id: unit
                  value: reqps
        gridPos:
          h: 8
          id: status-table
          w: 24
          x: 0
          "y": 33
        id: status-table
        options:
          footer:
            enablePagination: true
        targets:
          - expr: sum by(envoy_cluster_name) (rate(envoy_cluster_upstream_rq_total{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"}[2m]))
            instant: true
            legendFormat: '{{.envoy_cluster_name}}'
            refId: qps
          - expr: 'sum by(envoy_cluster_name) (rate(envoy_cluster_upstream_rq_xx{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route",envoy_response_code_class=~"[45]"}[2m])) / sum by(envoy_cluster_name) (rate(envoy_cluster_upstream_rq_xx{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"}[2m]))'
            instant: true
            legendFormat: '{{.envoy_cluster_name}}'
            refId: Error Rate
          - expr: histogram_quantile(0.5, sum by(le,envoy_cluster_name) (rate(envoy_cluster_upstream_rq_time_bucket{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"}[2m])))
            instant: true
            legendFormat: '{{.envoy_cluster_name}}'
            refId: P50
          - expr: histogram_quantile(0.9, sum by(le,envoy_cluster_name) (rate(envoy_cluster_upstream_rq_time_bucket{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"}[2m])))
            instant: true
            legendFormat: '{{.envoy_cluster_name}}'
            refId: P90
          - expr: histogram_quantile(0.99, sum by(le,envoy_cluster_name) (rate(envoy_cluster_upstream_rq_time_bucket{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"$route"}[2m])))
            instant: true
            legendFormat: '{{.envoy_cluster_name}}'
            refId: P99
        title: Last 5 Min Route Status
        transformations:
          - id: merge
          - id: organize
            options:
              excludeByName:
                Time: true
              renameByName:
                'Value #Error Rate': Error Rate
                'Value #P50': P50
                'Value #P90': P90
                'Value #P99': P99
                'Value #qps': QPS
        type: table
    tags: []
    templating:
      list:
        - allValue: ".*"
          current: {}
          definition: label_values(envoy_server_live,gateway_namespace)
          hide: 0
          includeAll: false
          label: gateway_ns
          multi: false
          name: gateway_ns
          options: []
          query:
            query: label_values(envoy_server_live,gateway_namespace)
            refId: StandardVariableQuery
          regex: ""
          sort: 1
          type: query
        - allValue: ".*"
          current: {}
          definition: label_values(envoy_server_live{gateway_namespace="$gateway_ns"},gateway)
          hide: 0
          includeAll: false
          label: gateway_name
          multi: false
          name: gateway_name
          options: []
          query:
            query: label_values(envoy_server_live{gateway_namespace="$gateway_ns"},gateway)
            refId: StandardVariableQuery
          regex: ""
          sort: 1
          type: query
        - allValue: ".*"
          current: {}
          definition: label_values(envoy_cluster_upstream_rq_total{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"httproute.*"},envoy_cluster_name)
          hide: 0
          includeAll: true
          label: route
          multi: true
          name: route
          options: []
          query:
            query: label_values(envoy_cluster_upstream_rq_total{gateway_namespace="$gateway_ns",gateway="$gateway_name",envoy_cluster_name=~"httproute.*"},envoy_cluster_name)
            refId: StandardVariableQuery
          regex: ""
          sort: 1
          type: query
    time:
      from: now-30m
      to: now
    title: EnvoyGateway AdminSpace Data Panel Dashboard
    titleZh: EnvoyGateway AdminSpace Data Panel Dashboard
---
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  labels:
    prometheus: kube-prometheus
  name: envoy-gateway-controlplane-monitoring
  namespace: "cpaas-system"
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: gateway-helm
      control-plane: envoy-gateway
  namespaceSelector:
    any: true
  podMetricsEndpoints:
    - path: /metrics
      interval: 15s
      port: metrics
---
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  labels:
    prometheus: kube-prometheus
  name: envoy-gateway-proxy-monitoring
  namespace: "cpaas-system"
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: envoy
      app.kubernetes.io/component: proxy
      app.kubernetes.io/managed-by: envoy-gateway
  namespaceSelector:
    any: true
  podMetricsEndpoints:
    - path: /stats/prometheus
      interval: 15s
      port: metrics
      relabelings:
        - sourceLabels:
            - __meta_kubernetes_pod_label_gateway_envoyproxy_io_owning_gateway_name
          targetLabel: gateway
        - sourceLabels:
            - __meta_kubernetes_pod_label_gateway_envoyproxy_io_owning_gateway_namespace
          targetLabel: gateway_namespace
```

### Step 2: Apply the manifest to the target cluster

Run the following command against the cluster where EnvoyGateway is installed:

```bash
kubectl apply -f envoy-gateway-dashboard.yaml
```

## Verification Steps

### Verify the dashboard resources

Run the following command:

```bash
kubectl -n cpaas-system get monitordashboard \
  envoygateway-adminspace-control-panel-dashboard \
  envoygateway-adminspace-data-panel-dashboard
```

The command should return both `MonitorDashboard` resources.

### Verify the PodMonitor resources

Run the following command:

```bash
kubectl -n cpaas-system get podmonitor \
  envoy-gateway-controlplane-monitoring \
  envoy-gateway-proxy-monitoring
```

The command should return both `PodMonitor` resources.

### Verify the dashboards in the web console

From **Platform Management**, go to **Operations Center** > **Monitor** > **Dashboards**. In the `container-platform` folder, verify that the following dashboards are displayed:

- `EnvoyGateway AdminSpace Control Panel Dashboard`
- `EnvoyGateway AdminSpace Data Panel Dashboard`

## Rollback

If the dashboards need to be removed, delete the resources with the same manifest:

```bash
kubectl delete -f envoy-gateway-dashboard.yaml
```

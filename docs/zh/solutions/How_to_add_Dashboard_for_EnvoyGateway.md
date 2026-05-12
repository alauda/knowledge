---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x and later
id: KB260500056
sourceSHA: b957c01ea041f6dcd01e9bda8142ac02b56a9a3262172966ddcbffb68798c0eb
---

# 如何为 EnvoyGateway 添加监控面板

## 概述

本文档描述了在目标集群中安装 EnvoyGateway 后，如何为 EnvoyGateway 添加监控面板。

该操作步骤创建以下资源：

- `envoygateway-adminspace-control-panel-dashboard`: EnvoyGateway 控制平面指标的监控面板。
- `envoygateway-adminspace-data-panel-dashboard`: Envoy 代理数据平面指标的监控面板。
- `envoy-gateway-controlplane-monitoring`: 用于收集 EnvoyGateway 控制平面指标的 PodMonitor。
- `envoy-gateway-proxy-monitoring`: 用于收集 Envoy 代理数据平面指标的 PodMonitor。

## 环境信息

适用版本：ACP 4.2.x 及更高版本

## 先决条件

在应用监控面板清单之前，请确保满足以下条件：

- EnvoyGateway 已在相应集群中安装。
- 您可以使用 `kubectl` 访问集群，并且有权限在 `cpaas-system` 命名空间中创建 `MonitorDashboard` 和 `PodMonitor` 资源。
- 集群中的监控栈支持 `PodMonitor` 资源。

## 操作步骤

### 步骤 1：创建 EnvoyGateway 监控面板清单

将以下内容保存为 `envoy-gateway-dashboard.yaml`：

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
      # --- 监控组件 ---
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
        title: 按 Runner 监控深度
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
        title: 订阅状态
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
        title: 恢复的 Panic
        type: stat
      # --- 状态更新 ---
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
        title: 按类型更新状态
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
        title: 按状态更新状态
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
        title: 状态更新持续时间
        type: timeseries
      # --- xDS 服务器 ---
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
        title: xDS 快照创建
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
        title: xDS 快照更新
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
        title: xDS 更新状态
        type: timeseries
      # --- 基础设施管理器 ---
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
        title: 按类型应用的资源
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
        title: 应用资源状态
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
        title: 资源应用持续时间
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
        title: 调和错误
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
        title: 按名称应用的资源
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
        title: 按名称删除的资源
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
        title: 控制平面 CPU 使用率
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
        title: 控制平面内存使用率
        type: timeseries
    tags: []
    templating:
      list:
        - allValue: ".*"
          current: {}
          definition: label_values(watchable_depth,namespace)
          hide: 0
          includeAll: false
          label: 命名空间
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
    title: EnvoyGateway AdminSpace 控制面板监控
    titleZh: EnvoyGateway AdminSpace 控制面板监控
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
      # --- 概览统计 ---
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
        title: 活跃服务器
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
        title: 平均运行时间
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
        title: 堆大小
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
        title: 分配的内存
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
        title: CPU 使用率
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
        title: 内存使用率
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
            legendFormat: '{{.pod}} 接收'
            refId: rx
          - expr: 'sum by(gateway_namespace,gateway,pod) (container_network_transmit_bytes_total_irate5m{pod=~"envoy-.*"} * on(namespace,pod) group_left(gateway_namespace,gateway) envoy_server_live{gateway_namespace="$gateway_ns",gateway="$gateway_name"})'
            legendFormat: '{{.pod}} 发送'
            refId: tx
        title: 网络接收/发送
        type: timeseries
      # --- 下游（网关级别） ---
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
        title: 下游每秒请求数
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
        title: 下游每秒连接数
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
        title: 下游延迟
        type: timeseries
      # --- 上游（路由级别） ---
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
        title: 上游每秒请求数（路由）
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
        title: 上游延迟（路由）
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
        title: 上游活跃连接数（路由）
        type: timeseries
      # --- 响应代码（路由级别） ---
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
        title: 响应代码（路由）
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
        title: 端点健康百分比（路由）
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
        title: 端点（路由）
        type: timeseries
      - description: "过去 5 分钟：按路由的 QPS、错误率、P50/P90/P99 延迟"
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
                options: 错误率
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
            refId: 错误率
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
        title: 最近 5 分钟路由状态
        transformations:
          - id: merge
          - id: organize
            options:
              excludeByName:
                Time: true
              renameByName:
                'Value #错误率': 错误率
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
    title: EnvoyGateway AdminSpace 数据面板监控
    titleZh: EnvoyGateway AdminSpace 数据面板监控
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

### 步骤 2：将清单应用到目标集群

在安装了 EnvoyGateway 的集群上运行以下命令：

```bash
kubectl apply -f envoy-gateway-dashboard.yaml
```

## 验证步骤

### 验证监控面板资源

运行以下命令：

```bash
kubectl -n cpaas-system get monitordashboard \
  envoygateway-adminspace-control-panel-dashboard \
  envoygateway-adminspace-data-panel-dashboard
```

该命令应返回两个 `MonitorDashboard` 资源。

### 验证 PodMonitor 资源

运行以下命令：

```bash
kubectl -n cpaas-system get podmonitor \
  envoy-gateway-controlplane-monitoring \
  envoy-gateway-proxy-monitoring
```

该命令应返回两个 `PodMonitor` 资源。

### 在 Web 控制台中验证监控面板

从 **平台管理**，转到 **操作中心** > **监控** > **监控面板**。在 `container-platform` 文件夹中，验证以下监控面板是否显示：

- `EnvoyGateway AdminSpace 控制面板监控`
- `EnvoyGateway AdminSpace 数据面板监控`

## 回滚

如果需要删除监控面板，请使用相同的清单删除资源：

```bash
kubectl delete -f envoy-gateway-dashboard.yaml
```

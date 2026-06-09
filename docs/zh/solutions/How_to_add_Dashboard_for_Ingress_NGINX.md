---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x and later
tags:
  - LB
  - Ingress NGINX
  - MonitorDashboard
id: KB260600055
sourceSHA: 02eee2bc2247b3f1c5f32241dc291973831bdb67652bd3da8b9916a0acfeaa38
---

# 如何为 Ingress NGINX 添加监控面板

## 概述

本文档描述了在目标集群中安装 `ingress-nginx-operator` 后，如何为 Ingress NGINX 添加监控面板。

该操作步骤创建以下资源：

- `ingress-nginx-controller-dashboard`：Ingress NGINX 控制器实例指标的监控面板。
- `ingress-nginx-request-handling-performance-dashboard`：Ingress 流量和请求处理指标的监控面板。

Ingress NGINX Operator 在启用指标的 `IngressNginx` 实例中已经生成了指标服务和 `ServiceMonitor`。本文档仅添加了两个 ACP `监控面板` 资源。

## 环境信息

适用版本：ACP 4.3.x 及更高版本

## 先决条件

在应用监控面板清单之前，请确保满足以下条件：

- Ingress NGINX Operator 已在相应集群中安装。
- 至少一个 `IngressNginx` 实例已启用指标。
- 您可以使用 `kubectl` 访问集群，并且有权限在 `cpaas-system` 命名空间中创建 `监控面板` 资源。
- 平台监控堆栈可以抓取为 `IngressNginx` 实例生成的 `ServiceMonitor`。

## 操作步骤

### 步骤 1：创建 Ingress NGINX 监控面板清单

将以下内容保存为 `ingress-nginx-dashboards.yaml`：

```yaml
apiVersion: ait.alauda.io/v1alpha2
kind: MonitorDashboard
metadata:
  name: ingress-nginx-controller-dashboard
  namespace: cpaas-system
  labels:
    cpaas.io/dashboard.folder: container-platform
    cpaas.io/dashboard.is.home.dashboard: 'false'
    cpaas.io/dashboard.tag.built-in: 'true'
    cpaas.io/dashboard.tag.applications: 'true'
    cpaas.io/published: 'true'
spec:
  body:
    __inputs:
    - name: DS_PROMETHEUS
      label: Prometheus
      description: ''
      type: datasource
      pluginId: prometheus
      pluginName: Prometheus
    __elements: {}
    __requires:
    - type: grafana
      id: grafana
      name: Grafana
      version: 10.4.3
    - type: panel
      id: heatmap
      name: Heatmap
      version: ''
    - type: datasource
      id: prometheus
      name: Prometheus
      version: 1.0.0
    - type: panel
      id: stat
      name: Stat
      version: ''
    - type: panel
      id: table
      name: Table
      version: ''
    - type: panel
      id: timeseries
      name: Time series
      version: ''
    annotations:
      list:
      - builtIn: 1
        datasource:
          type: datasource
          uid: grafana
        enable: true
        hide: true
        iconColor: rgba(0, 211, 255, 1)
        name: Annotations & Alerts
        type: dashboard
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        enable: true
        expr: sum(changes(nginx_ingress_controller_config_last_reload_successful_timestamp_seconds{instance!="unknown",controller_class=~"$controller_class",controller_namespace=~"$controller_namespace"}[30s]))
          by (controller_class)
        hide: false
        iconColor: rgba(255, 96, 96, 1)
        limit: 100
        name: Config Reloads
        showIn: 0
        step: 30s
        tagKeys: controller_class
        tags: []
        titleFormat: Config Reloaded
        type: tags
    editable: true
    fiscalYearStartMonth: 0
    graphTooltip: 0
    id: null
    links: []
    panels:
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            fixedColor: rgb(31, 120, 193)
            mode: fixed
          mappings:
          - options:
              match: 'null'
              result:
                text: N/A
            type: special
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: ops
        overrides: []
      id: 20
      maxDataPoints: 100
      options:
        colorMode: none
        graphMode: area
        justifyMode: auto
        orientation: horizontal
        reduceOptions:
          calcs:
          - mean
          fields: ''
          values: false
        showPercentChange: false
        textMode: auto
        wideLayout: true
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: round(sum(irate(nginx_ingress_controller_requests{controller_class=~"$controller_class",controller_namespace=~"$controller_namespace"}[2m])),
          0.001)
        format: time_series
        intervalFactor: 1
        refId: A
        step: 4
      title: Controller Request Volume
      type: stat
      gridPos:
        h: 3
        w: 6
        x: 0
        y: 0
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            fixedColor: rgb(31, 120, 193)
            mode: fixed
          mappings:
          - options:
              match: 'null'
              result:
                text: N/A
            type: special
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: none
        overrides: []
      gridPos:
        h: 3
        w: 6
        x: 6
        y: 0
      id: 82
      maxDataPoints: 100
      options:
        colorMode: none
        graphMode: area
        justifyMode: auto
        orientation: horizontal
        reduceOptions:
          calcs:
          - mean
          fields: ''
          values: false
        showPercentChange: false
        textMode: auto
        wideLayout: true
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: sum(avg_over_time(nginx_ingress_controller_nginx_process_connections{controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",state="active"}[2m]))
        format: time_series
        instant: false
        intervalFactor: 1
        refId: A
        step: 4
      title: Controller Connections
      type: stat
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            fixedColor: rgb(31, 120, 193)
            mode: fixed
          mappings:
          - options:
              match: 'null'
              result:
                text: N/A
            type: special
          thresholds:
            mode: absolute
            steps:
            - color: rgba(245, 54, 54, 0.9)
              value: null
            - color: rgba(237, 129, 40, 0.89)
              value: 95
            - color: rgba(50, 172, 45, 0.97)
              value: 99
          unit: percentunit
        overrides: []
      gridPos:
        h: 3
        w: 6
        x: 12
        y: 0
      id: 21
      maxDataPoints: 100
      options:
        colorMode: none
        graphMode: area
        justifyMode: auto
        orientation: horizontal
        reduceOptions:
          calcs:
          - mean
          fields: ''
          values: false
        showPercentChange: false
        textMode: auto
        wideLayout: true
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: sum(rate(nginx_ingress_controller_requests{controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",status!~"[4-5].*"}[2m]))
          / sum(rate(nginx_ingress_controller_requests{controller_class=~"$controller_class",controller_namespace=~"$controller_namespace"}[2m]))
        format: time_series
        intervalFactor: 1
        refId: A
        step: 4
      title: Controller Success Rate (non-4|5xx responses)
      type: stat
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            fixedColor: rgb(31, 120, 193)
            mode: fixed
          decimals: 0
          mappings:
          - options:
              match: 'null'
              result:
                text: N/A
            type: special
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: none
        overrides: []
      gridPos:
        h: 3
        w: 3
        x: 18
        y: 0
      id: 81
      maxDataPoints: 100
      options:
        colorMode: none
        graphMode: area
        justifyMode: auto
        orientation: horizontal
        reduceOptions:
          calcs:
          - sum
          fields: ''
          values: false
        showPercentChange: false
        textMode: auto
        wideLayout: true
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: avg(irate(nginx_ingress_controller_success{controller_class=~"$controller_class",controller_namespace=~"$controller_namespace"}[1m]))
          * 60
        format: time_series
        instant: false
        intervalFactor: 1
        refId: A
        step: 4
      title: Config Reloads
      type: stat
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            fixedColor: rgb(31, 120, 193)
            mode: fixed
          decimals: 0
          mappings:
          - options:
              match: 'null'
              result:
                text: N/A
            type: special
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: none
        overrides: []
      gridPos:
        h: 3
        w: 3
        x: 21
        y: 0
      id: 83
      maxDataPoints: 100
      options:
        colorMode: none
        graphMode: area
        justifyMode: auto
        orientation: horizontal
        reduceOptions:
          calcs:
          - mean
          fields: ''
          values: false
        showPercentChange: false
        textMode: auto
        wideLayout: true
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: count(nginx_ingress_controller_config_last_reload_successful{controller_namespace=~"$controller_namespace"}
          == 0)
        format: time_series
        instant: true
        intervalFactor: 1
        refId: A
        step: 4
      title: Last Config Failed
      type: stat
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 10
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 2
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: true
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: Bps
        overrides: []
      gridPos:
        h: 6
        w: 8
        x: 0
        y: 3
      id: 32
      options:
        legend:
          calcs:
          - mean
          - lastNotNull
          displayMode: list
          placement: bottom
          showLegend: false
          width: 200
        tooltip:
          mode: multi
          sort: none
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: sum (irate (nginx_ingress_controller_request_size_sum{controller_class=~"$controller_class",controller_namespace=~"$controller_namespace"}[2m]))
        format: time_series
        instant: false
        interval: 10s
        intervalFactor: 1
        legendFormat: Received
        metric: network
        refId: A
        step: 10
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: sum (irate (nginx_ingress_controller_response_size_sum{controller_class=~"$controller_class",controller_namespace=~"$controller_namespace"}[2m]))
        format: time_series
        hide: false
        interval: 10s
        intervalFactor: 1
        legendFormat: Sent
        metric: network
        refId: B
        step: 10
      title: Network I/O pressure
      type: timeseries
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 0
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 2
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: true
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: bytes
        overrides:
        - matcher:
            id: byName
            options: max - istio-proxy
          properties:
          - id: color
            value:
              fixedColor: '#890f02'
              mode: fixed
        - matcher:
            id: byName
            options: max - master
          properties:
          - id: color
            value:
              fixedColor: '#bf1b00'
              mode: fixed
        - matcher:
            id: byName
            options: max - prometheus
          properties:
          - id: color
            value:
              fixedColor: '#bf1b00'
              mode: fixed
      gridPos:
        h: 6
        w: 8
        x: 8
        y: 3
      id: 77
      options:
        legend:
          calcs:
          - mean
          - lastNotNull
          displayMode: list
          placement: bottom
          showLegend: false
          width: 200
        tooltip:
          mode: multi
          sort: desc
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: 'avg(nginx_ingress_controller_nginx_process_resident_memory_bytes{controller_class=~"$controller_class",controller_namespace=~"$controller_namespace"}) '
        format: time_series
        instant: false
        interval: 10s
        intervalFactor: 1
        legendFormat: nginx
        metric: container_memory_usage:sort_desc
        refId: A
        step: 10
      title: 平均内存使用
      type: timeseries
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: cores
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 0
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 2
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: true
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: line+area
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: rgba(0,0,0,0)
              value: null
          unit: short
        overrides: []
      gridPos:
        h: 6
        w: 8
        x: 16
        y: 3
      id: 79
      options:
        legend:
          calcs:
          - mean
          - lastNotNull
          displayMode: list
          placement: bottom
          showLegend: false
        tooltip:
          mode: multi
          sort: desc
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: 'avg (rate (nginx_ingress_controller_nginx_process_cpu_seconds_total{controller_class=~"$controller_class",controller_namespace=~"$controller_namespace"}[2m])) '
        format: time_series
        interval: 10s
        intervalFactor: 1
        legendFormat: nginx
        metric: container_cpu
        refId: A
        step: 10
      title: 平均 CPU 使用
      type: timeseries
    refresh: 5s
    schemaVersion: 39
    tags:
    - nginx
    templating:
      list:
      - current:
          selected: false
          text: Prometheus
          value: ${DS_PROMETHEUS}
        hide: 2
        includeAll: false
        label: datasource
        multi: false
        name: DS_PROMETHEUS
        options: []
        query: prometheus
        queryValue: ''
        refresh: 1
        regex: ''
        skipUrlSync: false
        type: datasource
      - allValue: .*
        current: {}
        datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        definition: label_values(nginx_ingress_controller_config_hash, controller_namespace)
        hide: 0
        includeAll: false
        label: Controller Namespace
        multi: false
        name: controller_namespace
        options: []
        query:
          query: label_values(nginx_ingress_controller_config_hash, controller_namespace)
          refId: StandardVariableQuery
        refresh: 1
        regex: ''
        skipUrlSync: false
        sort: 1
        tagValuesQuery: ''
        tagsQuery: ''
        type: query
        useTags: false
      - allValue: .*
        current: {}
        datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        definition: label_values(nginx_ingress_controller_config_hash{controller_namespace=~"$controller_namespace"}, controller_class)
        hide: 0
        includeAll: false
        label: Ingress NGINX 实例
        multi: false
        name: controller_class
        options: []
        query:
          query: label_values(nginx_ingress_controller_config_hash{controller_namespace=~"$controller_namespace"}, controller_class)
          refId: StandardVariableQuery
        refresh: 1
        regex: ''
        skipUrlSync: false
        sort: 1
        tagValuesQuery: ''
        tagsQuery: ''
        type: query
        useTags: false
    time:
      from: now-1h
      to: now
    timepicker:
      refresh_intervals:
      - 5s
      - 10s
      - 30s
      - 2m
      - 5m
      - 15m
      - 30m
      - 1h
      - 2h
      - 1d
      time_options:
      - 5m
      - 15m
      - 1h
      - 6h
      - 12h
      - 24h
      - 2d
      - 7d
      - 30d
    timezone: browser
    title: NGINX Ingress 控制器实例
    uid: nginx
    version: 1
    weekStart: ''
---
apiVersion: ait.alauda.io/v1alpha2
kind: MonitorDashboard
metadata:
  name: ingress-nginx-request-handling-performance-dashboard
  namespace: cpaas-system
  labels:
    cpaas.io/dashboard.folder: container-platform
    cpaas.io/dashboard.is.home.dashboard: 'false'
    cpaas.io/dashboard.tag.built-in: 'true'
    cpaas.io/dashboard.tag.applications: 'true'
    cpaas.io/published: 'true'
spec:
  body:
    __inputs:
    - name: DS_PROMETHEUS
      label: Prometheus
      description: ''
      type: datasource
      pluginId: prometheus
      pluginName: Prometheus
    __elements: {}
    __requires:
    - type: grafana
      id: grafana
      name: Grafana
      version: 10.4.3
    - type: datasource
      id: prometheus
      name: Prometheus
      version: 1.0.0
    - type: panel
      id: timeseries
      name: Time series
      version: ''
    annotations:
      list:
      - builtIn: 1
        datasource:
          type: datasource
          uid: grafana
        enable: true
        hide: true
        iconColor: rgba(0, 211, 255, 1)
        name: Annotations & Alerts
        target:
          limit: 100
          matchAny: false
          tags: []
          type: dashboard
        type: dashboard
    description: ''
    editable: true
    fiscalYearStartMonth: 0
    gnetId: 9614
    graphTooltip: 1
    id: null
    links: []
    liveNow: false
    panels:
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 10
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 2
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: true
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
        overrides:
        - matcher:
            id: byValue
            options:
              op: gte
              reducer: allIsZero
              value: 0
          properties:
          - id: custom.hideFrom
            value:
              legend: true
              tooltip: true
              viz: false
      gridPos:
        h: 7
        w: 12
        x: 0
        y: 0
      id: 86
      options:
        legend:
          calcs:
          - mean
          displayMode: table
          placement: right
          showLegend: true
        tooltip:
          mode: multi
          sort: none
      pluginVersion: 10.4.3
      repeatDirection: h
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: round(sum(irate(nginx_ingress_controller_requests{controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",exported_namespace=~"$ingress_namespace",ingress=~"$ingress"}[2m]))
          by (ingress), 0.001)
        format: time_series
        hide: false
        instant: false
        interval: ''
        intervalFactor: 1
        legendFormat: '{{.ingress}}'
        metric: network
        refId: A
        step: 10
      title: Ingress 请求量
      type: timeseries
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 0
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 2
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: true
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: percentunit
        overrides:
        - matcher:
            id: byName
            options: max - istio-proxy
          properties:
          - id: color
            value:
              fixedColor: '#890f02'
              mode: fixed
        - matcher:
            id: byName
            options: max - master
          properties:
          - id: color
            value:
              fixedColor: '#bf1b00'
              mode: fixed
        - matcher:
            id: byName
            options: max - prometheus
          properties:
          - id: color
            value:
              fixedColor: '#bf1b00'
              mode: fixed
        - matcher:
            id: byValue
            options:
              op: gte
              reducer: allIsNull
              value: 0
          properties:
          - id: custom.hideFrom
            value:
              legend: true
              tooltip: true
              viz: false
      gridPos:
        h: 7
        w: 12
        x: 12
        y: 0
      id: 87
      options:
        legend:
          calcs:
          - mean
          displayMode: table
          placement: right
          showLegend: true
        tooltip:
          mode: multi
          sort: asc
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: sum(rate(nginx_ingress_controller_requests{controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",exported_namespace=~"$ingress_namespace",ingress=~"$ingress",status!~"[4-5].*"}[2m]))
          by (ingress) / sum(rate(nginx_ingress_controller_requests{controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",exported_namespace=~"$ingress_namespace",ingress=~"$ingress"}[2m]))
          by (ingress)
        format: time_series
        instant: false
        interval: 10s
        intervalFactor: 1
        legendFormat: '{{.ingress}}'
        metric: container_memory_usage:sort_desc
        refId: A
        step: 10
      title: Ingress 成功率 (非 4|5xx 响应)
      type: timeseries
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      description: 在过去 6 小时内计算的摘要。
      fieldConfig:
        defaults:
          color:
            mode: thresholds
          custom:
            align: auto
            cellOptions:
              type: auto
            inspect: false
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
        overrides:
        - matcher:
            id: byName
            options: ingress
          properties:
          - id: displayName
            value: Ingress
          - id: unit
            value: short
          - id: decimals
            value: 2
          - id: custom.align
        - matcher:
            id: byName
            options: 'Value #A'
          properties:
          - id: displayName
            value: P50 延迟
          - id: unit
            value: dtdurations
          - id: custom.align
        - matcher:
            id: byName
            options: 'Value #B'
          properties:
          - id: displayName
            value: P90 延迟
          - id: unit
            value: dtdurations
          - id: custom.align
        - matcher:
            id: byName
            options: 'Value #C'
          properties:
          - id: displayName
            value: P99 延迟
          - id: unit
            value: dtdurations
          - id: custom.align
        - matcher:
            id: byName
            options: 'Value #D'
          properties:
          - id: displayName
            value: IN
          - id: unit
            value: Bps
          - id: decimals
            value: 2
          - id: custom.align
          - id: thresholds
            value:
              mode: absolute
              steps:
              - color: rgba(245, 54, 54, 0.9)
                value: null
              - color: rgba(237, 129, 40, 0.89)
        - matcher:
            id: byName
            options: Time
          properties:
          - id: unit
            value: short
          - id: decimals
            value: 2
          - id: custom.align
          - id: custom.hidden
            value: true
        - matcher:
            id: byName
            options: 'Value #E'
          properties:
          - id: displayName
            value: OUT
          - id: unit
            value: Bps
          - id: decimals
            value: 2
          - id: custom.align
      gridPos:
        h: 8
        w: 24
        x: 0
        y: 7
      hideTimeOverride: false
      id: 75
      options:
        cellHeight: sm
        footer:
          countRows: false
          fields: ''
          reducer:
          - sum
          show: false
        showHeader: true
      pluginVersion: 10.4.3
      repeatDirection: h
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: histogram_quantile(0.50, sum(rate(nginx_ingress_controller_request_duration_seconds_bucket{ingress!="",controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",ingress=~"$ingress",exported_namespace=~"$ingress_namespace"}[6h]))
          by (le, ingress))
        format: table
        hide: false
        instant: true
        intervalFactor: 1
        legendFormat: '{{.ingress}} p50'
        refId: A
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: histogram_quantile(0.90, sum(rate(nginx_ingress_controller_request_duration_seconds_bucket{ingress!="",controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",ingress=~"$ingress",exported_namespace=~"$ingress_namespace"}[6h]))
          by (le, ingress))
        format: table
        hide: false
        instant: true
        intervalFactor: 1
        legendFormat: '{{.ingress}} p90'
        refId: B
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: histogram_quantile(0.99, sum(rate(nginx_ingress_controller_request_duration_seconds_bucket{ingress!="",controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",ingress=~"$ingress",exported_namespace=~"$ingress_namespace"}[6h]))
          by (le, ingress))
        format: table
        hide: false
        instant: true
        intervalFactor: 1
        legendFormat: '{{.ingress}} p99'
        refId: C
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: sum(rate(nginx_ingress_controller_request_size_sum{ingress!="",controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",ingress=~"$ingress",exported_namespace=~"$ingress_namespace"}[6h]))
          by (ingress)
        format: table
        hide: false
        instant: true
        interval: ''
        intervalFactor: 1
        legendFormat: '{{.ingress}} request bytes'
        refId: D
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: sum(rate(nginx_ingress_controller_response_size_sum{ingress!="",controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",ingress=~"$ingress",exported_namespace=~"$ingress_namespace"}[6h]))
          by (ingress)
        format: table
        instant: true
        intervalFactor: 1
        legendFormat: '{{.ingress}} response bytes'
        refId: E
      title: Ingress 百分位响应时间和传输速率
      transformations:
      - id: merge
        options:
          reducers: []
      type: table
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 0
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 1
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: auto
            spanNulls: false
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: s
        overrides: []
      gridPos:
        h: 7
        w: 12
        x: 0
        y: 15
      hideTimeOverride: false
      id: 103
      options:
        legend:
          calcs: []
          displayMode: list
          placement: bottom
          showLegend: true
        tooltip:
          mode: multi
          sort: none
      pluginVersion: 8.3.4
      repeatDirection: h
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        exemplar: true
        expr: histogram_quantile(0.80, sum(rate(nginx_ingress_controller_request_duration_seconds_bucket{ingress!="",controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",ingress=~"$ingress",exported_namespace=~"$ingress_namespace"}[2m]))
          by (le))
        format: time_series
        hide: false
        instant: false
        interval: ''
        intervalFactor: 1
        legendFormat: P80
        refId: C
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        exemplar: true
        expr: histogram_quantile(0.90, sum(rate(nginx_ingress_controller_request_duration_seconds_bucket{ingress!="",controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",ingress=~"$ingress",exported_namespace=~"$ingress_namespace"}[2m]))
          by (le))
        format: time_series
        hide: false
        instant: false
        interval: ''
        intervalFactor: 1
        legendFormat: P90
        refId: D
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        editorMode: code
        exemplar: true
        expr: histogram_quantile(0.99, sum(rate(nginx_ingress_controller_request_duration_seconds_bucket{ingress!="",controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",ingress=~"$ingress",exported_namespace=~"$ingress_namespace"}[2m]))
          by (le))
        format: time_series
        hide: false
        instant: false
        interval: ''
        intervalFactor: 1
        legendFormat: P99
        refId: E
      title: Ingress 百分位响应时间 (Ingress 命名空间)
      type: timeseries
    - cards: {}
      color:
        cardColor: '#b4ff00'
        colorScale: sqrt
        colorScheme: interpolateWarm
        exponent: 0.5
        mode: spectrum
      dataFormat: tsbuckets
      datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      description: ''
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 10
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 1
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: true
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: s
        overrides: []
      gridPos:
        h: 7
        w: 12
        x: 12
        y: 15
      heatmap: {}
      hideZeroBuckets: false
      highlightCards: true
      id: 89
      legend:
        show: true
      options:
        legend:
          calcs: []
          displayMode: list
          placement: bottom
          showLegend: true
        tooltip:
          mode: multi
          sort: none
      pluginVersion: 10.4.3
      reverseYBuckets: false
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        exemplar: true
        expr: sum(increase(nginx_ingress_controller_request_duration_seconds_bucket{ingress!="",controller_class=~"$controller_class",controller_namespace=~"$controller_namespace",ingress=~"$ingress",exported_namespace=~"$ingress_namespace"}[2m]))
          by (le)
        format: time_series
        interval: ''
        legendFormat: '{{.le}}'
        refId: A
      title: Ingress 请求延迟桶 (Ingress 命名空间)
      tooltip:
        show: true
        showHistogram: true
      type: timeseries
      xAxis:
        show: true
      yAxis:
        format: s
        logBase: 1
        show: true
      yBucketBound: auto
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            mode: thresholds
          custom:
            align: auto
            cellOptions:
              type: auto
            inspect: false
          decimals: 2
          displayName: ''
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: short
        overrides:
        - matcher:
            id: byName
            options: host
          properties:
          - id: displayName
            value: Host
        - matcher:
            id: byName
            options: 'Value #A'
          properties:
          - id: displayName
            value: TTL (days)
          - id: unit
            value: short
          - id: custom.cellOptions
            value:
              type: color-background
          - id: thresholds
            value:
              mode: absolute
              steps:
              - color: rgba(245, 54, 54, 0.9)
                value: null
              - color: rgba(237, 129, 40, 0.89)
                value: 0
              - color: rgba(50, 172, 45, 0.97)
                value: 8
        - matcher:
            id: byName
            options: Time
          properties:
          - id: custom.hidden
            value: true
      gridPos:
        h: 8
        w: 24
        x: 0
        y: 22
      id: 85
      options:
        cellHeight: sm
        footer:
          countRows: false
          enablePagination: false
          fields: ''
          reducer:
          - sum
          show: false
        showHeader: true
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: (avg(nginx_ingress_controller_ssl_expire_time_seconds{namespace=~"$controller_namespace",class=~"$controller_class",exported_namespace=~"$ingress_namespace",host!="_",secret_name!=""})
          by (host) - time()) / 86400
        format: table
        intervalFactor: 1
        legendFormat: '{{.host}}'
        metric: gke_letsencrypt_cert_expiration
        refId: A
        step: 1
        instant: true
      title: Ingress 证书到期
      type: table
      description: 此 Ingress NGINX 实例使用的 TLS 秘密的证书到期。此指标是按主机/秘密发出的，不包括 ingress 标签。
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      description: NGINX 和上游服务器处理请求并发送响应的总时间
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 10
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 1
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: false
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          links: []
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: s
        overrides: []
      gridPos:
        h: 8
        w: 12
        x: 0
        y: 30
      id: 91
      options:
        legend:
          calcs: []
          displayMode: list
          placement: bottom
          showLegend: true
        tooltip:
          mode: multi
          sort: desc
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: "histogram_quantile(\n  0.5,\n  sum by (le)(\n    rate(\n      nginx_ingress_controller_request_duration_seconds_bucket{ingress=~\"\
          $ingress\",controller_namespace=~\"$controller_namespace\",controller_class=~\"$controller_class\",exported_namespace=~\"\
          $ingress_namespace\"}[5m]\n    )\n  )\n)"
        interval: ''
        legendFormat: '.5'
        refId: D
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: "histogram_quantile(\n  0.95,\n  sum by (le)(\n    rate(\n    nginx_ingress_controller_request_duration_seconds_bucket{ingress=~\"\
          $ingress\",controller_namespace=~\"$controller_namespace\",controller_class=~\"$controller_class\",exported_namespace=~\"\
          $ingress_namespace\"}[5m]\n    )\n  )\n)"
        interval: ''
        legendFormat: '.95'
        refId: B
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: "histogram_quantile(\n  0.99,\n  sum by (le)(\n    rate(\n      nginx_ingress_controller_request_duration_seconds_bucket{ingress=~\"\
          $ingress\",controller_namespace=~\"$controller_namespace\",controller_class=~\"$controller_class\",exported_namespace=~\"\
          $ingress_namespace\"}[5m]\n    )\n  )\n)"
        interval: ''
        legendFormat: '.99'
        refId: A
      title: 请求延迟百分位
      type: timeseries
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      description: 从上游服务器接收响应所花费的时间
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 10
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 1
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: false
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          links: []
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: s
        overrides: []
      gridPos:
        h: 8
        w: 12
        x: 12
        y: 30
      id: 94
      options:
        legend:
          calcs: []
          displayMode: list
          placement: bottom
          showLegend: true
        tooltip:
          mode: multi
          sort: desc
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: "histogram_quantile(\n  0.5,\n  sum by (le)(\n    rate(\n      nginx_ingress_controller_response_duration_seconds_bucket{ingress=~\"\
          $ingress\",controller_namespace=~\"$controller_namespace\",controller_class=~\"$controller_class\",exported_namespace=~\"\
          $ingress_namespace\"}[5m]\n    )\n  )\n)"
        instant: false
        interval: ''
        intervalFactor: 1
        legendFormat: '.5'
        refId: D
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: "histogram_quantile(\n  0.95,\n  sum by (le)(\n    rate(\n    nginx_ingress_controller_response_duration_seconds_bucket{ingress=~\"\
          $ingress\",controller_namespace=~\"$controller_namespace\",controller_class=~\"$controller_class\",exported_namespace=~\"\
          $ingress_namespace\"}[5m]\n    )\n  )\n)"
        interval: ''
        legendFormat: '.95'
        refId: B
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: "histogram_quantile(\n  0.99,\n  sum by (le)(\n    rate(\n      nginx_ingress_controller_response_duration_seconds_bucket{ingress=~\"\
          $ingress\",controller_namespace=~\"$controller_namespace\",controller_class=~\"$controller_class\",exported_namespace=~\"\
          $ingress_namespace\"}[5m]\n    )\n  )\n)"
        interval: ''
        legendFormat: '.99'
        refId: A
      title: 上游响应延迟百分位
      type: timeseries
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 10
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 1
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: false
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          links: []
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: reqps
        overrides: []
      gridPos:
        h: 8
        w: 12
        x: 0
        y: 38
      id: 93
      options:
        legend:
          calcs: []
          displayMode: table
          placement: right
          showLegend: true
        tooltip:
          mode: multi
          sort: desc
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: "  sum by (ingress, method, host, path)(\n    rate(\n      nginx_ingress_controller_request_duration_seconds_count{ingress=~\"\
          $ingress\",controller_namespace=~\"$controller_namespace\",controller_class=~\"$controller_class\",exported_namespace=~\"\
          $ingress_namespace\"}[5m]\n    )\n  )\n"
        interval: ''
        intervalFactor: 1
        legendFormat: '{{.ingress}} {{.method}} {{.host}}{{.path}}'
        refId: A
      title: 按方法和路径的请求速率
      type: timeseries
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      description: 对于观察到的每个路径，其上游响应时间的中位数
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 10
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 1
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: false
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          links: []
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: s
        overrides: []
      gridPos:
        h: 8
        w: 12
        x: 12
        y: 38
      id: 98
      options:
        legend:
          calcs: []
          displayMode: table
          placement: right
          showLegend: true
        tooltip:
          mode: multi
          sort: desc
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: "histogram_quantile(\n  .5,\n  sum by (le, ingress, method, host, path)(\n    rate(\n      nginx_ingress_controller_response_duration_seconds_bucket{ingress=~\"\
          $ingress\",controller_namespace=~\"$controller_namespace\",controller_class=~\"$controller_class\",exported_namespace=~\"\
          $ingress_namespace\"}[5m]\n    )\n  )\n)"
        interval: ''
        intervalFactor: 1
        legendFormat: '{{.ingress}} {{.method}} {{.host}}{{.path}}'
        refId: A
      title: 按方法和路径的上游响应时间的中位数
      type: timeseries
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      description: 4xx 和 5xx 响应在所有响应中的百分比。
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 10
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 1
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: false
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          links: []
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: percentunit
        overrides: []
      gridPos:
        h: 8
        w: 12
        x: 0
        y: 46
      id: 100
      options:
        legend:
          calcs: []
          displayMode: table
          placement: right
          showLegend: true
        tooltip:
          mode: multi
          sort: desc
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: sum by (ingress, method, host, path) (rate(nginx_ingress_controller_request_duration_seconds_count{ingress=~"$ingress",status=~"[4-5].*",controller_namespace=~"$controller_namespace",controller_class=~"$controller_class",exported_namespace=~"$ingress_namespace"}[5m]))
          / sum by (ingress, method, host, path) (rate(nginx_ingress_controller_request_duration_seconds_count{ingress=~"$ingress",controller_namespace=~"$controller_namespace",controller_class=~"$controller_class",exported_namespace=~"$ingress_namespace"}[5m]))
        interval: ''
        intervalFactor: 1
        legendFormat: '{{.ingress}} {{.method}} {{.host}}{{.path}}'
        refId: A
      title: 按方法和路径的响应错误率
      type: timeseries
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      description: 对于观察到的每个路径，上游请求时间的总和
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 10
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 1
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: false
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          links: []
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: s
        overrides: []
      gridPos:
        h: 8
        w: 12
        x: 12
        y: 46
      id: 102
      options:
        legend:
          calcs: []
          displayMode: table
          placement: right
          showLegend: true
        tooltip:
          mode: multi
          sort: desc
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: sum by (ingress, method, host, path) (rate(nginx_ingress_controller_response_duration_seconds_sum{controller_namespace=~"$controller_namespace",controller_class=~"$controller_class",exported_namespace=~"$ingress_namespace",ingress=~"$ingress"}[5m]))
        interval: ''
        intervalFactor: 1
        legendFormat: '{{.ingress}} {{.method}} {{.host}}{{.path}}'
        refId: A
      title: 按方法和路径的上游响应时间
      type: timeseries
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 10
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 1
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: false
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          links: []
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: reqps
        overrides: []
      gridPos:
        h: 8
        w: 12
        x: 0
        y: 54
      id: 101
      options:
        legend:
          calcs: []
          displayMode: table
          placement: right
          showLegend: true
        tooltip:
          mode: multi
          sort: desc
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: "  sum (\n    rate(\n      nginx_ingress_controller_request_duration_seconds_count{ingress=~\"$ingress\",status=~\"\
          [4-5].*\",controller_namespace=~\"$controller_namespace\",controller_class=~\"$controller_class\",exported_namespace=~\"\
          $ingress_namespace\"}[5m]\n    )\n  ) by(ingress, method, host, path, status)\n"
        interval: ''
        intervalFactor: 1
        legendFormat: '{{.ingress}} {{.method}} {{.host}}{{.path}} {{.status}}'
        refId: A
      title: 按方法和路径的响应错误率
      type: timeseries
    - datasource:
        type: prometheus
        uid: ${DS_PROMETHEUS}
      fieldConfig:
        defaults:
          color:
            mode: palette-classic
          custom:
            axisBorderShow: false
            axisCenteredZero: false
            axisColorMode: text
            axisLabel: ''
            axisPlacement: auto
            barAlignment: 0
            drawStyle: line
            fillOpacity: 10
            gradientMode: none
            hideFrom:
              legend: false
              tooltip: false
              viz: false
            insertNulls: false
            lineInterpolation: linear
            lineWidth: 1
            pointSize: 5
            scaleDistribution:
              type: linear
            showPoints: never
            spanNulls: false
            stacking:
              group: A
              mode: none
            thresholdsStyle:
              mode: 'off'
          links: []
          mappings: []
          thresholds:
            mode: absolute
            steps:
            - color: '#299c46'
              value: null
            - color: '#d44a3a'
              value: 80
          unit: decbytes
        overrides: []
      gridPos:
        h: 8
        w: 12
        x: 12
        y: 54
      id: 99
      options:
        legend:
          calcs: []
          displayMode: table
          placement: right
          showLegend: true
        tooltip:
          mode: multi
          sort: desc
      pluginVersion: 10.4.3
      targets:
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: "sum (\n  rate (\n      nginx_ingress_controller_response_size_sum{ingress=~\"$ingress\",controller_namespace=~\"\
          $controller_namespace\",controller_class=~\"$controller_class\",exported_namespace=~\"$ingress_namespace\"}[5m]\n\
          \  )\n)  by (ingress, method, host, path) / sum (\n  rate(\n      nginx_ingress_controller_response_size_count{ingress=~\"\
          $ingress\",controller_namespace=~\"$controller_namespace\",controller_class=~\"$controller_class\",exported_namespace=~\"\
          $ingress_namespace\"}[5m]\n  )\n) by (ingress, method, host, path)\n"
        hide: false
        instant: false
        interval: ''
        intervalFactor: 1
        legendFormat: '{{.ingress}} {{.method}} {{.host}}{{.path}}'
        refId: D
      - datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        expr: '    sum (rate(nginx_ingress_controller_response_size_bucket{ingress=~"$ingress",controller_namespace=~"$controller_namespace",controller_class=~"$controller_class",exported_namespace=~"$ingress_namespace"}[5m]))
          by (le)

          '
        hide: true
        legendFormat: '{{.le}}'
        refId: A
      title: 按方法和路径的平均响应大小
      type: timeseries
    refresh: 30s
    schemaVersion: 39
    tags:
    - nginx
    templating:
      list:
      - current:
          selected: false
          text: Prometheus
          value: ${DS_PROMETHEUS}
        hide: 2
        includeAll: false
        label: 数据源
        multi: false
        name: DS_PROMETHEUS
        options: []
        query: prometheus
        refresh: 1
        regex: ''
        skipUrlSync: false
        type: datasource
      - allValue: .*
        current: {}
        datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        definition: label_values(nginx_ingress_controller_config_hash, controller_namespace)
        hide: 0
        includeAll: false
        label: 控制器命名空间
        multi: false
        name: controller_namespace
        options: []
        query:
          query: label_values(nginx_ingress_controller_config_hash, controller_namespace)
          refId: StandardVariableQuery
        refresh: 1
        regex: ''
        skipUrlSync: false
        sort: 1
        tagValuesQuery: ''
        tagsQuery: ''
        type: query
        useTags: false
      - allValue: .*
        current: {}
        datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        definition: label_values(nginx_ingress_controller_config_hash{controller_namespace=~"$controller_namespace"}, controller_class)
        hide: 0
        includeAll: false
        label: Ingress NGINX 实例
        multi: false
        name: controller_class
        options: []
        query:
          query: label_values(nginx_ingress_controller_config_hash{controller_namespace=~"$controller_namespace"}, controller_class)
          refId: StandardVariableQuery
        refresh: 1
        regex: ''
        skipUrlSync: false
        sort: 1
        tagValuesQuery: ''
        tagsQuery: ''
        type: query
        useTags: false
      - allValue: .*
        current: {}
        datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        definition: label_values(nginx_ingress_controller_requests{controller_namespace=~"$controller_namespace",controller_class=~"$controller_class"},
          exported_namespace)
        hide: 0
        includeAll: true
        label: Ingress 命名空间
        multi: true
        name: ingress_namespace
        options: []
        query:
          query: label_values(nginx_ingress_controller_requests{controller_namespace=~"$controller_namespace",controller_class=~"$controller_class"},
            exported_namespace)
          refId: StandardVariableQuery
        refresh: 1
        regex: ''
        skipUrlSync: false
        sort: 1
        tagValuesQuery: ''
        tagsQuery: ''
        type: query
        useTags: false
      - allValue: .*
        current: {}
        datasource:
          type: prometheus
          uid: ${DS_PROMETHEUS}
        definition: label_values(nginx_ingress_controller_requests{controller_namespace=~"$controller_namespace",controller_class=~"$controller_class",exported_namespace=~"$ingress_namespace"},
          ingress)
        hide: 0
        includeAll: true
        label: Ingress
        multi: true
        name: ingress
        options: []
        query:
          query: label_values(nginx_ingress_controller_requests{controller_namespace=~"$controller_namespace",controller_class=~"$controller_class",exported_namespace=~"$ingress_namespace"},
            ingress)
          refId: StandardVariableQuery
        refresh: 1
        regex: ''
        skipUrlSync: false
        sort: 1
        tagValuesQuery: ''
        tagsQuery: ''
        type: query
        useTags: false
    time:
      from: now-6h
      to: now
    timepicker:
      refresh_intervals:
      - 5s
      - 10s
      - 30s
      - 2m
      - 5m
      - 15m
      - 30m
      - 1h
      - 2h
      - 1d
      time_options:
      - 5m
      - 15m
      - 1h
      - 6h
      - 12h
      - 24h
      - 2d
      - 7d
      - 30d
    timezone: browser
    title: NGINX Ingress 流量
    uid: 4GFbkOsZk
    version: 1
    weekStart: ''
```

### 步骤 2：应用仪表板清单

将清单应用到集群：

```bash
kubectl apply -f ingress-nginx-dashboards.yaml
```

## 仪表板详情

### NGINX Ingress 控制器实例

此仪表板专注于 Ingress NGINX 控制器实例。它使用控制器级变量，包括控制器命名空间和 Ingress NGINX 控制器类。

它包含以下面板：

- `控制器请求量`：所选控制器实例处理的请求速率。
- `控制器连接数`：活动的 NGINX 连接数。
- `控制器成功率（非 4|5xx 响应）`：控制器级成功率。
- `配置重载次数`：控制器配置重载计数。
- `最后一次配置失败`：最新的配置重载是否失败。
- `网络 I/O 压力`：请求和响应传输速率。
- `平均内存使用`：NGINX 进程内存使用情况。
- `平均 CPU 使用`：NGINX 进程 CPU 使用情况。

### NGINX Ingress 流量

此仪表板专注于所选 Ingress NGINX 实例处理的工作负载 Ingress 流量。它使用控制器命名空间、控制器类、工作负载 Ingress 命名空间和工作负载 Ingress 变量。工作负载 Ingress 变量支持选择所选命名空间中的所有 Ingress 对象。

它包含以下面板：

- `Ingress 请求量`：每个 Ingress 的请求速率。
- `Ingress 成功率（非 4|5xx 响应）`：每个 Ingress 的成功率。
- `Ingress 百分位响应时间和传输速率`：百分位响应时间和传输速率摘要。
- `Ingress 证书到期`：按主机的 TLS 证书到期。
- `请求处理性能`：请求处理概述。
- `响应延迟热图`：请求持续时间桶分布。
- `请求延迟百分位`：p50、p95 和 p99 请求延迟。
- `上游响应延迟百分位`：p50、p95 和 p99 上游响应延迟。
- `按方法和路径的请求速率`：按 Ingress、方法、主机和路径分组的请求速率。
- `按方法和路径的中位数上游响应时间`：按方法、主机和路径分组的中位数上游响应时间。
- `按方法和路径的响应错误率`：按方法、主机、路径和状态分组的响应错误率。
- `按方法和路径的上游响应时间`：按方法、主机和路径分组的上游响应时间。
- `按方法和路径的平均响应大小`：按方法、主机和路径分组的平均响应大小。

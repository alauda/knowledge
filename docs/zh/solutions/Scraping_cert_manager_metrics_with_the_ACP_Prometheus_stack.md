---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x
id: KB260500154
sourceSHA: a6c82bf116cab1edc43040cb31e93e6ae764b1531cd66645c3cafbdef0ee9265
---

# 使用 ACP Prometheus 堆栈抓取 cert-manager 指标

## 问题

在 Alauda Container Platform v4.3.13 上，使用 cert-manager 控制器镜像 `registry.alauda.cn:60080/3rdparty/cert-manager-controller:v1.17.18-v4.3.1`，证书生命周期数据（特别是每个 `Certificate` 的过期时间戳）由控制器作为 Prometheus 指标暴露，但集群的监控堆栈（`prometheus-operator:v0.91.0`，Prometheus CR `cpaas-system/kube-prometheus-0`）默认并不会抓取该端点。在添加抓取配置之前，查询如 `certmanager_certificate_expiration_timestamp_seconds` 将返回无系列，依赖于证书过期的仪表板或告警将保持为空。

## 根本原因

cert-manager 控制器在 `cert-manager` 命名空间的 cert-manager 服务上通过专用服务端口发布其 Prometheus 指标——端口 `9402/TCP`，命名为 `tcp-prometheus-servicemonitor`；支持该端口的控制器 Pod 带有标签 `app.kubernetes.io/component=controller` 和 `app.kubernetes.io/name=cert-manager`。指标系列 `certmanager_certificate_expiration_timestamp_seconds` 存在于此端点，并携带包括 `namespace`、`name`、`issuer_kind` 和 `issuer_name` 的标签，因此可以按 Certificate 对象进行过滤。在没有明确选择该端点的抓取配置之前，集群没有任何内容抓取该端点。

## 解决方案

在 `cert-manager` 命名空间中创建一个 `ServiceMonitor`（`monitoring.coreos.com/v1`），其选择器与 cert-manager 控制器服务标签匹配，并且其端口名称指向指标端口。集群 Prometheus 将拾取新的 `ServiceMonitor` 并添加一个抓取作业，目标是指标端点：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cert-manager
  namespace: cert-manager
  labels:
    app.kubernetes.io/component: controller
    app.kubernetes.io/name: cert-manager
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: controller
      app.kubernetes.io/name: cert-manager
  endpoints:
    - port: tcp-prometheus-servicemonitor
      interval: 60s
      scheme: http
```

应用清单：

```bash
kubectl apply -f cert-manager-servicemonitor.yaml
```

一旦 Prometheus 重新加载其配置，指标系列 `certmanager_certificate_expiration_timestamp_seconds` 将变得可查询，个别证书可以通过其 `namespace`、`name`、`issuer_kind` 和 `issuer_name` 标签值进行选择，以便用于仪表板或告警表达式。

## 诊断步骤

在创建 `ServiceMonitor` 之前确认指标端点的形状——端口名称和编号必须与选择器和 `endpoints[].port` 所引用的内容匹配：

```bash
kubectl -n cert-manager get svc cert-manager \
  -o jsonpath='{.spec.ports[?(@.name=="tcp-prometheus-servicemonitor")]}'
```

输出报告端口号为 `9402`，协议为 `TCP`。检查支持该服务的 Pod 标签，以确认控制器选择器解析为正在运行的从节点：

```bash
kubectl -n cert-manager get pod \
  -l app.kubernetes.io/component=controller,app.kubernetes.io/name=cert-manager
```

在应用 `ServiceMonitor` 后，通过直接从 Prometheus 查询指标来验证抓取是否生效。应返回系列（每个 `Certificate` 对象一个），每个系列携带 `namespace`、`name`、`issuer_kind` 和 `issuer_name` 标签：

```bash
kubectl -n cpaas-system exec statefulset/prometheus-kube-prometheus-0 -c prometheus -- \
  wget -qO- 'http://localhost:9090/api/v1/query?query=certmanager_certificate_expiration_timestamp_seconds'
```

如果查询返回零系列，请重新检查 `ServiceMonitor` 是否位于 `cert-manager` 命名空间中，确保其 `selector.matchLabels` 完全是 `app.kubernetes.io/component=controller` 和 `app.kubernetes.io/name=cert-manager`，并且 `endpoints[].port` 是字符串 `tcp-prometheus-servicemonitor`（端口 *名称*，而不是 `9402`）——这些是抓取配置派生的字段。

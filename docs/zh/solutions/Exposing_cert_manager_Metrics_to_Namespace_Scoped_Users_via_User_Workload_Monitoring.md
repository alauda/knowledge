---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500004
sourceSHA: b1bf78001d15b55a61bd20b620b111c7d7b96881fb537f39827a3a1b78622e2d
---

## 问题

一个命名空间范围的用户，仅被授予对单个项目的访问权限，无法查看 `certmanager_certificate_expiration_timestamp_seconds` 指标（或任何其他 cert-manager 指标），尽管集群上已启用用户工作负载监控。对于集群监控用户，相同的查询是有效的。

## 根本原因

cert-manager 通常安装在其自己的命名空间中，并通过一个服务暴露其指标，该服务由平台的集群级 Prometheus 抓取。该 Prometheus 实例强制执行集群范围的读取访问权限——命名空间范围的用户在没有提升权限的情况下无法查询它。

用户工作负载监控（UWM）运行一个独立的 Prometheus，该 Prometheus 抓取由 `ServiceMonitor` 和 `PodMonitor` 资源选择的目标。UWM 抓取的指标对在监控所在命名空间中具有 `monitoring-rules-view`（或等效权限）的用户可见。要将 cert-manager 指标引入 UWM 并使其可被命名空间范围的用户访问，必须满足两个条件：

1. 存在一个选择 cert-manager 指标服务的 `ServiceMonitor`，并且 UWM 被允许读取该服务。
2. 用户在该命名空间中至少具有 `monitoring-rules-view` 权限。

没有这两个条件，指标仅由集群 Prometheus 收集，并且在命名空间范围的会话中无法访问。

## 解决方案

推荐的路径是教 UWM 直接抓取 cert-manager，这样命名空间用户可以查询指标，而无需授予集群范围的读取权限。

### 步骤 1：定位 cert-manager 指标服务

识别暴露指标端点的服务：

```bash
kubectl -n cert-manager get svc
kubectl -n cert-manager get svc -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.ports[*].name}{"\n"}{end}'
```

默认的 cert-manager chart 提供一个名为 `cert-manager` 的服务，端口为 `tcp-prometheus-servicemonitor`（端口 9402）。请确认名称与您的安装相符——较旧的 chart 可能使用 `metrics`。

### 步骤 2：为 UWM 创建 ServiceMonitor

在与指标服务相同的命名空间中应用一个 `ServiceMonitor`。将 ServiceMonitor 放置在用户工作负载监控配置为发现监控的地方（平台级配置控制扫描哪些命名空间）。

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cert-manager
  namespace: cert-manager
  labels:
    release: user-workload-monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: cert-manager
      app.kubernetes.io/component: controller
  namespaceSelector:
    matchNames:
      - cert-manager
  endpoints:
    - port: tcp-prometheus-servicemonitor
      interval: 30s
      scrapeTimeout: 10s
```

应用它：

```bash
kubectl apply -f cert-manager-servicemonitor.yaml
```

如果 `release` 标签不是您集群中的约定，请查阅用户工作负载监控配置以找到发现选择器，并相应调整标签。

### 步骤 3：授予命名空间用户对监控的读取权限

用户必须能够读取 ServiceMonitor 所在命名空间中的 `monitoring-rules-view` 角色。每个用户（或组）绑定一次：

```bash
NAMESPACE=cert-manager
USER=<namespace-user>

kubectl -n ${NAMESPACE} create rolebinding ${USER}-monitoring-view \
  --clusterrole=monitoring-rules-view \
  --user=${USER}
```

如果用户已经在命名空间中拥有项目编辑或项目管理员角色，平台通常会在该角色中包含监控读取权限，因此不需要额外的绑定；请使用 `kubectl auth can-i` 验证。

### 步骤 4：验证指标是否出现

在用户工作负载 Prometheus 获取到新的 ServiceMonitor 后（通常在一分钟内），指标应该可以从命名空间中的工作负载查询。可以从集群内部进行快速检查：

```bash
kubectl -n cert-manager run curl --image=curlimages/curl --rm -it --restart=Never -- \
  -sk -G "https://thanos-querier.<monitoring-ns>.svc:9091/api/v1/query" \
  --data-urlencode 'query=certmanager_certificate_expiration_timestamp_seconds' \
  -H "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"
```

200 响应和非空的 `result` 数组确认路径有效。如果响应为空，请验证用户工作负载 Prometheus 是否实际抓取了目标——请参见下面的诊断步骤。

### 替代方案：集群范围的读取授权（不推荐）

当命名空间范围的暴露不可行时，授予用户 `cluster-monitoring-view` 权限将访问权限扩展到集群 Prometheus 收集的 *每个* 指标：

```bash
kubectl create clusterrolebinding ${USER}-cluster-monitoring \
  --clusterrole=cluster-monitoring-view \
  --user=${USER}
```

这违反了最小权限原则——用户现在可以读取集群中每个其他命名空间的 CPU、内存和任意应用指标——应仅保留给平台操作员。

## 诊断步骤

确认 ServiceMonitor 已正确创建并标记：

```bash
kubectl -n cert-manager get servicemonitor
kubectl -n cert-manager get servicemonitor cert-manager -o yaml | grep -A3 selector
```

确认用户工作负载监控已获取目标：

```bash
# 将 <uwm-ns> 替换为用户工作负载 Prometheus 运行的命名空间。
kubectl -n <uwm-ns> get pods -l app.kubernetes.io/name=prometheus
kubectl -n <uwm-ns> exec prometheus-user-workload-0 -- \
  wget -qO- http://localhost:9090/api/v1/targets \
  | python3 -c 'import json,sys; t=json.load(sys.stdin); print([x["labels"] for x in t["data"]["activeTargets"] if "cert-manager" in x["labels"].get("namespace","")])'
```

`state: up` 的目标确认抓取正常。`state: down` 的目标暴露了 `lastError` 中的潜在错误——通常是 TLS 或选择器不匹配。

验证用户的有效权限：

```bash
kubectl auth can-i get prometheuses.monitoring.coreos.com -n cert-manager --as=${USER}
kubectl auth can-i get servicemonitors -n cert-manager --as=${USER}
```

两个命令都必须返回 `yes`，以使命名空间范围的路径有效。

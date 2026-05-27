---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500168
sourceSHA: 3c80c76402fd16fb67bb560ab37b9f783dd7b970d649e8a59caa39ca75673f15
---

# 诊断 ACP 上外部负载均衡器后面的 HTTP 504 超时

## 问题

在 Alauda Container Platform (ACP 安装包 v4.3.13, Kubernetes v1.34.5, ALB2 `v4.3.1` 数据平面 `registry.alauda.cn:60080/acp/alb-nginx:v4.3.1` 在 `cpaas-system` 命名空间，由 `ingressclass/global-alb2` 前置) 中，HTTP 客户端在请求经过集群入口前的外部云负载均衡器时，收到 HTTP `504 Gateway Timeout`。用户面向的请求路径层叠了外部 L4/L7 负载均衡器、集群内 ALB2 数据平面和工作负载 Pod，这些跳数中的任何一个都可能在下一个跳数有机会返回响应之前关闭慢响应。

端到端路径的形状是标准的 Kubernetes `Service` 类型 `LoadBalancer` 拓扑——上游 `Service.spec.type` 枚举 (`ClusterIP / ExternalName / LoadBalancer / NodePort`) 在 ACP 上是相同的，外部云 LB 在 `LoadBalancer` 类型的 Service 前面附加的方式与任何符合标准的集群完全相同。在客户集群中，当后端生成第一个响应字节所需的时间超过该路径上最低超时跳数允许的时间时，症状表现为浏览器/客户端返回 `504`。

## 根本原因

跨越多个网络跳数的请求受每个跳数独立超时的控制，连接由配置的最低超时的跳数终止——而不是由最慢的跳数或后端本身。当慢速上游导致响应的首次字节时间超过任何中间跳数的配置超时时，该跳数关闭连接，客户端观察到的关闭为 HTTP `504 Gateway Timeout`；这与分发无关，因为状态码是由 `libcurl`（或任何 HTTP 客户端）从关闭或响应的上游读取的，并且在 ACP 上的表现与任何其他 Kubernetes 平台完全相同。

对于外部负载均衡器在前的拓扑，当云 LB 的请求超时配置低于集群入口的超时时，外部 LB 会在集群内入口数据平面能够返回后端响应之前终止一个慢但其他有效的请求，客户端看到的是来自 LB 的 `504` 而不是后端。

## 解决方案

修复原则是“外部超时必须大于请求路径上每个跳数的内部超时”。具体而言，当用户管理的外部负载均衡器位于 ACP 集群前面时，外部 LB 的请求超时必须配置得高于集群入口的超时，以便 LB 不会关闭一个入口仍然可以服务的连接。外部 LB 的超时是外部设备的属性，并在 LB 本身（云提供商控制台、本地设备等）上配置——此配置是通用的 LB 产品，不是 Kubernetes 对象。

在 ACP 方面，集群内入口数据平面是 ALB2 (`alaudaloadbalancer2.crd.alauda.io`, ingressclass `global-alb2`, controller `cpaas.io/alb2`, 数据平面镜像 `registry.alauda.cn:60080/acp/alb-nginx:v4.3.1` 在 `cpaas-system` 命名空间)。ALB2 通过 `Frontend` CRD (`frontends.crd.alauda.io/v1`) 在 `.spec.config.timeout` 下暴露每个前端的超时控制，其中 `proxy_connect_timeout_ms`、`proxy_read_timeout_ms` 和 `proxy_send_timeout_ms` 设置数据平面应用于该前端流量的上游连接/读取/发送预算。ALB2 前端超时是 ACP 侧内部跳数超时的实例，必须提高到与应用程序预期的首次字节时间相匹配，然后再将外部 LB 超时提高到一个严格大于 ALB2 超时的值，以便外部 LB 永远不会关闭 ALB2 数据平面仍然可以服务的连接：

```yaml
apiVersion: crd.alauda.io/v1
kind: Frontend
metadata:
  name: <frontend-name>
  namespace: cpaas-system
spec:
  config:
    timeout:
      proxy_connect_timeout_ms: 60000
      proxy_read_timeout_ms: 60000
      proxy_send_timeout_ms: 60000
```

在更新 ALB2 `Frontend` 和外部 LB 超时（LB 值严格大于 ALB2 值，而 ALB2 值又大于观察到的 `time_starttransfer`）后，重新运行 curl 诊断以访问用户面向的 URL，并确认请求现在以 `http_code: 200`（或后端的真实状态）完成，而不是 `504`。

## 诊断步骤

使用 `curl --write-out` 从外部视角捕获每个请求的时间和 HTTP 状态。libcurl 的 `--write-out` 变量（`%{time_namelookup}`、`%{time_connect}`、`%{time_appconnect}`、`%{time_pretransfer}`、`%{time_starttransfer}`、`%{time_total}`、`%{size_download}`、`%{http_code}`）由 `curl` 8.5.0 / libcurl 原样呈现，并且在任何 ACP 前置的 URL 上的工作方式相同——下面的格式字符串为每个请求生成一行标签，并且可以安全地在集群外的客户端中持续循环运行：

```bash
while true; do
  curl -s -o /dev/null \
    --write-out 'dnslookup: %{time_namelookup} | connect: %{time_connect} | appconnect: %{time_appconnect} | pretransfer: %{time_pretransfer} | starttransfer: %{time_starttransfer} | total: %{time_total} | size: %{size_download} | response: %{http_code}\n' \
    "https://<user-facing-url>/<path>"
  sleep 1
done
```

检查每个请求的输出，并将 `time_starttransfer` 与配置的上游超时进行比较。当 `time_starttransfer`（从请求开始到第一个响应字节的经过时间）超过请求路径上配置的最低超时时，请求在上游被终止，`%{http_code}` 字段为该样本呈现 `504`；这是“后端对关闭连接的跳数来说太慢”的标准信号，并确定需要提高哪个超时。

```text
dnslookup: 0.004 | connect: 0.012 | appconnect: 0.045 | pretransfer: 0.046 | starttransfer: 30.001 | total: 30.002 | size: 0 | response: 504
```

通过列出 `LoadBalancer` 类型的 Services 并检查前门绑定来确认外部 LB 在前的拓扑。`Service.spec.type` 在 ACP 上接受上游枚举 (`ClusterIP / ExternalName / LoadBalancer / NodePort`) 不变，外部云 LB 在 `type: LoadBalancer` 的 Service 前面附加的方式与任何符合标准的集群相同：

```bash
kubectl get svc -A --field-selector spec.type=LoadBalancer
kubectl get alaudaloadbalancer2 -n cpaas-system global-alb2 \
  -o jsonpath='{.status.allocatedAddress}{"\n"}'
```

当 LB 超时是关闭跳数时，仅提高 ALB2 `Frontend` 超时并不能解决症状——外部 LB 仍将在其自身（较低）限制处关闭连接。规则“外部 ≥ 内部”必须适用于路径上的每个跳数，因此将超时增加应用于 curl `time_starttransfer` 样本显示的第一个关闭的跳数。

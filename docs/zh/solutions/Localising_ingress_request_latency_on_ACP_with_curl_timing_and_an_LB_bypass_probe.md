---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500233
sourceSHA: b0bf166849ff03f306f1efea1ad4bdc0935974ebc5d582af8230a60a174f0a74
---

# 使用 curl 定时和 LB 绕过探测定位 ACP 中的入口请求延迟

## 问题

通过入口泛域名到达的慢速或间歇性慢速 HTTPS 请求可能在客户端与后端之间的多个不同跳点上引入延迟：位于集群前面的外部负载均衡器、终止请求的入口数据平面 Pod，或后端应用程序本身。在 Alauda Container Platform 中，集群内的入口数据平面是 ALB 前端 `global-alb2`（控制器 `cpaas.io/alb2`），可以通过其节点主机地址访问（在该类的 Ingress 对象上显示的 `ADDRESS`），HTTPS 监听器由 ALB 前端 `global-alb2-00443` 在 443 端口提供；相比之下，外部负载均衡器不是集群对象，只能通过下面的定时比较间接观察。

## 根本原因

由于外部负载均衡器位于集群外部，而入口数据平面位于集群内部，单一的端到端定时测量无法单独说明哪个跳点导致了延迟增加。通过两种方式发送相同的 HTTP 探测来定位延迟的来源——一次通过外部负载均衡器沿正常客户端路径，另一次绕过它，使请求直接到达入口数据平面 Pod——并读取哪条路径的定时较高。

## 解决方案

使用 `curl` 和 `--write-out` 来暴露每条路径的每个请求定时。字段 `%{time_connect}` 和 `%{time_total}` 分别给出 TCP 连接时间和总请求时间，而 `%{remote_ip}`、`%{local_ip}` 和 `%{response_code}` 确认哪个端点实际响应；此工具是 libcurl 通用的，适用于任何包含 `curl` 的镜像，没有平台特定的依赖。一个典型的探测形式是：

```bash
curl -sS -o /dev/null \
  -w 'connect=%{time_connect} total=%{time_total} remote=%{remote_ip} local=%{local_ip} code=%{response_code}\n' \
  https://<ingress-host>/
```

通过负载均衡器的探测正常通过 DNS 解析端点主机名，因此请求在到达入口数据平面之前会经过外部负载均衡器。发布在 `global-alb2` 类上的现有平台 Ingress（其主机在入口地址上响应，端口 443）为这一环节提供了一个方便的始终存在的目标，因为它可以通过与应用流量相同的泛域名入口路径访问。

绕过探测将相同的主机名固定到选定的入口数据平面 Pod IP，使用 `curl --resolve <host>:443:<ingress_pod_ip>`，因此相同的请求直接发送到该 Pod，并完全跳过外部负载均衡器。要固定的 Pod IP 是 ALB 数据平面 Pod 的节点主机地址，在 ACP 中可以通过 `kubectl` 直接枚举，读取 `cpaas-system` 命名空间中数据平面 Pods（标签 `service_name=alb2-global-alb2`）的主机 IP：

```bash
kubectl get pod -n cpaas-system -l service_name=alb2-global-alb2 \
  -o jsonpath='{range .items[*]}{.status.hostIP}{"\n"}{end}'
```

```bash
curl -sS -o /dev/null \
  --resolve <ingress-host>:443:<ingress_pod_ip> \
  -w 'connect=%{time_connect} total=%{time_total} remote=%{remote_ip} local=%{local_ip} code=%{response_code}\n' \
  https://<ingress-host>/
```

比较两个输出可以定位跳点：如果通过负载均衡器的探测显示高 `time_connect`/`time_total`，而绕过探测到入口数据平面 Pods 的请求保持快速，则延迟归因于外部负载均衡器，而不是入口 Pods 或后端。

## 诊断步骤

为了捕获间歇性延迟而不是单个样本，从一个循环执行 `curl` 命令并记录每个结果的 Pod 中持续运行比较。Pod 形状是一个普通的 `kubectl run`，在定时 `curl` 周围驱动一个 `while` 循环；通过带时间戳的 Pod 日志读取可以构建一个延迟时间线，揭示何时出现慢路径。这个 Pod 形状在 Kubernetes v1.34.5 上是一个有效的 Pod，并且没有平台特定的依赖，因为定时是纯粹的 libcurl `--write-out`。该平台上的 ALB 数据平面容器镜像是 `registry.alauda.cn:60080/acp/alb-nginx:v4.3.1`。

```bash
kubectl run ingress-latency-probe --image=<image-with-curl> --restart=Never -- \
  sh -c 'while true; do \
    curl -sS -o /dev/null \
      -w "%(date)T connect=%{time_connect} total=%{time_total} code=%{response_code}\n" \
      https://<ingress-host>/; \
    sleep 5; done'
```

为了快速进行一次性检查而不部署任何东西，可以通过 `kubectl exec` 进入一个已经包含 `curl` 的现有 Pod，依次发出通过负载均衡器的请求和 `--resolve` 绕过请求，并比较它们报告的定时。

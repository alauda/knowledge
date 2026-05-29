---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500625
sourceSHA: 0a07b2b6c2dab56acbb67b79355e964713f63f4e2fd1ff96815061f7c9e4c1fb
---

# ACP ALB pods OOMKilled 及高重启计数 — 移除 global-alb2 的内存限制

## 问题

在 Alauda 容器平台上，入口数据平面由 ALB 插件提供（CRD `alaudaloadbalancer2.crd.alauda.io`，简称 `alb2`），作为 `cpaas-system` 命名空间中的 `global-alb2` 部署。每个 `global-alb2-*` pod 运行两个容器 — `nginx`（镜像 `registry.alauda.cn:60080/acp/alb-nginx:v4.3.1`）和 `alb2`（镜像 `registry.alauda.cn:60080/acp/alb2:v4.3.1`） — 默认情况下，两者的 `resources.limits.memory` 为 `2Gi`。如果任一容器的工作集接近或超过其 cgroup 内存限制，标准的 OOMKilled 机制将适用：内核 OOM 杀手通过 SIGKILL 终止容器，kubelet 重新启动它；运维人员观察到的症状是 `global-alb2-*` pods 的 `restartCount` 值升高。

## 根本原因

两个 ALB 容器受限于 `global-alb2` 部署中的 `spec.template.spec.containers[*].resources.limits.memory=2Gi`，相应的 `resources.requests` 为 `cpu=50m, memory=128Mi`；`nginx` 容器的限制还包括 `cpu=2`，而 `alb2` 容器的限制为 `cpu=200m`。当容器的常驻集超过其内存限制时，Linux cgroup 内存控制器会调用 OOM 杀手，发送 SIGKILL — 容器以代码 137（128 + 9）退出，并由 kubelet 在原地重新启动，增加 pod 上的 `containerStatuses[*].restartCount`。一旦移除限制，容器仅受节点容量和其 `requests` 下限的约束，因此标准的 OOMKill 机制不再在 2Gi 的余量上触发，任何相关的重启循环停止。

## 解决方案

从 `cpaas-system` 中的 `global-alb2` 部署的两个容器中移除 `resources.limits` 块。`spec.template.spec.containers[*].resources` 字段使用标准的 apps/v1 结构，带有 `limits` 和 `requests` 子键用于 `cpu` 和 `memory`，因此在 `limits` 路径上执行 JSON-Patch `remove` 操作即可被 apiserver 接受。

修补容器索引 0（`nginx`）：

```bash
kubectl patch deployment global-alb2 -n cpaas-system \
  --type=json \
  -p='[{"op":"remove","path":"/spec/template/spec/containers/0/resources/limits"}]'
```

以相同方式修补容器索引 1（`alb2`）：

```bash
kubectl patch deployment global-alb2 -n cpaas-system \
  --type=json \
  -p='[{"op":"remove","path":"/spec/template/spec/containers/1/resources/limits"}]'
```

补丁生效后，Deployment 将推出没有 `resources.limits` 的新 pods；`requests` 保持不变，因此调度程序仍然在每个节点上保留下限。验证新 pods 是否保持运行，并且 `restartCount` 不再增加。

## 诊断步骤

列出 ALB pods，并观察 `global-alb2-*` 集合的 `RESTARTS`。pod 的 `containerStatuses[*].restartCount` 字段可以通过 `kubectl get pods` 直接查看，每次 kubelet 在终止后重新启动容器时都会增加。

```bash
kubectl get pods -n cpaas-system -l service_name=alb2-global-alb2
```

检查单个 pod 的最后终止状态。被 cgroup OOM 杀手终止的容器在 `kubectl describe pod` 中显示 `Last State: Terminated`，`Reason: OOMKilled`，并且退出代码为 137；`Reason: OOMKilled` 是 kubelet 在达到 cgroup 内存限制时专门设置的标签，因此其存在是确认重启循环由内存限制驱动而非一般崩溃的权威依据。

```bash
kubectl describe pod -n cpaas-system <global-alb2-pod-name>
```

读取 Deployment 上当前的 `resources` 块，以确认补丁前的配置。`nginx` 容器的限制应显示 `cpu=2, memory=2Gi`，而 `alb2` 容器的限制为 `cpu=200m, memory=2Gi`，两者的请求均为 `cpu=50m, memory=128Mi`，对应 v4.3.1 ALB 插件。

```bash
kubectl get deployment global-alb2 -n cpaas-system -o yaml \
  | grep -A4 resources:
```

如果 `kubectl describe` 显示一般的 `Reason: Error` 和退出代码 137，而不是 `Reason: OOMKilled`，则容器是由于其他来源的 SIGKILL 被杀死（例如，节点级驱逐或外部信号） — 只有 kubelet 的 `OOMKilled` 原因字符串明确将终止归因于 cgroup 内存限制，因此在排查时应将这两种情况分开处理。

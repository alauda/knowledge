---
kind:
  - Information
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500203
sourceSHA: e3ef523ff391b3f379a06e8d71b8632e480161659c914a71d8a74f2f8454896c
---

# 每用户 API 请求计数速率限制不是 ACP 的 kube-apiserver 原语

## 问题

Alauda Container Platform (ACP 安装包 v4.3.13，服务器 `v1.34.5`，kube-apiserver 镜像 `registry.alauda.cn:60080/tkestack/kube-apiserver:v1.34.5`) 的集群管理员有时会要求在 API 服务器上内置一种方式来限制“每用户每秒/每分钟 N 次请求”——例如，阻止某个失控的客户端以高频率发出 `kubectl get pods` 请求。ACP 运行的 kube-apiserver 是上游 Kubernetes API 服务器，而该服务器并未针对每个经过身份验证的用户或客户端公开基于请求计数的限流；没有任何字段、标志或准入资源实现这样的配额。任何等效的发行版也存在同样的缺口，因为 apiserver 继承了上游设计。

## 根本原因

上游 kube-apiserver 提供的是 API 优先级和公平性 (APF)，在此集群的 GA 版本为 `flowcontrol.apiserver.k8s.io/v1`，并且 `FlowSchema` 和 `PriorityLevelConfiguration` 是内置的集群范围类型。APF 是一种并发和公平性机制：`FlowSchema` 选择适用规则的经过身份验证的主体，并将匹配的请求指向 `PriorityLevelConfiguration`，其可调参数（`nominalConcurrencyShares`、`queues`、`handSize`、`queueLengthLimit`，加上 `type: Limited|Exempt`）决定了在飞行中的并发——而不是每时间窗口的请求数。`FlowSchema.spec` 仅公开 `distinguisherMethod`、`matchingPrecedence`、`priorityLevelConfiguration` 和 `rules`；在模式中没有 `maxRequestsPerSecond` 或 `requestsPerMinute` 风格的字段，`distinguisherMethod`（例如 `ByUser`、`ByNamespace`）仅将请求分组到优先级内的公平共享队列中，而不是施加每主体的速率限制。

原生 Kubernetes API 本身没有用户级请求计数限流。`FlowSchema` 主体选择器是一个 *匹配* 结构，没有其他内置 API 组提供每用户每时间窗口的配额；apiserver 自身的命令行界面也证实了这一点——没有 `--rate-limit`、没有 `--per-user-*`、没有 `--max-requests` 标志被配置，并且自 Kubernetes 1.29 起，APF 作为 GA 上游功能意味着它在没有功能开关切换的情况下无条件启用。

## 解决方案

将 APF 视为支持的控制平面稳定性机制，并通过标准内置对象进行配置。集群已经提供了上游默认的 FlowSchemas 集合——`exempt`、`probes`、`system-leader-election`、`system-node-high`、`system-nodes`、`kube-controller-manager`、`kube-scheduler`、`kube-system-service-accounts`、`service-accounts`、`global-default` 和 `catch-all`——绑定到上游默认的 PriorityLevelConfigurations（`exempt`、`system`、`node-high`、`leader-election`、`workload-high`、`workload-low`、`global-default`、`catch-all`），其并发形状如 `Limited` + `nominalConcurrencyShares` + `queues` + `handSize` + `queueLengthLimit`：

```bash
kubectl get flowschemas.flowcontrol.apiserver.k8s.io
kubectl get prioritylevelconfigurations.flowcontrol.apiserver.k8s.io
```

要为特定经过身份验证的主体划分一个单独的并发通道，定义一个选择该主体的 `FlowSchema`，并将其路由到具有所需并发形状的 `PriorityLevelConfiguration`——这是唯一针对特定用户的集群内调节器，它作用于并行的飞行负载，而不是每窗口的请求数：

```yaml
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: noisy-client
spec:
  matchingPrecedence: 9000
  priorityLevelConfiguration:
    name: workload-low
  distinguisherMethod:
    type: ByUser
  rules:
    - subjects:
        - kind: User
          user:
            name: alice
      resourceRules:
        - verbs: ["*"]
          apiGroups: ["*"]
          resources: ["*"]
```

如果需求确实是每用户请求计数配额在时间窗口内，则将该策略放置在集群 *外部*——在前端负载均衡器或防火墙上，该设备位于 API 服务器前面（HAProxy、F5、NGINX 等）。该层是客户管理的网络基础设施，位于集群的 API 表面之外；kube-apiserver 本身不会实施该策略。

## 诊断步骤

确认集群中的准入机制也不实施每用户限流。列出准入注册类型仅返回四个上游资源——`MutatingWebhookConfiguration`、`ValidatingWebhookConfiguration`、`ValidatingAdmissionPolicy` 和 `ValidatingAdmissionPolicyBinding`，均在 `admissionregistration.k8s.io/v1` 下——并且它们都不是请求计数限流资源：

```bash
kubectl api-resources | grep -i admission
```

检查 kube-apiserver 静态 Pod 清单以确认运行标志设置不包括每用户或请求计数速率限制。在 ACP 中，kube-apiserver 作为静态 Pod 在 `kube-system` 命名空间中运行；描述它并查看 `Command:` 部分——配置的标志涵盖身份验证模式（`Node,RBAC`）、etcd 端点和 TLS、审计、准入插件（如 `NodeRestriction`、`OwnerReferencesPermissionEnforcement`、`DenyServiceExternalIPs`）和令牌处理，没有 `--rate-limit`、没有 `--per-user-*`，也没有 `--max-requests-inflight` 风格的每主体配额标志：

```bash
kubectl get pods -n kube-system -l component=kube-apiserver
kubectl describe pod -n kube-system kube-apiserver-<control-plane-node>
```

确认 APF API 表面在集群中是活跃的——这两种类型在 GA `flowcontrol.apiserver.k8s.io/v1` 上提供，默认的 FlowSchemas 和 PriorityLevelConfigurations 存在，这是在并发或公平性需要调节时使用的集群内表面：

```bash
kubectl api-resources --api-group=flowcontrol.apiserver.k8s.io
kubectl get flowschema catch-all -o yaml
kubectl get prioritylevelconfiguration global-default -o yaml
```

---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500714
sourceSHA: a6f5265a48c9b2419bf879a48a3d3b4d3f8559fd86270fb2a9227f36b64e7d0c
---

# 当 NetworkPolicy 拒绝对 apiserver 的出口时，Operator 管理器 Pod 卡在 CrashLoopBackOff 状态

## 问题

在 Alauda 容器平台（Kubernetes `v1.34.5`，CNI `kube-ovn v1.15.10`，通过 `--enable-np=true --np-enforcement=standard --enable-anp=true` 启用 NetworkPolicy 强制执行），一个 operator 的 controller-manager pod 在其命名空间应用 `NetworkPolicy` 后不久进入 `CrashLoopBackOff` 状态。上一个重启的容器日志显示，管理器因 API-server 连接错误而无法引导，错误信息为 `Failed to create a new manager.` 和 `dial tcp <apiserver-ip>:443: i/o timeout`。

在集群中重现该问题显示了端到端的链条：一个形状为管理器的 pod（标签 `control-plane=controller-manager`）在没有策略的情况下正常启动，并拨打集群内的 apiserver 地址 `https://10.4.0.1:443/api?timeout=32s`；一旦应用了选择该 pod 的 `default-deny-egress` `NetworkPolicy`，下次启动在同一拨号上阻塞，并因超时错误退出，kubelet 记录 `state.waiting.reason=CrashLoopBackOff`，`restartCount` 不断增加，并出现 `Warning BackOff` 事件，显示 `Back-off restarting failed container`。

## 根本原因

`NetworkPolicy` 是 ACP 上的核心 `networking.k8s.io/v1` 命名空间资源（`netpol`），由 kube-ovn 以上游语义强制执行。`policyTypes` 字段文档说明，要拒绝出口，策略必须在 `policyTypes` 中列出 `Egress`，且没有 `egress` 部分；`egress` 字段文档说明，当出口列表为空时，`NetworkPolicy` 限制所选 pods 的所有出站流量。因此，形状为 `policyTypes:[Egress]` 且没有 `egress` 规则的 `NetworkPolicy` 选择了 controller-manager pod，从而完全隔离了该 pod 的出口，包括其与集群内 apiserver 的连接。

操作员的管理器容器在引导期间通过集群内的 `kubernetes.default` `Service` 访问 apiserver。在 ACP 中，服务集群 IP 范围为 `10.4.0.0/16`，因此 `default` 命名空间中的 `kubernetes` `Service` 的 `ClusterIP` 为 `10.4.0.1:443/TCP` — 与其他 Kubernetes 发行版中看到的默认值不同。当对该端点的出口被阻止时，引导连接超时，管理器进程以非零状态退出，且 `restartPolicy: Always` 使 kubelet 在回退循环中重启容器，表现为 `CrashLoopBackOff`。

在 kube-ovn 上编写修复时，一个微妙的点很重要：流量到 `Service` 的 `ClusterIP` 在强制执行出口 `NetworkPolicy` 之前被 DNAT 到后端端点 IP，因此仅允许 `kubernetes` `Service` `ClusterIP`（此处为 `10.4.0.1/32:443`）的 `egress` 规则并不能解锁管理器。该规则必须允许 apiserver 的真实后端端点 — 在其安全端口（在重现中为 `6443`）上列出的 `kubernetes` `Service` 的 `EndpointSlice` 中的地址。

## 解决方案

在操作员的命名空间中添加一个 `NetworkPolicy` 出口规则，允许 controller-manager pod 访问 apiserver 后端端点的安全端口，然后让 kubelet 通过回退重启 pod，以便下次引导成功。

首先，发现 apiserver 后端端点（这些是规则必须允许的地址，而不是 `kubernetes` `Service` 的 `ClusterIP`）：

```bash
kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes
```

```text
NAME         ADDRESSTYPE   PORTS   ENDPOINTS         AGE
kubernetes   IPv4          6443    192.168.136.179   4h1m
```

编写一个选择 controller-manager pod 的出口 `NetworkPolicy`，并允许 TCP 访问每个 apiserver 端点 IP 上列出的端口。`egress.to` 对等体是一个 `NetworkPolicyPeer`（`ipBlock | namespaceSelector | podSelector`），而 `egress.ports` 是一个 `NetworkPolicyPort`（`port` + `protocol`，默认为 `TCP`）；对于 apiserver 目标，每个端点 IP 的 `ipBlock` 是最通用的形状：

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-apiserver-egress
  namespace: <operator-namespace>
spec:
  podSelector:
    matchLabels:
      control-plane: controller-manager
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 192.168.136.179/32
      ports:
        - protocol: TCP
          port: 6443
```

将该策略应用于（或替换）现有的 default-deny-egress 策略；多个选择同一 pod 的 `NetworkPolicy` 对象是 OR 关系，因此只要没有其他策略进一步缩小 apiserver 路径，添加允许规则就足够了：

```bash
kubectl apply -n <operator-namespace> -f allow-apiserver-egress.yaml
```

在 kubelet 下次重试管理器容器后（回退间隔是有界的；重启会自动恢复），controller-manager pod 将从 `CrashLoopBackOff` 状态转变，之前失败的启动完成 — 同样的探测在下次引导时成功返回，而不是 `dial tcp 10.4.0.1:443: i/o timeout`。

如果集群有多个控制平面端点，则在 `egress.to` 下将 `EndpointSlice` 中的每个地址列为其自己的 `ipBlock` 条目；该规则匹配到其中任何一个的流量。如果在启动时还需要其他集群内目标（例如，CoreDNS 用于在连接到 apiserver 之前进行名称解析），则通过额外的 `egress` 条目扩展该策略 — 每个条目是独立与其他条目进行 OR 操作的。

## 诊断步骤

当管理器 pod 不稳定时，捕获上一个容器实例的引导错误 — 当前容器通常处于重试中，其日志为空或部分：

```bash
kubectl logs -n <operator-namespace> <manager-pod> --previous
```

包含 `Failed to create a new manager.` 和 `dial tcp <ip>:443: i/o timeout`（或针对集群内 apiserver 地址的等效连接超时错误）的日志行是出口到 apiserver 被阻止的诊断特征。

确认容器正在被 kubelet 重启，并且回退正在生效：

```bash
kubectl get pod -n <operator-namespace> <manager-pod> \
  -o jsonpath='{.status.containerStatuses[0]}'
kubectl get events -n <operator-namespace> \
  --field-selector involvedObject.name=<manager-pod> --sort-by=.lastTimestamp
```

`state.waiting.reason: CrashLoopBackOff` 和非零的 `lastState.terminated.exitCode` 以及 `Warning BackOff` 事件的 `Back-off restarting failed container` 确认了该模式。

列出命名空间中的 `NetworkPolicy` 对象，并检查任何选择管理器 pod 的策略，以查看 `policyTypes` 是否包括 `Egress`，且没有允许 apiserver 端点的出口规则：

```bash
kubectl get networkpolicy -n <operator-namespace>
kubectl describe networkpolicy -n <operator-namespace> <policy-name>
```

解析 apiserver `Service` 及其后端端点，以了解出口规则必须允许哪些地址；仅有 `ClusterIP` 在 kube-ovn 上是不够的：

```bash
kubectl get svc -n default kubernetes
kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes
```

一旦允许规则到位，管理器容器的下次引导应该成功，pod 应该返回到 `Running` 状态，而无需进一步重启。

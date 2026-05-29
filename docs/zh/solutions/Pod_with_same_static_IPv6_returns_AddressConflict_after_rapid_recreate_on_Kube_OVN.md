---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500666
sourceSHA: 7e199ad38070db0760ba9729bd607c657aa5ffeca446866ad80356c5288e3eab
---

# 在 Kube-OVN 上快速重建相同静态 IPv6 的 Pod 返回 AddressConflict

## 问题

在 Alauda 容器平台的默认 Kube-OVN 集群 CNI (`registry.alauda.cn:60080/acp/kube-ovn:v1.15.11`，守护进程集 `kube-system/kube-ovn-cni` 加上 `Deployment kube-system/kube-ovn-controller`)，一个工作负载的 Pod 模板通过 Kube-OVN 注释 `ovn.kubernetes.io/logical_switch=<subnet>` 和 `ovn.kubernetes.io/ip_address="<v4>,<v6>"` 固定了一个静态 IPv6 地址，当其现有 Pod 被删除时，无法安全地通过 `Deployment` 重新调度。新的 Pod 由同一个 `ReplicaSet` 拥有，立即在同一节点上调度，并请求 Kube-OVN 的 IPAM 分配相同的静态地址，而之前 Pod 的分配尚未释放。Kube-OVN 拒绝该请求，新的 Pod 保持在 `ContainerCreating` 状态，直到旧的分配被释放。

在此期间，新的 Pod 观察到两个警告事件 — 首先是来自 kubelet 的 CRI 插件调用的 `FailedCreatePodSandBox`，然后是来自 Kube-OVN 控制器的 `AcquireAddressFailed`：

```text
Warning   FailedCreatePodSandBox   pod/dad-pinned-v6-<rs>-<hash>   Failed to create pod sandbox: rpc error: code = Unknown
  desc = failed to setup network for sandbox "...": plugin type="kube-ovn" failed (add): RPC failed; request ip return 500
  no address allocated to pod <ns>/dad-pinned-v6-<rs>-<hash> provider ovn, please see kube-ovn-controller logs to find errors
Warning   AcquireAddressFailed     pod/dad-pinned-v6-<rs>-<hash>   AddressConflict
```

这是 Kube-OVN 相同底层竞争条件的表面：一个由 `Deployment`（或任何由 `ReplicaSet` 支持的控制器）拥有的 Pod 在其之前的 IPAM 记录被释放之前被替换，而请求相同固定静态地址的新副本失败。冲突在 IPAM 分配时被 Kube-OVN 捕获，在 Pod netns 内的内核看到地址之前。

## 根本原因

`Deployment` 并未为给定的 Pod 模板提供“至多一个”的保证。该平台上由 kube-apiserver 提供的 `apps/v1` Deployment 架构将 `spec.strategy.type` 显示为枚举 `Recreate | RollingUpdate`，默认值为 `RollingUpdate`，其 `Recreate` 值的描述为“在创建新 Pod 之前杀死所有现有 Pod” — 该承诺仅在新的 Deployment 修订触发控制器驱动的滚动更新时适用。当单个 Pod 在更新之外被删除（手动 `kubectl delete pod`、驱逐、节点级终止）时，生命周期由 `ReplicaSet` 控制器拥有，该控制器立即调度替换，而不是等待已删除 Pod 的终止完成。

相比之下，`StatefulSet` 提供了“每个序号至多一个”的保证。该平台上 `apps/v1` StatefulSet 架构将 `spec.podManagementPolicy` 显示为枚举 `OrderedReady | Parallel`，默认值为 `OrderedReady`，其描述为：“Pods 按递增顺序创建（pod-0，然后是 pod-1 等），控制器将在每个 Pod 准备好之前等待继续。当缩减时，Pods 按相反顺序移除”。`spec.updateStrategy.type` 是枚举 `OnDelete | RollingUpdate`，默认值为 `RollingUpdate`。这使得序号 `N` 在任何时刻最多存在一次：控制器在创建替换之前等待序号 `N` 的终止 Pod 被移除，这个间隙为 Kube-OVN 的 IPAM 提供了时间，以在新 Pod 请求相同静态地址之前释放之前的分配。

在 IPAM 方面，Kube-OVN 将 IPv6 作为一等子网协议 — `subnets.kubeovn.io` CRD 声明 `spec.protocol` 为枚举 `IPv4 | IPv6 | Dual`，并指出其“创建后不可变”，而 `ips.kubeovn.io` 则携带一个与 `spec.v4IpAddress` 分开的专用 `spec.v6IpAddress` 字段。用户通过将 Pod 模板绑定到 `Dual` 栈（或 `IPv6`）子网，固定每个 Pod 的静态 IPv4 + IPv6，使用 `ovn.kubernetes.io/logical_switch` 和 `ovn.kubernetes.io/ip_address="<v4>,<v6>"`。一旦新 Pod 被接纳，Pod netns 内的 `ip -6 addr show eth0` 显示请求的地址，带有 `scope global`，且内核没有 `tentative` 或 `dadfailed` 标志 — Kube-OVN 在 IPAM 分配时控制冲突，因此内核侧的重复地址检测状态无需恢复。

## 解决方案

每当工作负载需要每个 Pod 固定静态 IPv6（或 IPv4）时，用 `StatefulSet` 替换工作负载的 `Deployment`。StatefulSet 的默认 `podManagementPolicy=OrderedReady` 和默认 `updateStrategy.type=RollingUpdate` 保持了每个序号“至多一个”的保证，使 Kube-OVN 的 IPAM 在新 Pod 请求相同地址之前释放之前的分配。

一个在 Kube-OVN 上固定静态 IPv4 + IPv6 的最小 StatefulSet — 在 Alauda 容器平台 `v4.3.22`、Kubernetes `v1.34.5-1`、Kube-OVN `v1.15.11` 上验证 — 如下所示。将工作负载固定到一个节点，使用 `nodeSelector` 以便快速重启路径保持可观察；`ovn.kubernetes.io/logical_switch` 注释必须命名定义 IPv6（或 Dual）CIDR 的 `Subnet` CR，而 `ovn.kubernetes.io/ip_address` 注释列出静态 IPv4 和 IPv6，用逗号分隔：

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: dad-pinned-sts
  namespace: dad-test
spec:
  serviceName: dad-pinned-sts
  replicas: 1
  selector:
    matchLabels:
      app: dad-pinned-sts
  template:
    metadata:
      labels:
        app: dad-pinned-sts
      annotations:
        ovn.kubernetes.io/logical_switch: dad-test-v6
        ovn.kubernetes.io/ip_address: "10.99.0.30,fd00:dad:7132::30"
    spec:
      nodeSelector:
        kubernetes.io/hostname: "<worker-node>"
      terminationGracePeriodSeconds: 5
      containers:
        - name: net
          image: registry.alauda.cn:60080/3rdparty/kubectl:v4.3.3
          command: ["sh","-c","sleep 36000"]
```

支持的 `Subnet` 是一个 Kube-OVN 双栈子网，包含固定地址，并作用于工作负载的命名空间：

```yaml
apiVersion: kubeovn.io/v1
kind: Subnet
metadata:
  name: dad-test-v6
spec:
  protocol: Dual
  cidrBlock: "10.99.0.0/24,fd00:dad:7132::/64"
  excludeIps:
    - "10.99.0.1"
    - "fd00:dad:7132::1"
  gateway: "10.99.0.1,fd00:dad:7132::1"
  gatewayType: distributed
  natOutgoing: false
  namespaces:
    - dad-test
```

在应用这两个清单后，强制删除 StatefulSet 的 Pod，替换 Pod 保持相同的序号名称，并分配相同的静态 IPv4 + IPv6，而没有 `AddressConflict` 事件；一旦新 Pod 处于 `Running` 状态，`kubectl exec dad-pinned-sts-0 -- ip -6 addr show eth0` 报告请求的地址，带有 `scope global`，且没有 `tentative` 或 `dadfailed` 标志。

## 诊断步骤

确认工作负载的拥有者类型及其请求的地址。Pod 的控制器在 `metadata.ownerReferences` 中可见；如果链条通过 `ReplicaSet` 导致 `Deployment`，手动删除路径会在同一节点上立即调度替换（在该平台上验证 — 替换在 `t+0s` 时调度，并在大约八秒后达到 `Running` 状态，使用相同的固定 `10.99.0.20,fd00:dad:7132::20`）。固定地址本身在 Pod 模板的 `metadata.annotations` 下 — 从 Pod 规格中读取 `ovn.kubernetes.io/ip_address` 和 `ovn.kubernetes.io/logical_switch` 以查看目标子网。

阅读待定 Pod 的事件以确认故障是 Kube-OVN IPAM 而非其他原因。冲突表现为 `## 问题` 部分中显示的一对警告：来自 CRI 侧的 `FailedCreatePodSandBox` 和来自 Kube-OVN 控制器的 `AcquireAddressFailed AddressConflict`。`request ip return 500 no address allocated to pod ... provider ovn` 子字符串是新 Pod 与之前分配竞争的标记 — 与“没有剩余地址”（这是子网耗尽错误，而不是冲突）不同。

确认 IPv6 路径在结构上可用。活动的 Kube-OVN `Subnet` 应报告 `spec.protocol=IPv6` 或 `spec.protocol=Dual`；该字段由 CRD 声明为创建后不可变，因此工作负载的子网必须从一开始就以这种方式定义。Pod 分配的 IPv6（当分配成功时）也可在相应的 `ips.kubeovn.io` 对象的 `spec.v6IpAddress` 字段中看到。

一旦工作负载迁移到 `StatefulSet`，通过强制删除正在运行的 Pod 并观察相同的序号名称返回来验证每个序号至多一个的生命周期。替换保持相同的名称和相同的固定静态 IPv4 + IPv6，重建周期完成而没有任何 `AcquireAddressFailed` 事件 — 在该平台上验证，StatefulSet `dad-pinned-sts` 固定 `10.99.0.30,fd00:dad:7132::30`，新 Pod 在大约九秒后达到 `Running` 状态，且其内部的 `ip -6 addr show eth0` 报告 `inet6 fd00:dad:7132::30/64 scope global`，没有 `tentative` 或 `dadfailed` 标志。

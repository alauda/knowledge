---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500754
sourceSHA: 2914341c30592bdb155bc395191838a6bb43bf03b91c8ef8d1e85512e53a1ebb
---

# 在从虚拟机支持的集群迁移到 ACP 物理节点后诊断 OOMKilled Pods

## 问题

在虚拟机支持的 Kubernetes 集群上正常运行的工作负载，在 Alauda 容器平台的物理节点上可能会出现间歇性的 CrashLoopBackOff，导致被杀死的容器以代码 137 退出，并且 `lastState.terminated.reason=OOMKilled`。在一个代表性的 ACP 集群（服务器 v1.34.5，kubelet v1.34.5，Ubuntu 22.04.1 LTS，内核 5.15.0-56-generic，containerd 2.2.1-5）中，诊断所依赖的上游 kubelet 行为保持不变：`pod.status.containerStatuses[].lastState.terminated` 块暴露了 `exitCode`（必需）、`reason`、`signal`、`containerID`、`startedAt` 和 `finishedAt`，与上游 Kubernetes API 文档完全一致，并且在该集群的多个命名空间（cpaas-system，kube-system）中出现了 137 退出。

退出代码 137 是 Linux 的 `128 + SIGKILL(9)` 约定——内核 cgroup 内存控制器的 OOM-killer 在容器的常驻工作集超过其内存限制时发送 SIGKILL，运行时将其报告给 kubelet，kubelet 将 `OOMKilled` 印入该特定失败模式的终止原因。相同的容器在重复重启时也会触发 `state.waiting.reason=CrashLoopBackOff` 指标，这是 `kubectl describe pod` 显示的可见症状。

## 根本原因

ACP 工作节点通过 cgroup v2 严格执行每个容器的内存限制。读取工作节点上的 kubelet 配置和统计摘要显示 `cgroupDriver=systemd`，`enforceNodeAllocatable=['pods']`，`failSwapOn=true`，以及一个空的 `memorySwap` 映射，节点级内存计量块暴露了 `psi`（压力滞后信息）字段——PSI 是仅适用于 cgroup-v2 的信号，因此其存在独立确认了通过 API 服务器的统一层次结构，而无需在节点上执行。由于交换空间关闭，没有头部空间可以默默吸收超额承诺的限制：容器的每个字节工作集都计入 `memory.max`，内核在工作集超过该上限的瞬间触发 OOM-killer。一个在之前集群中没有呈现相同严格上限的工作负载——例如，因为底层主机允许分配模式超出不足的限制而没有 OOM-kill——在 ACP 物理节点上立即显现出不匹配，因为相同的 pod 在相同的内存限制下现在因相同的分配模式被杀死。解决方案在于工作负载清单，而不是集群：限制必须适应工作负载在该节点上实际需要的真实工作集。

Kubernetes 对象表面用于修复的是标准的上游 pod 规格。`kubectl explain pod.spec.containers.resources.limits` 确认 `limits` 和 `requests` 都是由 `cpu`、`memory` 和 `ephemeral-storage` 键控的 `map[string]Quantity`，内存以二进制 SI 单位（`Ki`、`Mi`、`Gi` 等）表示，并且文档约束请求不能超过限制。kubelet 根据请求与限制的关系推导 pod 的 QoS 类（Guaranteed / Burstable / BestEffort），并且设置了这两个字段的实时 ACP pod 报告 `status.qosClass=Burstable`，与上游计算的完全一致。

## 解决方案

将受影响容器的 `resources.limits.memory` 提高到与工作负载在该节点上实际需要的工作集相匹配，并将 `resources.requests.memory` 提高到相应水平——它不能超过 `limits.memory`，并且是调度程序用于将 pod 放置到具有足够内存的节点上的依据。对工作负载清单的标准合并补丁是以下更改：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      containers:
        - name: my-app
          image: my-app:latest
          resources:
            requests:
              memory: "2Gi"
            limits:
              memory: "4Gi"
```

在发布后，确认 pod 不再以退出代码 137 终止。kubelet 停止将终止原因标记为 `OOMKilled`，并且 `state.waiting.reason` 不再因该失败模式而切换到 `CrashLoopBackOff`。如果工作负载的真实工作集尚不清楚，请在负载下观察并将限制调整到高水位标记并留有余地——之前集群的内存基线并不是 ACP 物理节点的权威参考，因为强制执行表面（严格的 cgroup v2，无交换）不一定与工作负载之前的经历相匹配。

## 诊断步骤

确认本文所述的失败模式。终止原因和退出代码是确定性信号——来自内核 OOM-killer 的 SIGKILL 表现为 `reason=OOMKilled, exitCode=137`，而其他 SIGKILL 来源（探针失败、容器关闭）表现为 `reason=Error, exitCode=137`。区分在于原因字段，而不是退出代码：

```bash
kubectl get pod <pod> -n <ns> -o yaml
kubectl describe pod <pod> -n <ns>
```

`describe` 输出直接从 `status.containerStatuses[].lastState.terminated` 渲染最后状态/原因/退出代码字段。ACP 运行一个原生的上游 apiserver，没有平台特定的覆盖在 pod 状态表面上，因此最后状态/原因/退出代码字段与任何上游 Kubernetes 集群上的 `kubectl` 输出完全一致。

要清点集群中的每个 137 退出（在症状在多个 pod 中间歇性出现而不是一个已知的罪犯时很有用），拉取所有 pod 并过滤终止状态：

```bash
kubectl get pods -A -o json | \
  python3 -c 'import json, sys
data = json.load(sys.stdin)
for p in data["items"]:
    ns, name = p["metadata"]["namespace"], p["metadata"]["name"]
    for cs in p.get("status", {}).get("containerStatuses", []) or []:
        t = (cs.get("lastState", {}) or {}).get("terminated") or {}
        if t.get("exitCode") == 137:
            print(ns, name, cs["name"], t.get("reason"))'
```

具有 `reason=OOMKilled` 的容器是 cgroup-OOM 情况——这些需要提高限制。具有 `reason=Error` 和 `exitCode=137` 的容器是来自其他地方的 SIGKILL（探针失败，手动删除宽限期到期），需要不同的调查路径。在参考 ACP 集群上进行的相同列出发现了四个实时 137 退出（`cpaas-system/apollo`，`cpaas-system/global-alb2` nginx，`kube-system/kube-apiserver`，`kube-system/kube-ovn-monitor`），所有这些都具有 `reason=Error`，而不是 cgroup-OOM 模式——说明了为什么按原因过滤而不是仅按退出代码过滤的重要性。

要直接验证节点是否严格执行 cgroup v2 内存限制（因此，过小的 `limits.memory` 将产生本文所述的 OOMKilled 模式，而不是默默地被超越），通过 API 服务器读取 kubelet 配置和统计摘要：

```bash
NODE=<node-name>
kubectl get --raw "/api/v1/nodes/${NODE}/proxy/configz" | \
  python3 -c 'import json,sys; kc=json.load(sys.stdin)["kubeletconfig"]; \
print({k: kc.get(k) for k in ["cgroupDriver","enforceNodeAllocatable","failSwapOn","memorySwap"]})'
kubectl get --raw "/api/v1/nodes/${NODE}/proxy/stats/summary" | \
  python3 -c 'import json,sys; print(list(json.load(sys.stdin)["node"]["memory"].keys()))'
```

`cgroupDriver=systemd`，`enforceNodeAllocatable=['pods']`，`failSwapOn=true`，以及 `memorySwap={}` 一起意味着节点在没有交换头部空间的情况下强制 pod 内存限制在 cgroup `memory.max` 之内。`stats/summary` 中 `node.memory` 键的 `psi` 存在确认节点处于 cgroup v2 统一层次结构（PSI 是 Linux 上仅适用于 cgroup-v2 的计数器）。

kubelet 从 `requests` 与 `limits` 计算的 QoS 类在 pod 本身上可见，并且决定了在节点内存压力下的驱逐顺序和 OOM 分数调整：

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.status.qosClass}{"\n"}'
```

具有 `requests.memory < limits.memory` 的 pod 报告为 `Burstable`；匹配的请求和限制产生 `Guaranteed`；省略两者则产生 `BestEffort`。Guaranteed pod 是在节点级内存压力下最后被驱逐的，但如果其自身的工作集超过其 `limits.memory`，Guaranteed pod 仍然会被 OOM-kill——QoS 类在 pod 之间的排序中起作用，而不是每个 pod cgroup 上限是否触发。

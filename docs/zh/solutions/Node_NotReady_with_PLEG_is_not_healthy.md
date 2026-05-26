---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500038
sourceSHA: e268a187c984e981652eef22bba3c80fdfe3c754a67106fc363678f1a06449d7
---

# ACP 上的节点 NotReady，kubelet 报告 "PLEG is not healthy"

## 问题

在一个 Alauda 容器平台集群（kube v1.34.5，容器运行时 `containerd://2.2.1-5`）中，一个工作节点变为 `NotReady`，同时 kubelet 在节点的 `Ready` 状态中报告消息 "container runtime is down, PLEG is not healthy"。Ready 状态暴露了标准的上游 `NodeCondition` 字段（`type`、`status`、`reason`、`message`、`lastHeartbeatTime`、`lastTransitionTime`）；在健康节点上 `type=Ready`，`status=True`，`reason=KubeletReady`，消息携带 kubelet 的自由文本。当 kubelet 的 Pod 生命周期事件生成器无法完成其对容器运行时的定期重新列出时，这些字段会显示 PLEG 不健康的文本 \。

## 根本原因

kubelet 的 PLEG 在 CRI 套接字（ACP 上的 `/run/containerd/containerd.sock`）上运行一个持续的重新列出循环，以保持 pod 和容器状态的内存缓存。`kubelet_pleg_last_seen_seconds` 指标是重新列出的心跳——在健康节点上，它大致与墙钟同步，kubelet 在心跳超过重新列出阈值时认为 PLEG 不健康；`kubelet_pleg_discard_events` 计数器跟踪当循环落后时丢弃的事件 \。

每次重新列出的工作量与节点上的 pod 数量成正比，与主机规格无关：在四个其他相同的节点（相同内核、容器运行时、kube 版本）中，`kubelet_pleg_relist_duration_seconds_sum` 累计计数器在承载更多 pod 的节点上更高（33 个 pod 产生约 8967 秒；48 和 49 个 pod 分别产生约 9501 秒和 10785 秒）。重新列出的间隔本身保持接近 1 秒的上游节奏——扩展的是每次传递的成本，而不是循环频率 \。

运行时延迟、死锁或远程 CRI 请求的超时将重新列出工作推向 kubelet 的 `runtimeRequestTimeout`（实时值 `2m0s`），并在 `kubelet_runtime_operations_errors_total{operation_type=…}` 增量中显现——按 CRI 动词（`container_status`、`exec_sync`、`pull_image`、`run_podsandbox`、`remove_container`、`start_container`）分解。运行时的降级会推动这些计数器上升，并在同一窗口中使重新列出循环陷入饥饿状态 \。

第二类停滞发生在 CNI 插件链中。该节点使用 Multus 作为元插件（`00-multus.conf`），委托给 `kube-ovn`（`01-kube-ovn.conflist`），并且 kube-ovn 插件在每次 CNI 调用时访问本地套接字 `/run/openvswitch/kube-ovn-daemon.sock`。该守护进程中的错误或停滞会阻塞 CRI 的 `PodSandbox` 网络状态回调，导致 PLEG 不健康 \。

## 解决方案

在处理 kubelet 或运行时之前，先撤离节点。`kubectl drain` 首先对目标节点进行隔离，然后驱逐非 DaemonSet pod。使用 `--ignore-daemonsets`，每个节点代理（CNI、存储、监控）在维护期间保持运行；独立 pod（无控制器）在没有 `--force` 的情况下被拒绝，这作为一个安全门，防止驱逐没有调度程序管理替代品的工作负载 \：

```bash
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
```

节点被排空后，通过 systemd 重启 kubelet 和容器运行时；ACP 节点上的运行时守护进程是 `containerd.service`（已加载、已启用、在实时捕获中处于活动状态），kubelet 单元名称与上游匹配 \：

```bash
systemctl restart kubelet
systemctl restart containerd
```

使用 `crictl` 清理已退出的容器。ACP 节点提供与容器运行时无关的 `crictl` CLI，通过 `/etc/crictl.yaml` 连接到 containerd 套接字（`runtime-endpoint: unix:///run/containerd/containerd.sock`）；`crictl version` 报告 `RuntimeName: containerd / RuntimeVersion: v2.2.1-5`。`crictl ps -a --state exited` 列出已退出的容器——金丝雀节点观察到 43 个——并且 `crictl rm` 接受带有上游 `--all` / `--force` / `--keep-logs` 标志的 CONTAINER-IDs \：

```bash
crictl ps -a --state exited
crictl ps -a | grep -i Exited | awk '{print $1}' | xargs -r crictl rm
```

以相同方式清理未标记的镜像。`crictl images` 返回标准的 IMAGE / TAG / IMAGE ID / SIZE 列；未标记的镜像显示为 `TAG=<none>`。`crictl rmi` 接受带有 `--all` / `--prune` 的 IMAGE-IDs，因此上游清理形式逐字移植 \：

```bash
crictl images
crictl images | awk '$2=="<none>" {print $3}' | xargs -r crictl rmi
```

设置工作负载的 `requests` 和 `limits` 以保护节点免受 OOM 和 CPU 饥饿，这会降低节点进程（包括运行时）的性能。标准的 `pod.spec.containers.resources` `ResourceRequirements` 结构暴露了 `requests<map[string]Quantity>` 和 `limits<map[string]Quantity>`。kubelet 的 `evictionHard` 阈值——实时值 `memory.available: 100Mi` 和 `pid.available: 10%`——是翻转节点的 `MemoryPressure` 和 `PIDPressure` 状态的信号；在健康集群中，所有节点报告这两个状态为 `False/KubeletHasSufficientMemory` 和 `False/KubeletHasSufficientPID` \：

```yaml
resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

在 kubelet 和 containerd 恢复后，解除节点的隔离：

```bash
kubectl uncordon <node-name>
```

## 诊断步骤

确认节点的 `Ready` 状态是携带 PLEG 消息的表面——标准的上游 NodeCondition 形状适用于 ACP，`type=Ready`，kubelet 的自由文本在 `.message` 中 \：

```bash
kubectl get node <node-name> -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.reason}{"\t"}{.message}{"\n"}{end}'
```

通过节点的代理 `/metrics` 端点读取 kubelet 的 PLEG 指标，以验证心跳是否在推进，并观察每次重新列出的延迟分布；在降级节点上，`kubelet_pleg_last_seen_seconds` 将停止跟踪墙钟，`kubelet_pleg_discard_events` 将增加 \：

```bash
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/metrics" \
  | grep -E '^kubelet_pleg_(last_seen_seconds|discard_events|relist_duration_seconds_(sum|count))'
```

将重新列出的负载与每个节点的 pod 密度相关联。更高的 pod 数量会在共享相同硬件配置的节点上产生更高的累计 `kubelet_pleg_relist_duration_seconds_sum`；这是区分大小问题（将 pod 移走）与运行时问题（调查 containerd）的数据点 \：

```bash
kubectl get pods -A --field-selector spec.nodeName=<node-name> -o name | wc -l
```

读取实时 kubelet 配置（`/configz` 代理）以获取管理 CRI 调用的运行时参数——`containerRuntimeEndpoint`、`runtimeRequestTimeout`（实时 `2m0s`）、`maxPods`（实时 `255`）——以及 `kubelet_runtime_operations_errors_total{operation_type=…}` 计数器，以查看哪些 CRI 动词失败 \：

```bash
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/configz" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['kubeletconfig']; \
                print({k:d[k] for k in ('runtimeRequestTimeout','containerRuntimeEndpoint','maxPods')})"
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/metrics" \
  | grep '^kubelet_runtime_operations_errors_total'
```

检查节点上的 CNI 插件链。配置位于 `/etc/cni/net.d/`（`00-multus.conf` + `01-kube-ovn.conflist`）；在 `/run/openvswitch/kube-ovn-daemon.sock` 上的 kube-ovn 守护进程套接字停滞将阻塞 CRI 的 PodSandbox 网络状态回调。在假设 kubelet 本身有问题之前，检查受影响节点上的守护进程 pod 的健康状况 \：

```bash
kubectl -n kube-system get pod -l app=kube-ovn-cni -o wide --field-selector spec.nodeName=<node-name>
```

检查节点的压力条件，以决定 `requests`/`limits` 调整是否是修复的一部分。`MemoryPressure=True` 或 `PIDPressure=True` 意味着工作负载已超出驱逐阈值，kubelet 本身正在争夺资源 \：

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{range .status.conditions[?(@.type=="MemoryPressure")]}{.type}={.status}{end}{"  "}{range .status.conditions[?(@.type=="PIDPressure")]}{.type}={.status}{end}{"\n"}{end}'
```

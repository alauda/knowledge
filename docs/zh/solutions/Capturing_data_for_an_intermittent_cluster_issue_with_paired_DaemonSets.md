---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500167
sourceSHA: 0b3d39a9b3e49b28b76937e89d3626a382b4f0ceeabad3294240d2e3082c79a3
---

# 通过节点标签的 DaemonSets 收集节点级诊断以解决间歇性问题

## 问题

间歇性、节点本地的症状——偶发的 DNS 解析失败、瞬时数据包丢失、偶尔的线程峰值——很难通过一次性探测捕捉到，因为在操作员打开可疑节点的 shell 时，症状可能已经消失。在 Alauda 容器平台 (Kubernetes v1.34.5, containerd 2.2.1-5 在 Linux 内核 5.15.0-56 上)，一种实用的模式是预先部署两个受自定义节点标签控制的 DaemonSets，以便在操作员选择特定节点之前不运行任何内容，然后在观察到症状时标记目标节点，以便仅在该节点上立即开始收集。DaemonSet 控制器是 ACP 用于其自身平台代理的相同上游原语，并可靠地遵循基于标签的用户工作负载调度。

## 根本原因

必须捕获主机命名空间流量、检查主机线程或运行跟踪样式探测的诊断工作负载需要提升的 Pod 设置——`securityContext.privileged: true`、`hostNetwork: true`、`hostPID: true`，或 `securityContext.capabilities.add: [SYS_PTRACE]`。这些设置不可互换：`hostNetwork: true` 将容器放置在主机网络命名空间中（因此数据包捕获可以看到主机侧流量），而 `hostPID: true` 将其放置在主机 PID 命名空间中（因此 `top -H` / `ps` 可以看到主机进程和线程，而不仅仅是容器自己的）。因此，捕获主机线程特别需要 `hostPID: true`——仅 `privileged: true` 并不会加入主机 PID 命名空间。在 ACP 中，这些设置的准入门控是通过命名空间标签应用的 Pod 安全准入，而不是每个 ServiceAccount 的安全原语：命名空间的 `pod-security.kubernetes.io/enforce` 级别决定了这样的 Pod 是否被允许。针对未标记的命名空间（如 `default`）提交清单会生成对象（API 服务器在 `kubectl create --dry-run=server` 时返回对象），但 apiserver 会对提升的字段发出基线级别的 `Warning`；如果命名空间的强制标签设置为限制级别，则会直接拒绝相同的 Pod。

## 解决方案

在允许特权 Pods 的命名空间中预先部署两个 DaemonSets。标记目标命名空间，以便 PSA 不会拒绝提升的 Pod 规格，然后提交清单。在节点携带激活标签之前，DaemonSet 控制器不会调度任何 Pods，因此工作负载默认处于休眠状态。

```bash
kubectl label namespace <ns> \
 pod-security.kubernetes.io/enforce=privileged --overwrite
```

非特权的 "tester" DaemonSet 运行一个紧凑的轮询循环——每 5 秒执行一次 `getent hosts <name>`——以记录 DNS 解析间歇性失败的时间，并通过 `securityContext.capabilities.add: [SYS_PTRACE]` 授予 `SYS_PTRACE` Linux 能力，以便它可以在自己的进程上运行跟踪样式探测，而无需提升到完全特权。该能力是标准的 core/v1 Pod 规格字段；kubelet 在命名空间的 PSA 级别允许 Pod 后通过 OCI 运行时应用它。

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-diag-tester
spec:
  selector:
    matchLabels:
      app: node-diag-tester
  template:
    metadata:
      labels:
        app: node-diag-tester
    spec:
      nodeSelector:
        node-diag-enable: "true"
      containers:
        - name: tester
          image: <diagnostic-image>
          securityContext:
            capabilities:
              add: ["SYS_PTRACE"]
          command: ["/bin/sh", "-c"]
          args:
            - |
              while true; do
                getent hosts kubernetes.default.svc.cluster.local \
                  || echo "$(date -Is) resolve-failed" >> /var/log/tester.log
                sleep 5
              done
```

特权的 "collector" DaemonSet 运行时设置为 `securityContext.privileged: true`、`hostNetwork: true` 和 `hostPID: true`，以便它可以执行主机级的数据包捕获和进程/线程检查。在这些 Pod 设置下，收集器容器可以携带标准的 Linux 诊断工具——数据包捕获、套接字统计、系统调用跟踪——并在主机网络和 PID 命名空间上运行它们；确切的工具清单取决于镜像，并由操作员在构建时选择。`hostNetwork: true` 将容器放置在主机网络命名空间中，因此 Pod 内的数据包捕获观察到主机命名空间流量，而不仅仅是 Pod 侧接口；`hostPID: true` 将其放置在主机 PID 命名空间中，因此 `top -H` / `ps` 列举主机进程和线程，而不仅仅是容器的。省略 `hostPID: true` 是这里的常见错误——没有它，`top -H` 仅报告收集器容器自己的线程，主机线程快照中没有节点进程。

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-diag-collector
spec:
  selector:
    matchLabels:
      app: node-diag-collector
  template:
    metadata:
      labels:
        app: node-diag-collector
    spec:
      nodeSelector:
        node-diag-enable: "true"
      hostNetwork: true
      hostPID: true
      containers:
        - name: collector
          image: <diagnostic-image>
          securityContext:
            privileged: true
          volumeMounts:
            - name: capture
              mountPath: /capture
      volumes:
        - name: capture
          hostPath:
            path: /var/log/node-diag
            type: DirectoryOrCreate
```

通过应用标签在目标节点上激活收集；DaemonSet 控制器将在下次同步时将测试器和收集器 Pods 调度到确切的标记节点上。标签键由操作员选择——使用任何简短的、大小写一致的键，与其余配方一致（下面的 `node-diag-enable` 是一个示例）——但它必须与两个 DaemonSet 清单中的 `nodeSelector` 匹配。在任何节点携带标签之前，不会调度任何 Pods，工作负载没有占用资源。

```bash
kubectl label node <node> node-diag-enable=true
```

要停止在节点上的收集，请移除激活标签；一旦没有节点匹配 DaemonSet 的 `nodeSelector`，控制器将不再在该节点上调度 Pods。

```bash
kubectl label node <node> node-diag-enable-
```

## 诊断步骤

在节点范围内，特权收集器还运行一个更长的 `tcpdump`，过滤名称解析和链路流量，以捕获来自主机网络命名空间的 DNS 流，并使用 `top -H -b -n 1` 快照主机级线程。`tcpdump` 捕获依赖于 `hostNetwork: true` + `privileged: true`；`top -H` 主机线程快照还依赖于 `hostPID: true`（没有它，`top -H` 仅看到容器自己的线程）。这三个设置必须被命名空间的 PSA 强制级别所允许。

```bash
tcpdump -B 20480 -s 260 -i any -w /capture/<node>-$(date +%s).pcap \
 port 53 or port 5353 or icmp or arp
top -H -b -n 1 > /capture/<node>-top-$(date +%s).out
```

在标记节点之前，确认当前没有节点匹配激活标签——节点侧检查是标签门控正确性的负载承载检查，直到操作员选择目标节点，它应返回 "No resources found"。

```bash
kubectl get nodes -l node-diag-enable=true
```

标记后，验证每个 DaemonSet 的 Pod 是否已在目标节点上运行：

```bash
kubectl get pods -o wide -l app=node-diag-tester
kubectl get pods -o wide -l app=node-diag-collector
```

由主机级捕获生成的工件（来自 `tcpdump` 的 pcap 文件、`strace` 输出和 `top -H` 快照）被写入标记节点上收集器的 hostPath 挂载下，可以通过 `kubectl cp` 从收集器 Pod 中检索，或直接从节点文件系统中提取。

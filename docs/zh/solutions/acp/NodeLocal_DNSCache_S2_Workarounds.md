---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.x,4.3.x,4.4.x'
id: KB261000048
sourceSHA: a143f5509d4a7c374a3f638d64e8940cc6273d1eabd557e30e5715b7c3f41a20
---

# 现场环境中常见 NodeLocal DNSCache 问题的临时解决方法

本文提供了现场环境中三种常见 NodeLocal DNSCache 问题的临时解决方法：

- 当节点上的 `node-cache` Pod 不可用时，DNS 解析受到影响。
- 健康检查端口 `8080` 冲突。
- 外部监控系统或仪表板无法收集 NodeLocal DNSCache 指标。

这些解决方法是临时的。手动更改可能会在插件升级、插件重新安装、平台协调、图表重新渲染或节点重建后被覆盖。请在维护窗口内进行更改。

## 问题 1：当 `node-cache` Pod 不可用时 DNS 解析失败

**症状：** 在 NodeLocal DNSCache 生效后，新创建的 Pods 使用节点本地 DNS 地址作为其 DNS 服务器。如果节点上的 `node-cache` Pod 变得不可用、被驱逐或在升级期间重启，则该节点上的 Pods 可能会出现 DNS 解析失败。

**原因：** 插件安装作业将 kubelet 的 `--cluster-dns` 配置为 NodeLocal DNSCache IP。默认情况下，新创建的 Pods 在 `/etc/resolv.conf` 中仅包含 NodeLocal DNSCache IP，而没有将 CoreDNS ClusterIP 作为额外的 DNS 服务器。

**解决方案：** 将 CoreDNS ClusterIP 配置为 kubelet 的额外 DNS 服务器。配置后，新创建的 Pods 在 `/etc/resolv.conf` 中将同时包含 NodeLocal DNSCache IP 和 CoreDNS ClusterIP。

获取 CoreDNS ClusterIP：

```bash
kubectl -n kube-system get svc kube-dns
```

登录到需要更改的每个节点，然后编辑 kubelet 参数文件：

```bash
vi /var/lib/kubelet/kubeadm-flags.env
```

将 kubelet 的 `--cluster-dns` 从单个 NodeLocal DNSCache IP 更改为 NodeLocal DNSCache IP 和 CoreDNS ClusterIP 的组合。例如：

```text
--cluster-dns=169.254.20.10,10.96.0.10
```

在此示例中，`169.254.20.10` 是 NodeLocal DNSCache IP，`10.96.0.10` 是 CoreDNS ClusterIP。请勿删除同一行上的其他 kubelet 参数。

保存更改后重启 kubelet：

```bash
systemctl restart kubelet
```

kubelet 的 `cluster-dns` 更改仅影响新创建的 Pods。现有 Pods 不会自动更新 `/etc/resolv.conf`。在维护窗口期间重新创建受影响的业务 Pods。例如：

```bash
kubectl -n <namespace> rollout restart deployment/<deployment-name>
kubectl -n <namespace> rollout status deployment/<deployment-name>
```

创建一个临时 Pod，并确认 `/etc/resolv.conf` 中同时包含 NodeLocal DNSCache IP 和 CoreDNS ClusterIP：

```bash
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- cat /etc/resolv.conf
```

预期输出包含类似条目：

```text
nameserver 169.254.20.10
nameserver 10.96.0.10
```

在配置多个 DNS 服务器后，当 NodeLocal DNSCache 不可用时，可以使用 CoreDNS 作为后备，但这并不是一个透明的故障转移机制。使用 musl libc 的镜像（如 Alpine Linux）通常切换更快。使用 glibc 的镜像可能会在多个由 `ndots` 和 `search` 触发的查询中反复等待超时，这可能会在故障期间减慢 DNS 解析速度。

如果工作负载对故障期间的 DNS 解析延迟敏感，请减少受影响工作负载的解析器超时和重试次数：

```yaml
dnsConfig:
  options:
    - name: timeout
      value: "1"
    - name: attempts
      value: "1"
```

此配置可以更快地放弃不可用的 DNS 服务器，但也降低了对瞬态 DNS 延迟或数据包丢失的容忍度。在使用之前请与受影响的工作负载进行验证。

## 问题 2：NodeLocal DNSCache 健康检查使用端口 8080

**症状：** 启用 NodeLocal DNSCache 后，节点上的业务进程、操作智能体或 `hostNetwork` Pod 无法绑定 `127.0.0.1:8080` 或 `0.0.0.0:8080`。

**原因：** `node-cache` Pod 以 `hostNetwork: true` 运行，并在节点回环 `127.0.0.1:8080` 上公开其健康检查端点。当前插件未公开健康检查端口。生成的 Corefile 和 DaemonSet 探针默认使用 `8080`。

```text
health 127.0.0.1:8080
```

```yaml
livenessProbe:
  httpGet:
    host: 127.0.0.1
    path: /health
    port: 8080
```

**解决方案：** 更改 Corefile 的 `health` 端口和 DaemonSet 探针端口。这两个值必须保持一致。

设置资源变量：

```bash
NS=kube-system
DS=node-local-dns
CM=node-local-dns
```

编辑 ConfigMap，并将 Corefile 中的健康检查端口更改为未使用的端口，例如 `18080`：

```bash
kubectl -n "$NS" edit cm "$CM"
```

```text
health 127.0.0.1:18080
```

编辑 DaemonSet，并将 `node-cache` 容器的 `livenessProbe.httpGet.port` 更改为相同的端口：

```bash
kubectl -n "$NS" edit ds "$DS"
```

```yaml
livenessProbe:
  httpGet:
    host: 127.0.0.1
    path: /health
    port: 18080
```

等待 DaemonSet 滚动更新完成：

```bash
kubectl -n "$NS" rollout status ds "$DS"
```

要确认节点端口监听器，请登录到运行 `node-cache` Pod 的节点并运行：

```bash
ss -ltnp | grep ':18080'
ss -ltnp | grep ':8080'
```

预期结果是 `18080` 被 NodeLocal DNSCache 监听，而 `8080` 不再被 NodeLocal DNSCache 监听。

## 问题 3：无法从外部收集 NodeLocal DNSCache 指标

**症状：** 外部监控系统或仪表板无法访问 NodeLocal DNSCache 指标。

**原因：** Corefile 的 `prometheus` 指令可能绑定到 NodeLocal DNSCache IP，例如 `169.254.20.10:9253`。如果外部监控收集路径无法访问该节点本地地址，则无法收集指标。

**解决方案：** 仅更改 Corefile 中的 `prometheus` 监听地址。请勿更改 DNS 服务端口。

设置资源变量：

```bash
NS=kube-system
CM=node-local-dns
DS=node-local-dns
```

编辑 ConfigMap：

```bash
kubectl -n "$NS" edit cm "$CM"
```

将绑定到固定 IP 的 `prometheus` 指令更改为：

```text
prometheus 169.254.20.10:9253
```

改为仅在端口上监听：

```text
prometheus :9253
```

如果目标环境使用的指标端口不是 `9253`，请保留现有端口并仅删除 IP 绑定。

重启 DaemonSet 以应用配置：

```bash
kubectl -n "$NS" rollout restart ds "$DS"
kubectl -n "$NS" rollout status ds "$DS"
```

确认 Corefile 已更新，并验证可以从监控收集路径访问指标：

```bash
kubectl -n "$NS" get cm "$CM" -o yaml | grep 'prometheus'
```

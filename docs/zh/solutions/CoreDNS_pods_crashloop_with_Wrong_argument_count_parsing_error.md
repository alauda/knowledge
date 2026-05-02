---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500017
sourceSHA: 72d3382c2b111f854e6ee663d03031b8143a279b59519d920e3e4ed210d71ea7
---

# CoreDNS Pod 因 "Wrong argument count" 解析错误而崩溃循环

## 问题

DNS Pod 进入 `CrashLoopBackOff` 状态。Pod 日志包含 Corefile 解析错误：

```text
plugin/forward: /etc/coredns/Corefile:19 - Error during parsing:
  Wrong argument count or unexpected line ending after '.'
```

Pod 重启时每次都会发出相同的日志。由于集群的 DNS 服务没有健康的后端，所有工作负载在 Pods 循环期间无法访问集群 DNS。

## 根本原因

注入到 Pods 中的 CoreDNS 配置包含一个不完整的 `forward` 插件块。DNS Operator（或构建 Corefile 的等效操作员）为操作员自定义资源声明的每个区域发出一个 `forward` 块——但如果操作员的 CR 中存在一个区域条目而没有 `forwardPlugin`（没有上游解析器列表，或格式错误的上游条目），则生成的 Corefile 包含一个没有后续参数的 `forward .`（或 `forward <zone>`）行。

CoreDNS 严格解析 Corefiles。`forward` 指令后必须至少跟随一个上游解析器。没有上游的尾随 `.` 会被拒绝，并产生 `Wrong argument count` 错误，导致 Pod 无法启动插件链。Pod 退出，kubelet 重新启动它，循环无限继续。

任何从 CR 构建 CoreDNS Corefile 的操作员都适用相同的情况——一个过时或错误添加的区域条目没有转发器将重现此故障。

## 解决方案

检查操作员管理的 DNS 配置，或者用有效的 `forwardPlugin` 填充区域，或者完全删除区域条目：

```bash
kubectl edit dns.operator default
```

CR 的 `spec.servers` 列表包含以下形式的条目：

```yaml
servers:
  - name: ABC
    forwardPlugin:
      policy: Random
      upstreams:
        - 10.0.0.100
    zones:
      - ABC
  - name: XYZ          # <-- 此条目没有 forwardPlugin
    zones:
      - XYZ
```

可以选择：

### 选项 A — 删除孤立的区域条目

```yaml
servers:
  - name: ABC
    forwardPlugin:
      policy: Random
      upstreams:
        - 10.0.0.100
    zones:
      - ABC
```

保存并退出。操作员重新生成 Corefile，DNS Pods 以有效配置重启，崩溃循环在一次滚动周期内清除。

### 选项 B — 完成区域配置

```yaml
- name: XYZ
  forwardPlugin:
    policy: Random
    upstreams:
      - 10.0.0.200
  zones:
    - XYZ
```

如果该区域是故意添加的，请提供至少一个上游解析器。除非有理由不同，否则使用与现有条目相同的 `policy` 值。

在配置修正后，操作员重新生成 ConfigMap，DNS 部署推出新的 Corefile，Pods 离开 `CrashLoopBackOff`。集群 DNS 在新 Pods 变为就绪后几秒内恢复。

## 诊断步骤

1. 确认故障模式是 Corefile 解析器，而不是无关的崩溃：

   ```bash
   kubectl logs -n <dns-ns> <dns-pod> --previous \
     | grep -i "Error during parsing"
   ```

2. 检查操作员管理的 ConfigMap 中渲染的 Corefile：

   ```bash
   kubectl get configmap -n <dns-ns> -o yaml | yq '.items[].data.Corefile'
   ```

   查找没有上游的 `forward .` 或 `forward <zone>` 行。错误消息中报告的行号指向有问题的条目。

3. 检查操作员 CR 中生成破损行的区域条目：

   ```bash
   kubectl get dns.operator default -o yaml | yq '.spec.servers'
   ```

4. 应用修正后，观察 Pods 恢复：

   ```bash
   kubectl get pods -n <dns-ns> -w
   ```

   新 Pods 达到 `Running` 状态，崩溃循环计数停止增加。

5. 验证集群 DNS 从工作负载 Pod 中功能正常。镜像必须包含 `nslookup`（或 `dig`）；一个普通的 `busybox` 镜像在镜像 Docker Hub 的集群上有效，但在隔离的 ACP 集群上通常无法访问——请用任何包含 `nslookup` 的集群镜像替代：

   ```bash
   kubectl run dnscheck --rm -it --image=<image-with-nslookup> -- nslookup kubernetes.default
   ```

   成功的回答确认 DNS 服务已恢复到健康的后端。

---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500728
sourceSHA: 618d4fcefd7bd590f57ea66845a4d433981f78e47e5be160e6861b65d11319bc
---

# ArgoCD repo-server DNS 查询泄漏上游，原因是 pod ndots:5 搜索扩展

## 问题

Alauda Build 的 Argo CD `argocd-gitops-repo-server` pods 在 `argocd` 命名空间中无法解析应该由集群内 DNS 提供的名称，CoreDNS 后面的上游解析器开始接收看似集群内部的查询。repo-server 随后出现仓库获取或 webhook 目标查找失败，Argo CD UI 可能变得无法访问。

在一个代表性的集群（`v1.34.5`）中，`argocd` 命名空间中的每个 pod 都运行在 `dnsPolicy=ClusterFirst` 且没有 `dnsConfig` 覆盖，因此它们都继承 kubelet 生成的 `/etc/resolv.conf` 默认值。读取驱动该文件的配置确认标准集群服务搜索列表 — `<namespace>.svc.cluster.local`、`svc.cluster.local`、`cluster.local` — 被附加到每个短名称上。

CoreDNS 查询日志中的诊断特征是一个查找，其名称在集群域上粘贴了两次，例如对 `argocd-gitops-repo-server.argocd.svc.cluster.local.argocd.svc.cluster.local` 的 `AAAA` 查询返回 `NXDOMAIN`。

## 根本原因

一个 `dnsPolicy` 为 `ClusterFirst` 且未覆盖 `spec.dnsConfig.options` 的 pod 在 `/etc/resolv.conf` 中接收到 `options ndots:5`，以及集群服务搜索列表和集群内 DNS 服务器地址。该文件列出了命名空间范围、服务范围和集群范围的搜索域，以便 libc 解析器知道如何扩展短服务名称。

在 `ndots:5` 下，libc 解析器查看输入名称：当它包含少于五个点时，解析器依次附加每个搜索域并查询生成的名称，然后才尝试将原始名称作为绝对查询。每个搜索域尝试生成一个连接的查询名称 — 输入名称粘贴上集群后缀 — 例如 `svc.cluster.local.<namespace>.svc.cluster.local` 或 `svc.cluster.local.svc.cluster.local`。

CoreDNS 仅对 `cluster.local` 区域具有权威性，因此不匹配真实服务或 Pod 记录的搜索扩展名称将返回 `NXDOMAIN`；相同的配置将非 `cluster.local` 名称转发到上游。综合效果是，GitOps pod 中的任何名称如果少于五个点 — 包括那些已经以 `.cluster.local` 结尾但在输入形式中只有两个或三个点的名称 — 首先会扩展为多个附加搜索域的查找，每个查找都被 CoreDNS 权威地回答为 `NXDOMAIN`，并且至少有一个可以转发到上游，这就是文章报告的内部查找落到外部 DNS 服务器的症状。

## 解决方案

修复方法是降低受影响 pod 模板中的 `ndots` 阈值，以便解析器首先将短名称视为绝对名称，只有在绝对查找失败时才回退到搜索扩展。`spec.dnsConfig.options` 字段是一个通用的 pod 规格字段，接受一组 `name`/`value` 对并合并到 `dnsPolicy` 生成的基础中。

修补 repo-server pod 模板 — 对于 Alauda Build 的 Argo CD，这是 `argocd` 命名空间中的 `argocd-gitops-repo-server` 部署 — 将 `ndots:1` 设置为：

```yaml
spec:
  template:
    spec:
      dnsConfig:
        options:
        - name: ndots
          value: "1"
```

使用 `kubectl` 应用补丁：

```bash
kubectl -n argocd patch deployment argocd-gitops-repo-server \
  --type=strategic \
  -p '{"spec":{"template":{"spec":{"dnsConfig":{"options":[{"name":"ndots","value":"1"}]}}}}}'
```

在发布后，每个新的 repo-server pod 在 `/etc/resolv.conf` 中接收 `options ndots:1` 而不是默认的 `ndots:5`，而搜索列表和名称服务器保持集群默认值。使用 `ndots:1`，任何至少有一个点的名称首先被查询为绝对名称，因此双后缀扩展路径停止在工作负载上触发。

对于一次性脚本和外部主机名，向名称附加一个尾随点也是有效的。尾随点将名称标记为完全合格，解析器跳过搜索域扩展，直接查询名称，即使 `ndots:5` 仍然生效。

## 诊断步骤

确认 pod 模板仍使用集群默认 DNS 设置 — `dnsPolicy=ClusterFirst` 且空的 `dnsConfig` 块意味着 kubelet 默认的 `options ndots:5` 和集群搜索列表将写入每个新 pod：

```bash
kubectl -n argocd get deployment argocd-gitops-repo-server \
  -o jsonpath='dnsPolicy={.spec.template.spec.dnsPolicy} dnsConfig={.spec.template.spec.dnsConfig}{"\n"}'
```

从运行中的 repo-server pod 内读取实际文件以确认 pod 内解析器配置 — 预期的默认内容是 `search <namespace>.svc.cluster.local svc.cluster.local cluster.local`，集群内 DNS 服务器地址在 `nameserver` 行上，以及 `options ndots:5`：

```bash
kubectl -n argocd exec deployment/argocd-gitops-repo-server -- cat /etc/resolv.conf
```

要观察问题描述的搜索域重新扩展，从 pod 内触发对短名称的查找 — 例如 `kubectl -n argocd exec deployment/argocd-gitops-repo-server -- nslookup <short-name>` — 并检查集群 DNS 查询日志。启用 CoreDNS 查询日志后，输入名称如果少于五个点，会在任何绝对查询之前生成一系列附加搜索域的查询，而双后缀变体返回 `NXDOMAIN`；这就是问题中报告的相同诊断特征，也是工作负载正在命中 `ndots:5` 路径的线级证据。

在应用 `ndots:1` 补丁后，从新的 repo-server pod 进行相同的探测对相同输入名称发出单个绝对查询，不再生成双后缀的 `NXDOMAIN` 查找，这是预期的修复后行为。

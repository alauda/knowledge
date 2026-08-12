---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.x,4.3.x,4.4.x'
---

# NodeLocal DNSCache 8080 端口冲突和 DNS 单点风险的 S2 临时规避方案

## 问题

在 ACP 集群中安装 NodeLocal DNSCache 插件后，可能遇到以下两个运维风险：

- 每个节点上的 `node-cache` Pod 使用 `hostNetwork: true` 运行，并在节点本地监听 `127.0.0.1:8080` 作为健康检查端口。如果业务进程、运维代理或其他节点级组件也需要使用节点本地 `8080` 端口，可能出现端口冲突。
- NodeLocal DNSCache 生效后，新建 Pod 默认使用节点本地 DNS 地址。当某个节点上的 `node-cache` Pod 不可用时，该节点上 Pod 的 DNS 解析可能失败。

## 根本原因

当前 NodeLocal DNSCache 插件未在安装参数中暴露以下配置：

- 健康检查端口。
- kubelet `cluster-dns` 的多 DNS server 配置。

插件生成的资源中，Corefile 和 DaemonSet 探针默认使用 `8080`：

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

同时，插件安装任务会把 kubelet `--cluster-dns` 配置为 NodeLocal DNSCache IP。若需要把 CoreDNS ClusterIP 作为辅助 DNS server，需要由 S2 或实施人员在目标集群中临时修改 kubelet 配置。

## 临时方案

本文包含两个可独立执行的 S2 临时方案：

- 方案一：修改 NodeLocal DNSCache 健康检查端口，规避节点 `8080` 端口冲突。
- 方案二：配置多个 DNS server，将 CoreDNS ClusterIP 作为辅助 DNS，降低节点本地 DNS 不可用时的影响。

这些方案不是持久化产品能力。插件升级、重装、平台调谐、重新渲染 chart 或节点重建后，手工修改可能被覆盖。如需长期使用，应推动产品化支持。

## 方案一：规避 NodeLocal DNSCache 占用节点 8080 端口

该方案适用于业务进程、运维代理或其他节点级组件必须使用节点本地 `8080` 端口的场景。

操作前请确认：

- 已获得目标集群的管理员 kubeconfig。
- 已确认业务侧确实需要释放节点本地 `8080` 端口。
- 已选择一个未被节点上其他组件占用的新端口，例如 `18080`。
- 已安排变更窗口，并确认短时间滚动重启 NodeLocal DNSCache Pod 可接受。

### 1.1 确认 NodeLocal DNSCache 资源名称

在目标集群中查找 NodeLocal DNSCache 的 DaemonSet 和 ConfigMap：

```bash
kubectl get ds -A | grep -i node-local
kubectl get cm -A | grep -i node-local
```

记录实际的命名空间、DaemonSet 名称和 ConfigMap 名称。以下步骤使用默认名称作为示例：

```bash
NS=kube-system
DS=node-local-dns
CM=node-local-dns
NEW_PORT=18080
```

如果实际环境中的资源名称不同，请替换上述变量。

### 1.2 备份当前资源

备份修改前的 ConfigMap 和 DaemonSet，便于回滚：

```bash
kubectl -n "$NS" get cm "$CM" -o yaml > node-local-dns-cm.backup.yaml
kubectl -n "$NS" get ds "$DS" -o yaml > node-local-dns-ds.backup.yaml
```

确认备份文件已生成：

```bash
ls -l node-local-dns-cm.backup.yaml node-local-dns-ds.backup.yaml
```

### 1.3 修改 Corefile 健康检查端口

编辑 NodeLocal DNSCache ConfigMap：

```bash
kubectl -n "$NS" edit cm "$CM"
```

将 Corefile 中的健康检查端口从 `8080` 改为新端口，例如：

```text
health 127.0.0.1:8080
```

改为：

```text
health 127.0.0.1:18080
```

不要修改 DNS 服务端口 `53`，也不要修改 metrics 端口 `9353`。

### 1.4 修改 DaemonSet 探针端口

编辑 NodeLocal DNSCache DaemonSet：

```bash
kubectl -n "$NS" edit ds "$DS"
```

将 `node-cache` 容器的 `livenessProbe.httpGet.port` 从 `8080` 改为同一个新端口：

```yaml
livenessProbe:
  httpGet:
    host: 127.0.0.1
    path: /health
    port: 18080
```

如果目标环境中的 DaemonSet 还包含 `readinessProbe`，并且该探针也访问 `/health` 或 `8080` 端口，需要同步改为同一个新端口。

### 1.5 等待 DaemonSet 滚动更新

修改 DaemonSet Pod 模板后，Kubernetes 会触发 DaemonSet 滚动更新。等待更新完成：

```bash
kubectl -n "$NS" rollout status ds "$DS"
```

确认 NodeLocal DNSCache Pod 均处于运行状态：

```bash
kubectl -n "$NS" get pods -l k8s-app="$DS" -o wide
```

如果环境中的 Pod 标签不是 `k8s-app=<DaemonSet 名称>`，请根据实际 DaemonSet 的 `.spec.selector.matchLabels` 调整查询条件。

### 1.6 验证

确认 ConfigMap 已改为新端口：

```bash
kubectl -n "$NS" get cm "$CM" -o yaml | grep 'health 127.0.0.1'
```

期望输出中的端口为新端口，例如：

```text
health 127.0.0.1:18080
```

确认 DaemonSet 探针端口已改为新端口：

```bash
kubectl -n "$NS" get ds "$DS" -o yaml | grep -A5 -E 'livenessProbe|readinessProbe'
```

期望输出中的探针端口为新端口。

如需确认节点端口占用情况，可登录存在 NodeLocal DNSCache Pod 的节点执行：

```bash
ss -ltnp | grep ':18080'
ss -ltnp | grep ':8080'
```

期望结果：

- `18080` 端口由 NodeLocal DNSCache 进程监听。
- `8080` 端口不再由 NodeLocal DNSCache 进程监听。

最后，从业务 Pod 中验证 DNS 解析正常：

```bash
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- nslookup kubernetes.default.svc
```

期望可以正常解析 `kubernetes.default.svc`。

### 1.7 回滚

如果修改后 NodeLocal DNSCache Pod 异常，或 DNS 解析出现异常，使用备份文件恢复：

```bash
kubectl apply -f node-local-dns-cm.backup.yaml
kubectl apply -f node-local-dns-ds.backup.yaml
kubectl -n "$NS" rollout status ds "$DS"
```

回滚完成后再次确认 Pod 状态和 DNS 解析：

```bash
kubectl -n "$NS" get pods -l k8s-app="$DS" -o wide
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- nslookup kubernetes.default.svc
```

## 方案二：配置 CoreDNS ClusterIP 作为辅助 DNS server

该方案适用于希望降低 NodeLocal DNSCache 单点风险的场景。配置后，新建 Pod 的 `/etc/resolv.conf` 中同时包含 NodeLocal DNSCache IP 和 CoreDNS ClusterIP。

该方案不能保证无感知故障切换。不同业务镜像中的 DNS 解析器重试行为不同；当第一个 DNS server 不可用时，部分工作负载可能需要等待超时后才尝试下一个 DNS server，故障期间 DNS 解析可能变慢。

操作前请确认：

- 已获得目标集群的管理员 kubeconfig。
- 已确认 NodeLocal DNSCache IP，例如 `169.254.20.10`。
- 已确认 CoreDNS Service 的 ClusterIP。
- 已安排变更窗口。修改 kubelet 配置需要重启 kubelet，且现有 Pod 的 `/etc/resolv.conf` 不会自动更新，需要重建受影响 Pod。

### 2.1 获取 CoreDNS ClusterIP

查询 `kube-system` 命名空间中的 DNS Service：

```bash
kubectl -n kube-system get svc kube-dns
```

记录 `CLUSTER-IP` 列的值。以下步骤使用 `10.96.0.10` 作为示例，请替换为实际值。

如果目标集群中的 DNS Service 不叫 `kube-dns`，先查找实际名称：

```bash
kubectl -n kube-system get svc | grep -E 'kube-dns|coredns'
```

### 2.2 修改节点 kubelet 的 cluster-dns

登录需要生效的节点，备份 kubelet 参数文件：

```bash
sudo cp -a /var/lib/kubelet/kubeadm-flags.env /var/lib/kubelet/kubeadm-flags.env.bak.$(date +%Y%m%d%H%M%S)
```

编辑 kubelet 参数文件：

```bash
sudo vi /var/lib/kubelet/kubeadm-flags.env
```

将 kubelet 的 `--cluster-dns` 从单个 NodeLocal DNSCache IP 改为 NodeLocal DNSCache IP 和 CoreDNS ClusterIP 的组合。例如：

```text
--cluster-dns=169.254.20.10
```

改为：

```text
--cluster-dns=169.254.20.10,10.96.0.10
```

其中：

- `169.254.20.10` 是 NodeLocal DNSCache IP。
- `10.96.0.10` 是 CoreDNS ClusterIP。

不要删除同一行上的其他 kubelet 参数。

### 2.3 重启 kubelet

保存配置后，重启 kubelet：

```bash
sudo systemctl restart kubelet
```

如果目标操作系统不使用 systemd，请使用该环境支持的 kubelet 重启方式。

确认 kubelet 恢复运行：

```bash
sudo systemctl status kubelet
```

### 2.4 重建受影响 Pod

kubelet 的 `cluster-dns` 变更只影响新建 Pod。已有 Pod 的 `/etc/resolv.conf` 不会自动更新。

在变更窗口内，重建需要使用多 DNS server 的业务 Pod。重建方式取决于业务控制器类型，例如 Deployment 可以执行滚动重启：

```bash
kubectl -n <namespace> rollout restart deployment/<deployment-name>
kubectl -n <namespace> rollout status deployment/<deployment-name>
```

### 2.5 验证

创建临时 Pod，确认 `/etc/resolv.conf` 中同时包含 NodeLocal DNSCache IP 和 CoreDNS ClusterIP：

```bash
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- cat /etc/resolv.conf
```

期望输出包含类似内容：

```text
nameserver 169.254.20.10
nameserver 10.96.0.10
```

验证 DNS 解析正常：

```bash
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- nslookup kubernetes.default.svc
```

如果集群启用了 NetworkPolicy，需要同时放行 Pod 访问 NodeLocal DNSCache IP 和 CoreDNS ClusterIP 的 TCP/UDP `53` 端口。

### 2.6 节点重建场景的持久化配置

如果集群通过重建节点方式升级，直接修改节点上的 `/var/lib/kubelet/kubeadm-flags.env` 会在节点重建后丢失。需要把同样的多地址 `cluster-dns` 值同步到集群模板中的每一处 `kubeletExtraArgs`：

- `KubeadmControlPlane` → `initConfiguration` → `nodeRegistration` → `kubeletExtraArgs`
- `KubeadmControlPlane` → `joinConfiguration` → `nodeRegistration` → `kubeletExtraArgs`
- `KubeadmConfigTemplate` → `template` → `spec` → `joinConfiguration` → `nodeRegistration` → `kubeletExtraArgs`

示例：

```yaml
cluster-dns: "169.254.20.10,10.96.0.10"
```

### 2.7 回滚

如果配置多个 DNS server 后出现异常，登录已修改的节点，将 `/var/lib/kubelet/kubeadm-flags.env` 恢复为备份文件：

```bash
sudo cp -a /var/lib/kubelet/kubeadm-flags.env.bak.<timestamp> /var/lib/kubelet/kubeadm-flags.env
sudo systemctl restart kubelet
```

然后重建受影响 Pod，使其 `/etc/resolv.conf` 重新生成。

## 长期建议

该问题的长期方案应在产品侧处理，例如：

- 在 NodeLocal DNSCache 插件参数中暴露健康检查端口，并将该参数同时渲染到 Corefile 和 DaemonSet 探针。
- 在 NodeLocal DNSCache 插件或集群配置中支持配置多个 kubelet `cluster-dns` 地址。
- 在后续 DNS 架构演进中评估是否继续默认启用 NodeLocal DNSCache。

在产品化方案交付前，本文仅作为 S2 或实施人员的临时规避手册。

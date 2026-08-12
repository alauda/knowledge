---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.x,4.3.x,4.4.x'
---

# NodeLocal DNSCache 8080 端口冲突和 DNS 单点风险的临时规避方案

## 问题

在 ACP 集群中启用 NodeLocal DNSCache 后，可能出现以下风险：

- `node-cache` Pod 使用 `hostNetwork: true`，并在节点 loopback `127.0.0.1:8080` 上暴露健康检查端点。如果节点上的业务进程、运维代理或 `hostNetwork` Pod 也绑定 `127.0.0.1:8080` 或 `0.0.0.0:8080`，会发生端口冲突。
- NodeLocal DNSCache 生效后，新建 Pod 使用节点本地 DNS 地址作为 DNS 服务器。当某个节点上的 `node-cache` Pod 不可用时，该节点上 Pod 的 DNS 解析可能失败，且不会自动无感切换到 CoreDNS。

## 根本原因

当前 NodeLocal DNSCache 插件只暴露 NodeLocal DNS IP 参数，未暴露健康检查端口或 kubelet 多 DNS server 参数。插件生成的 Corefile 和 DaemonSet 探针默认使用 `8080`：

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

插件安装任务还会把 kubelet `--cluster-dns` 配置为 NodeLocal DNSCache IP。如果需要释放 `8080`，或把 CoreDNS ClusterIP 作为辅助 DNS server，需要临时修改运行中资源或节点 kubelet 配置。

## 解决方案

以下方案仅用于临时规避。插件升级、重装、平台调谐、chart 重新渲染或节点重建后，手工修改可能被覆盖。建议在变更窗口执行，并在修改前保留备份。

### 方案一：修改 NodeLocal DNSCache 健康检查端口

该方案适用于必须释放节点本地 `8080` 端口的场景。需要同时修改 Corefile 中的 `health` 端口和 DaemonSet 探针端口，两个位置必须保持一致。

先确认资源名称，并备份当前资源：

```bash
NS=kube-system
DS=node-local-dns
CM=node-local-dns

kubectl -n "$NS" get cm "$CM" -o yaml > node-local-dns-cm.backup.yaml
kubectl -n "$NS" get ds "$DS" -o yaml > node-local-dns-ds.backup.yaml
```

如果实际环境中的 DaemonSet 或 ConfigMap 名称不同，可通过以下命令查找：

```bash
kubectl get ds -A | grep -i node-local
kubectl get cm -A | grep -i node-local
```

编辑 ConfigMap，把 Corefile 中的健康检查端口改为未被占用的新端口，例如 `18080`：

```bash
kubectl -n "$NS" edit cm "$CM"
```

```text
health 127.0.0.1:18080
```

编辑 DaemonSet，把 `node-cache` 容器的 `livenessProbe.httpGet.port` 改为同一个端口：

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

如果目标环境中还存在访问 `/health` 或 `8080` 的 `readinessProbe`，也需要同步修改。不要修改 DNS 服务端口 `53` 或 metrics 端口 `9353`。

等待 DaemonSet 滚动更新完成，并验证 DNS 解析正常：

```bash
kubectl -n "$NS" rollout status ds "$DS"
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- nslookup kubernetes.default.svc
```

如需确认节点端口监听，可登录运行 `node-cache` Pod 的节点执行：

```bash
ss -ltnp | grep ':18080'
ss -ltnp | grep ':8080'
```

预期 `18080` 由 NodeLocal DNSCache 监听，`8080` 不再由 NodeLocal DNSCache 监听。

### 方案二：配置 CoreDNS ClusterIP 作为辅助 DNS server

该方案适用于希望降低 NodeLocal DNSCache 单点影响的场景。配置后，新建 Pod 的 `/etc/resolv.conf` 中同时包含 NodeLocal DNSCache IP 和 CoreDNS ClusterIP。

该方案不是无感故障切换机制。不同业务镜像中的 DNS 解析器重试行为不同；当第一个 DNS server 不可用时，部分工作负载可能需要等待超时后才尝试下一个 DNS server，故障期间 DNS 解析可能变慢。

先查询 CoreDNS ClusterIP：

```bash
kubectl -n kube-system get svc kube-dns
```

如果目标集群中的 DNS Service 不叫 `kube-dns`，先查找实际名称：

```bash
kubectl -n kube-system get svc | grep -E 'kube-dns|coredns'
```

登录需要生效的节点，备份并编辑 kubelet 参数文件：

```bash
sudo cp -a /var/lib/kubelet/kubeadm-flags.env /var/lib/kubelet/kubeadm-flags.env.bak.$(date +%Y%m%d%H%M%S)
sudo vi /var/lib/kubelet/kubeadm-flags.env
```

将 kubelet 的 `--cluster-dns` 从单个 NodeLocal DNSCache IP 改为 NodeLocal DNSCache IP 和 CoreDNS ClusterIP 的组合。例如：

```text
--cluster-dns=169.254.20.10,10.96.0.10
```

其中 `169.254.20.10` 是 NodeLocal DNSCache IP，`10.96.0.10` 是 CoreDNS ClusterIP。不要删除同一行上的其他 kubelet 参数。

保存后重启 kubelet：

```bash
sudo systemctl restart kubelet
```

kubelet 的 `cluster-dns` 变更只影响新建 Pod，已有 Pod 的 `/etc/resolv.conf` 不会自动更新。需要在变更窗口内重建受影响业务 Pod，例如：

```bash
kubectl -n <namespace> rollout restart deployment/<deployment-name>
kubectl -n <namespace> rollout status deployment/<deployment-name>
```

创建临时 Pod，确认 `/etc/resolv.conf` 中同时包含 NodeLocal DNSCache IP 和 CoreDNS ClusterIP：

```bash
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- cat /etc/resolv.conf
```

预期输出包含类似内容：

```text
nameserver 169.254.20.10
nameserver 10.96.0.10
```

如果集群启用了 NetworkPolicy，需要同时放行 Pod 访问 NodeLocal DNSCache IP 和 CoreDNS ClusterIP 的 TCP/UDP `53` 端口。

## 诊断步骤

确认 NodeLocal DNSCache 是否安装、Pod 是否就绪：

```bash
kubectl -n kube-system get pods -l k8s-app=node-local-dns -o wide
kubectl -n kube-system rollout status ds/node-local-dns
```

确认当前 Corefile 和 DaemonSet 探针是否仍使用 `8080`：

```bash
kubectl -n kube-system get cm node-local-dns -o yaml | grep 'health 127.0.0.1'
kubectl -n kube-system get ds node-local-dns -o yaml | grep -A5 -E 'livenessProbe|readinessProbe'
```

确认新建 Pod 实际使用的 DNS server：

```bash
kubectl run dns-check --rm -it --restart=Never --image=busybox:1.36 -- cat /etc/resolv.conf
```

## 回滚

如果修改健康检查端口后异常，恢复备份的 ConfigMap 和 DaemonSet：

```bash
kubectl apply -f node-local-dns-cm.backup.yaml
kubectl apply -f node-local-dns-ds.backup.yaml
kubectl -n kube-system rollout status ds/node-local-dns
```

如果配置多个 DNS server 后异常，登录已修改节点，将 `/var/lib/kubelet/kubeadm-flags.env` 恢复为备份文件并重启 kubelet：

```bash
sudo cp -a /var/lib/kubelet/kubeadm-flags.env.bak.<timestamp> /var/lib/kubelet/kubeadm-flags.env
sudo systemctl restart kubelet
```

然后重建受影响 Pod，使其 `/etc/resolv.conf` 重新生成。

## 相关说明

如果集群通过重建节点方式升级，直接修改节点上的 `/var/lib/kubelet/kubeadm-flags.env` 会在节点重建后丢失。需要把同样的多地址 `cluster-dns` 值同步到集群模板中的每一处 `kubeletExtraArgs`：

- `KubeadmControlPlane` → `initConfiguration` → `nodeRegistration` → `kubeletExtraArgs`
- `KubeadmControlPlane` → `joinConfiguration` → `nodeRegistration` → `kubeletExtraArgs`
- `KubeadmConfigTemplate` → `template` → `spec` → `joinConfiguration` → `nodeRegistration` → `kubeletExtraArgs`

长期方案应在产品侧处理，例如在 NodeLocal DNSCache 插件参数中暴露健康检查端口，或在插件/集群配置中支持多个 kubelet `cluster-dns` 地址。

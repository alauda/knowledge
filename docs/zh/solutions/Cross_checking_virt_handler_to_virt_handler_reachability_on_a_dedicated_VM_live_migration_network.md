---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500810
sourceSHA: 8a7794bd8fb638095409d45f36d6fe154b0d857472c64e2c5ae519afa9d66ab6
---

# 在专用虚拟机实时迁移网络上交叉检查 virt-handler 之间的可达性

## 问题

当为虚拟机实时迁移配置了专用的 Multus 网络，并且在特定节点之间的一次或多次迁移开始失败时，下一步通常是确认每个 `virt-handler` pod 是否能够通过该次级网络访问每个其他 `virt-handler` pod。在 Alauda 容器平台上，`virt-handler` 作为每个节点的 DaemonSet 在 `kubevirt` 命名空间中运行，pod 的标签为 `kubevirt.io=virt-handler`，并且有一个名为 `virt-handler` 的智能体容器。为了在不每次都运行完整迁移的情况下定位每对连接问题，本文介绍了一种轻量级的成对探测方法——进入每个 `virt-handler`，通过专用迁移接口 curl 对等方的 `/healthz`，并读取 `curl -w` 的 TCP/TLS 握手时间。

## 根本原因

专用虚拟机实时迁移网络是通过将 `HyperConverged.spec.liveMigrationConfig.network` 设置为 Multus `NetworkAttachmentDefinition` 的 `<namespace>/<name>` 来选择的（CRD `network-attachment-definitions.k8s.cni.cncf.io`）；CRD 自身的描述逐字说明了该字段的目的：“迁移将在专用的 multus 网络上进行，以最小化由于网络饱和而导致的租户工作负载中断，当触发虚拟机实时迁移时。” 一旦设置了该字段，`virt-handler` 将其每个 pod 附加到引用的次级网络，Multus 会在每个 pod 上写入 `k8s.v1.cni.cncf.io/network-status` 注释，其值是一个 JSON 数组，包含 `{name, interface, ips, mac}` 条目——每个附加项一个。与专用迁移 NAD 匹配的 `name` 的条目包含每个 `virt-handler` 在该次级接口上使用的 IP。探测的接收端是 `virt-handler` 自己的 `/healthz` HTTPS 端点，TCP 端口为 8443——这是 kubelet 用于其存活性和就绪性探测的相同端点（`httpGet path=/healthz port=8443 scheme=HTTPS`），使用由 `virt-operator` 管理的自签名证书进行 TLS 终止（这就是探测使用 `curl -k` 的原因）。因此，特定对之间的握手失败或显著缓慢将把连接问题定位到这两个节点的迁移网络 NIC 之间的 L2/VLAN 下层，因为两个对等方都运行相同的 `virt-handler` 镜像和证书集。

## 解决方案

首先读取集群的 HyperConverged 指向的 NAD 参考——它是 `spec.liveMigrationConfig.network` 的值：

```bash
NAD=$(kubectl -n kubevirt get hyperconverged kubevirt-hyperconverged \
  -o jsonpath='{.spec.liveMigrationConfig.network}')
echo "$NAD"
```

如果 `NAD` 返回为空，则专用迁移网络尚未连接——首先在 HyperConverged CR 上设置该字段，并让 `virt-handler` 重新滚动，然后在继续之前重新读取该值。

接下来，对于每个 `virt-handler` pod，读取其 `k8s.v1.cni.cncf.io/network-status` 注释，选择与迁移 NAD 匹配的条目，并从其 `ips` 数组中提取第一个 IP——该 IP 是 pod 在专用迁移网络上的地址：

```bash
kubectl -n kubevirt get pods -l kubevirt.io=virt-handler -o json \
  | jq -r --arg nad "$NAD" '.items[]
      | .metadata.name as $name
      | (.metadata.annotations."k8s.v1.cni.cncf.io/network-status"
          | fromjson
          | .[] | select(.name | contains($nad)) | .ips[0]) as $ip
      | [$name, $ip] | join(" ")'
```

然后，对于每个有序对 `(src, dst)` 的 `virt-handler` pods，进入源 pod 的 `virt-handler` 容器并 curl `https://<dst-ip>:8443/healthz`。接收端是 `virt-handler` 自己的存活性/就绪性探测目标，因此成功的响应确认了 TCP 可达性以及接收的 `virt-handler` 是活着的。握手时间来自 `curl` 的写出变量：`time_connect` 是从开始到 TCP 连接完成的累计秒数，`time_appconnect` 是直到 SSL/TLS 握手完成的累计秒数，`time_total` 是整个操作持续的秒数：

```bash
mapfile -t PODS < <(kubectl -n kubevirt get pods -l kubevirt.io=virt-handler -o json \
  | jq -r --arg nad "$NAD" '.items[]
      | .metadata.name as $name
      | (.metadata.annotations."k8s.v1.cni.cncf.io/network-status"
          | fromjson
          | .[] | select(.name | contains($nad)) | .ips[0]) as $ip
      | [$name, $ip] | join(" ")')

for src in "${PODS[@]}"; do
  for dst in "${PODS[@]}"; do
    src_pod=${src%% *}; dst_pod=${dst%% *}
    dst_ip=${dst##* }
    [[ "$src_pod" != "$dst_pod" ]] && {
      echo "$src_pod -> $dst_pod ($dst_ip):"
      kubectl -n kubevirt exec "$src_pod" -c virt-handler -- \
        curl -k -s -o /dev/null \
        -w 'tcp_handshake: %{time_connect}s\ntls_handshake: %{time_appconnect}s\ntotal: %{time_total}s\n' \
        "https://$dst_ip:8443/healthz"
    }
  done
done
```

对于专用低延迟迁移 NIC 在安静的 L2 段上，期望 TCP 握手时间远低于 1 毫秒，TLS 握手时间远低于 10 毫秒，以及任何两个 `virt-handler` pods 之间的总请求时间远低于 15 毫秒。一个健康对的示例输出：

```text
virt-handler-4gv7h -> virt-handler-7d77r (192.168.4.1):
tcp_handshake: 0.000657s
tls_handshake: 0.007440s
total: 0.007879s
```

## 诊断步骤

成对输出中的失败或显著异常指向两个 pods 的节点之间的 L2/VLAN 下层——两个对等方都运行相同的 `virt-handler` 镜像和相同的 `virt-operator` 管理的证书集，因此不对称性必须存在于 KubeVirt 之下。从成对输出中读取的常见模式，所有模式都与每对的 `time_connect` / `time_appconnect` / `time_total` 列进行解释：

- 一个方向超时（连接被拒绝或在 TCP 握手上挂起）：目标节点上附加的 NAD 接口实际上无法从源节点访问——检查底层 VLAN/绑定和目标节点的 L2 路径。
- 双向快速完成 TCP，但 TLS 缓慢或失败：TCP 层可达性完好，但在 8443 端口前的某些东西（在隧道迁移网络上的 MTU/分片、进行检查的防火墙、抖动的电缆）干扰了 SSL 握手。
- 所有对比起低于 1 毫秒 / 低于 10 毫秒 / 低于 15 毫秒的指导均显著缓慢：这是一个全局性问题（饱和、假设为 10Gbps 的低于 1Gbps NIC、NIC 卸载错误），而不是单个 pod 的问题。

对单个对等方的快速抽查，在迭代时有用，使用与循环相同的 `kubectl exec` + `curl -k -w` 原语，但仅针对一个有序对：

```bash
kubectl -n kubevirt exec virt-handler-<src> -c virt-handler -- \
  curl -k -s -o /dev/null \
  -w 'tcp=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s code=%{http_code}\n' \
  https://<peer-migration-ip>:8443/healthz
```

成功的响应代码 `200` 确认 `virt-handler` 在专用迁移网络上从源 pod 的角度是可达且存活的。

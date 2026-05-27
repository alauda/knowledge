---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500183
sourceSHA: 30feb75854dbd4143de220b8a5bc429baeb3a90f6fa5d7a1bee45fb754eb7aeb
---

# 单个 ACP 节点的间歇性镜像拉取 i/o 超时

## 问题

在一个 Alauda Container Platform 集群中（kube-apiserver 镜像 `registry.alauda.cn:60080/tkestack/kube-apiserver:v1.34.5`，Kubernetes `v1.34.5`），一个工作负载 pod 处于 `ImagePullBackOff` 状态，而相同镜像的 pods 在其他节点上正常启动。失败节点的 kubelet 事件显示了 Go 风格的网络错误，格式为 `Failed to pull image "...": ... dial tcp <registry-ip>:443: i/o timeout`，这表明该节点无法在容器运行时的镜像拉取超时窗口内完成与注册表端点的 TCP 握手。

## 根本原因

该错误字符串是由容器运行时在底层 `net.Dial` 到注册表的 HTTPS 端点超过拉取截止时间时逐字发出的。这不是注册表端的拒绝、身份验证问题或清单问题——请求根本没有到达 HTTP。当同一镜像在集群中的其他节点上正确拉取时，故障是局限于受影响节点到注册表的出站网络路径，而不是注册表服务或集群范围的设置。

该集群上的镜像拉取流量来自 kubelet 和节点主机网络栈上的容器运行时，而不是来自 pod 的网络命名空间，因此不受集群中存在的任何 NetworkPolicy 对 pod 网络的强制执行。修复的关键在于节点主机的出站路径——防火墙、网络代理或出站路由上的上游网络设备——而不是任何 Kubernetes 级别的策略对象。

## 解决方案

恢复受影响节点到注册表端点的 TCP/443 可达性。验证节点的出站防火墙规则是否允许注册表 IP 和端口，任何为运行时配置的网络代理是否可达并正确转发，以及节点路径上的中间网络设备是否没有丢弃或限速连接。一旦主机级别到注册表的路径正常，容器运行时的下一个拉取尝试将完成 TCP 握手，pod 将从 `ImagePullBackOff` 状态中恢复。

当注册表是自托管的——在 ACP 中，集群内注册表是 `registry.alauda.cn:60080`，所有工作负载都从中拉取——还需检查注册表自身的服务日志，以获取相同时间窗口的记录。服务端的错误或注册表的速率限制可能与节点端的网络故障同时出现或独立存在，注册表的日志是确认或排除 ACP 上服务端原因的主要地方。

## 诊断步骤

使用运行时的手动拉取工具直接在受影响节点上重现拉取。ACP 节点在 Ubuntu 22.04.1 LTS 上运行 `containerd://2.2.1-5`，因此手动拉取的诊断命令是 `crictl pull`（或 `nerdctl pull`），针对失败 pod 请求的相同镜像引用。如果手动拉取返回相同的 `dial tcp ...:443: i/o timeout`，则故障发生在节点到注册表的网络层，与 kubelet 的镜像拉取记录或任何 pod 级别的配置无关。将失败 pod 的确切镜像引用替换为下面的 `REPO/IMAGE:TAG`（例如 `tkestack/kube-apiserver:v1.34.5`）：

```bash
crictl pull registry.alauda.cn:60080/REPO/IMAGE:TAG
```

通过尝试从第二个健康工作节点进行相同的拉取，将问题定位到单个节点。集群拓扑（一个控制平面加三个工作节点，每个节点都有自己的 InternalIP）使得逐节点比较变得简单：通过 InternalIP 确定拉取超时的节点，并确认至少有一个其他节点完成相同的拉取。在其他节点上成功的拉取并且仅在受影响节点上超时，确认故障与该节点的出站有关，而不是与注册表或集群范围的配置有关。

通过从受影响节点向注册表的 `/v2/` 端点发出未经身份验证的探测，区分网络层故障与注册表端或身份验证端故障。任何符合 OCI Distribution 规范的注册表——包括 `registry.alauda.cn:60080`——在端点可达时，会对未经身份验证的 `GET /v2/` 返回 HTTP `401 UNAUTHORIZED`：

```bash
curl -v https://registry.alauda.cn:60080/v2/
```

该命令返回 `401 UNAUTHORIZED` 响应表明节点到注册表的 TCP/443 路径是开放的，注册表的 HTTP 前端是响应的；因此症状不是网络路径故障，调查应转向凭据或被拉取的特定存储库。相反，`connect: timed out`、`connection refused` 或同一 `curl -v` 的无响应结果表明网络路径本身已损坏，与运行时的 `dial tcp ...:443: i/o timeout` 相匹配，并指向节点的出站防火墙、代理或路由。

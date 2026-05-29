---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500430
sourceSHA: 2d8d1ce49f6cea00b1398fedb66c04f01ec8e4cdaa29ed51c1a9cd618cbcc647
---

# 节点在缺失 /var/lib/kubelet/config.json 后报告 NotReady

## 问题

在运行原生上游 kubelet 的 Alauda 容器平台集群中（在集群 `jingguo-7gm6m` 上观察到，KVM 支持的 Ubuntu 22.04.1 LTS 节点，kubelet 版本为 `v1.34.5`，containerd 版本为 `2.2.1-5`），一个节点在 `kubectl get node` 输出中变为 `NotReady` 并保持该状态。该节点上的 kubelet 未启动，并且没有向 apiserver 发送任何节点状态心跳。上游 kubelet 二进制文件从其启动参数中打开 `/var/lib/kubelet/config.json`，作为由 kubelet 直接驱动的镜像拉取机制所需的 docker-config 风格的容器注册凭据文件。

## 根本原因

当 `/var/lib/kubelet/config.json` 缺失或不可读时，kubelet 无法在该节点上启动——二进制文件无法完成打开此凭据文件的启动路径，因此 kubelet 进程永远无法达到发布 `Ready` 状态的稳定状态（`reason=KubeletReady`，消息 `kubelet is posting ready status`）在其 `Node` 对象上。由于没有 kubelet 运行，`kube-node-lease` 中的每个节点的 `Lease` 不会被续订：kubelet 通常每 `nodeStatusUpdateFrequency=8s` 更新 `Lease.renewTime` 和 `Node.status.conditions.lastHeartbeatTime`，针对 `leaseDurationSeconds=40`。一旦租约未在该宽限窗口内续订，节点生命周期控制器将 `Ready` 状态切换为 `Unknown`，并且 apiserver 将节点报告为 `NotReady`。

## 解决方案

通过从同一集群中任何健康的 `Ready` 节点复制该文件，恢复受影响节点上的 `/var/lib/kubelet/config.json`，其中可以找到具有相同镜像拉取配置的健康对等节点。给定集群中的所有 ACP 节点运行统一的 kubelet 和节点操作系统构建（此处为 `v1.34.5` 在 Ubuntu 22.04.1 上，containerd 为 `2.2.1-5`），因此任何健康节点都是该文件的安全捐赠者；没有 MCO 风格的控制器会覆盖该文件，因此手动恢复的副本在 kubelet 恢复后仍然存在。一旦文件存在且可读，kubelet 将在受影响节点上启动，开始发布 `Ready` 状态并续订其节点租约，apiserver 将节点切换回 `Ready`。

在健康的捐赠节点上读取文件，然后将相同的字节写入受影响节点的 `/var/lib/kubelet/config.json`，权限为 `0600`，归属为 `root:root`。在 ACP 节点上的读写路径可以是直接 SSH 到主机，或者使用 `kubectl debug node/<node-name> --image=<utility-image>` 挂载主机文件系统到 `/host`——kubelet 凭据文件在调试 Pod 的视图中位于 `/host/var/lib/kubelet/config.json`：

```bash
# 从可以通过 SSH 访问健康捐赠节点的工作站
ssh <user>@<healthy-node> sudo cat /var/lib/kubelet/config.json > /tmp/kubelet-config.json

# 将文件推送到受影响节点
scp /tmp/kubelet-config.json <user>@<affected-node>:/tmp/kubelet-config.json
ssh <user>@<affected-node> sudo install -m 0600 -o root -g root \
    /tmp/kubelet-config.json /var/lib/kubelet/config.json

# 在受影响节点上启动 kubelet
ssh <user>@<affected-node> sudo systemctl start kubelet
```

在 kubelet 启动后，通过观察节点切换回 `Ready` 和在宽限窗口内续订租约来确认恢复：

```bash
kubectl get node <affected-node> -o wide
kubectl get lease -n kube-node-lease <affected-node> \
    -o jsonpath='{.spec.renewTime}'
```

## 诊断步骤

识别受影响的节点并确认 apiserver 端的症状：一个节点处于 `NotReady` 状态，`Ready` 条件报告 `status=Unknown`（控制器设置的“缺失心跳”形式），而不是带有 kubelet 编写的消息的 `status=False`。将节点的 `lastHeartbeatTime` 与当前时间进行比较——一个早于 `leaseDurationSeconds=40` 宽限窗口的值确认 kubelet 没有续订其租约：

```bash
kubectl get node
kubectl get node <affected-node> \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")]}'
kubectl get lease -n kube-node-lease <affected-node> \
    -o jsonpath='{.spec.renewTime}'
```

在受影响节点上，确认 kubelet 进程未运行，并且 `/var/lib/kubelet/config.json` 缺失或不可读。kubelet 直接从其启动参数中打开此文件，因此任何读取错误都会导致 kubelet 无法达到运行状态：

```bash
ssh <user>@<affected-node> sudo systemctl status kubelet
ssh <user>@<affected-node> sudo ls -l /var/lib/kubelet/config.json
ssh <user>@<affected-node> sudo journalctl -u kubelet --no-pager | tail -50
```

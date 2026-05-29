---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500429
sourceSHA: 1493786ded15a149fea6570b4e69b403a873a8b8b11d286480dd992b134a42ab
---

# 诊断在 Alauda 容器平台上报告 NotReady 的节点

## 问题

一个节点（`core/v1` 节点）在集群中显示状态为 `NotReady`。健康节点的 Ready 状态来自于该节点主机上的 kubelet：在一个观察到的 Ready 节点（kubelet `v1.34.5`）上，该状态的原因是 `KubeletReady`，消息为 `kubelet is posting ready status`。同样由 kubelet 发布的状态也驱动了伴随节点条件，报告原因为 `KubeletHasSufficientMemory`、`KubeletHasNoDiskPressure`、`KubeletHasSufficientPID` 和 `KubeletReady`。kubelet 的心跳可以通过节点的 `Lease` 中的实时 `renewTime` 在 `kube-node-lease` 中观察到，健康节点上大约每 10 秒更新一次。当 kubelet 停止发布状态时，该心跳停止更新；在配置的 `--node-monitor-grace-period`（在此集群中为 50 秒）内未收到心跳后，节点生命周期控制器将 Ready 状态从 `True` 转换为 `NotReady`。

```bash
kubectl get nodes
kubectl describe node <node-name>
```

## 根本原因

由于 Ready 状态依赖于 kubelet 成功发布状态，因此 `NotReady` 节点通常指向该节点主机上的 kubelet。在检查的工作节点（kubelet `v1.34.5`，Ubuntu 22.04.1 LTS，`containerd://2.2.1-5`）上，kubelet 作为主机 `systemd` 单元运行 — `kubelet.service`，Kubernetes 节点智能体 — 观察到 `active (running)`，在端口 `10250` 上提供服务，并作为节点级事件的源组件。`NotReady` 的一个常见原因是该节点主机上的 kubelet 服务未运行，因此没有状态被发布。第二个常见原因是 kubelet 正在运行，但无法访问 API 服务器端点（集群内的 `kubernetes` 服务端点，观察到为 `192.168.135.152:6443`，`https`），因此其状态更新无法到达。

## 解决方案

当节点为 `NotReady` 时，确认该节点主机上的 kubelet 正在运行，并且如果是，确认它可以访问 API 服务器端点；恢复任一路径可以让 kubelet 恢复发布状态，节点返回到 Ready。

检查节点主机上的 kubelet 服务状态（kubelet 是主机 `systemd` 单元，在健康工作节点上观察到为 `active (running)`）。当 kubelet 未运行时，恢复服务是让其恢复发布状态的关键：

```bash
systemctl status kubelet
journalctl -u kubelet -n 200 --no-pager
```

如果 kubelet 正在运行，确认它可以访问集群中的 API 服务器端点（kubelet 必须能够连接到 API 服务器以发布状态）。从节点主机，apiserver 存活端点通过 `https` 返回 `ok`，确认 kubelet 用于发布状态的网络路径：

```bash
curl -k --max-time 5 https://192.168.135.152:6443/livez
```

## 诊断步骤

检查节点报告的条件；在健康节点上，Ready 状态为 `KubeletReady`，消息为 `kubelet is posting ready status`。实时心跳是节点的 `Lease` 中的 `renewTime` 在 `kube-node-lease` 中，健康时大约每 10 秒更新一次；`renewTime` 停止更新超过 `--node-monitor-grace-period`（在此集群中为 50 秒）会导致节点变为 `NotReady`。

```bash
kubectl get node <node-name> \
  -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.reason}{"\n"}{end}'
kubectl get lease <node-name> -n kube-node-lease \
  -o jsonpath='renew={.spec.renewTime} dur={.spec.leaseDurationSeconds}{"\n"}'
```

在节点主机上，确认 kubelet 服务正在运行；在检查的工作节点上，`systemctl is-active kubelet` 返回 `active`，`journalctl -u kubelet` 显示来自运行中 kubelet 的实时日志行。

```bash
systemctl is-active kubelet
journalctl -u kubelet -n 50 --no-pager
```

从节点主机，验证与 API 服务器端点的连接，以便 kubelet 可以发布状态；当路径正常时，apiserver 存活端点通过 `https` 返回 `ok`。

```bash
curl -k --max-time 5 https://192.168.135.152:6443/livez
```

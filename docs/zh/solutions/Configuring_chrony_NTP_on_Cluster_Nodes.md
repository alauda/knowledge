---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500013
sourceSHA: 0950dd7d70c9b1c651e336094e8b65cc3c9e72b9e2e1985ece8d9d50f636a6fe
---

# 在集群节点上配置 chrony / NTP

## 问题

集群节点需要与特定的 NTP 服务器同步时钟——通常是受限网络内的内部时间源，或具有网络时间安全性（NTS）的强化 NTP 池。每个节点上默认的 chrony 配置指向公共时间服务器，这在某些情况下可能无法访问（隔离或出站控制环境）、不符合政策，或不被信任（没有 NTS）。

问题是如何将自定义的 `/etc/chrony.conf` 推送到每个节点——并在节点重启、节点替换和扩展事件中保持其推送——而不需要在节点之间漂移的临时 SSH 编辑。

## 根本原因

集群节点上的时间同步是节点操作系统的属性，而不是工作负载的属性。在活动节点上编辑 `/etc/chrony.conf` 只在当下有效，但在节点的基础镜像重新应用时（不可变主机重启、PXE 重新映像、云自动扩展替换）会被撤销，从而导致整个集群的 chrony 配置不一致并且静默漂移。

声明式的方法是通过集群级对象驱动 chrony 配置，节点配置控制器将其转换为磁盘上的文件，然后在每次节点启动时重新应用。ACP 通过 **不可变基础设施** 扩展产品和内核中的 `configure/clusters/nodes` 接口公开此功能——两者覆盖相同的原语：“这是一个应该在此池中的每个节点上存在的文件（或 systemd 单元）。”控制器将文件协调到目标路径，并触发受影响节点的协调滚动重启，以便新配置生效，而无需每个主机手动干预。

## 解决方案

### 首选：通过不可变基础设施接口进行声明式节点配置

在 ACP 上，将 chrony 配置作为节点文件对象推送到应该接收它的节点角色。其结构为：节点角色选择器、文件列表（包含目标路径 + 模式 + 内容），以及在文件写入后可选的 systemd 单元重启列表。控制器为每个角色计算渲染的配置，并逐个滚动节点，首先排空工作负载。

一个典型的自定义 `chrony.conf` 针对每个工作节点：

```text
# 应用于工作节点的 /etc/chrony.conf 内容
server time1.internal.example.com iburst
server time2.internal.example.com iburst
driftfile /var/lib/chrony/drift
makestep 1.0 3
rtcsync
logdir /var/log/chrony
```

将该内容包装在工作角色的节点配置资源中，标记其模式为 `0644`，并附加一个后应用触发器以重启 `chronyd.service`。控制器将执行以下操作：

1. 渲染文件并计算该角色的新期望节点配置。
2. 逐个选择节点（遵循池中断预算），并对每个节点进行封锁和排空。
3. 写入文件，重新加载 systemd，重启 `chronyd`。
4. 解锁节点并继续。

对于仅应使用特定时间服务器的节点子集的集群——例如，具有自己现场 NTP 设备的边缘节点——创建第二个节点配置资源，选择器匹配边缘角色，池范围的渲染保持两个集合分开。

在安装时，可以将相同的负载输入到安装程序的额外清单中，以便节点在首次启动时具有正确的 chrony 配置，避免安装后滚动。

### OSS 回退：针对没有不可变基础设施层的集群的 DaemonSet 驱动配置

当集群没有不可变基础设施扩展且节点文件系统可写（不是镜像锁定主机）时，可以使用带有特权初始化容器的 DaemonSet 绑定挂载 `/etc/chrony.conf` 并通过 `nsenter` 进入主机 PID 命名空间重启服务。这是传统的 OSS 模式。它以可移植性换取声明式的滚动行为（没有自动排空，失败时没有回滚）。仅在采用声明式路径的过渡期间使用——它产生的状态不会在集群对象中捕获，因此在节点被替换后会漂移。

无论哪种路径，在将生产流量切换到新源之前，请验证 NTP 可达性。指向不可达服务器的 chrony 配置错误会使节点静默失去同步，随后在几个小时后表现为证书有效性、etcd 和 kubelet 租约错误。

## 诊断步骤

确认渲染的配置已在每个池的示例节点上落地。ACP 的集群级 Pod 安全审查拒绝 `chroot /host`，因此通过调试 Pod 的 `/host` 绑定挂载直接读取主机文件。镜像必须包含相关工具（`cat`、`chronyc`、`systemctl`）；一个普通的 `busybox` 镜像将不包含 `chronyc` 或 `systemctl`。

```bash
kubectl debug node/<node-name> \
  --image=<image-with-shell> -- cat /host/etc/chrony.conf
```

检查 `chronyd` 是否处于活动状态以及它当前跟踪的源。对主机的 `systemctl` 需要一个调试配置文件，该文件挂载主机的 systemd 套接字，而 `chronyc` 通过本地 UNIX 套接字也需要相同的配置：

```bash
kubectl debug node/<node-name> \
  --image=<image-with-chrony-and-systemd> --profile=sysadmin -- \
    sh -c 'systemctl is-active chronyd && chronyc -n sources -v'
```

期望一个或多个以 `^*` 开头的源（当前主源）和低偏移量。以 `^?` 开头的源行表示节点无法到达服务器——检查节点到 NTP 端点的出站规则，使用 UDP/123（或 TCP/4460 用于 NTS）。

查找节点之间的漂移，以捕捉仅部分推出的配置：

```bash
for n in $(kubectl get node -o name); do
  echo "== $n =="
  kubectl debug $n --image=<image-with-chrony> --profile=sysadmin -- \
    chronyc tracking \
    | grep -E 'System time|Reference ID|Stratum'
done
```

`System time` 偏移量超过几百毫秒或在应使用相同源的节点之间存在不同的 `Reference ID` 值都表明推送没有均匀落地。在这种情况下，确认节点配置资源选择器确实匹配异常节点，并且滚动没有被暂停。

在切换到网络时间安全性（NTS）时，chrony 配置必须使用 `server <host> nts`，并且节点必须信任服务器的 TLS 链；否则，chrony 将静默回退到未认证的 NTP。通过以下命令进行验证：

```bash
kubectl debug node/<node-name> \
  --image=<image-with-chrony> --profile=sysadmin -- chronyc authdata
```

非零的 `KeyID` 和接近零的正 `NAK` / `KoD` 计数是预期信号；大量的 NAK 表示 NTS 握手失败，未建立正常的 NTP 会话。

---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: 3392f9653853ffa4bdd486a4a8077f9b97f83d8539d950cf14c6a0aed0d5c87a
---

## 问题

控制平面节点上的 etcd pod 日志记录了重复的警告，形式如下：

```text
W | rafthttp: the clock difference against peer xxxxxxxxxxxxxxxx is too high [4m18.466926704s > 1s]
W | rafthttp: the clock difference against peer xxxxxxxxxxxxxxxx is too high [4m18.463381838s > 1s]
```

在严重情况下，etcd 存活探测开始失败，一个或多个 etcd 成员重启，这可能导致 API 服务器不可用以及集群的级联警报。

## 根本原因

`rafthttp` 在每个 etcd 对等体之间交换的心跳中嵌入了时间戳。在每个帧中，接收方将嵌入的时间戳与其本地时钟进行比较；如果绝对差异超过一秒，则会发出上述警告。日志示例中的几分钟差异意味着两个或多个控制平面节点的系统时钟已经严重偏离。

由于 etcd 将心跳视为对等体存活的权威证据，严重的时钟偏差会与成员健康检查产生不良交互：时钟快几分钟的对等体可能会发送“未来”的心跳，这些心跳会被丢弃，而时钟滞后的对等体可能会完全错过心跳窗口。根本原因几乎总是相同的——至少一个控制平面节点上的 NTP 未正常工作。

## 解决方案

将控制平面节点重新同步到 NTP。一旦时钟趋于一致，`rafthttp` 警告将在几个心跳间隔内停止，etcd 会自行恢复；不需要重启 etcd。

1. 确定哪些节点相对于其他节点存在时钟偏差。对每个控制平面节点运行 timedatectl 检查：

   ```bash
   for NODE in $(kubectl get nodes -l node-role.kubernetes.io/control-plane= -o name); do
     echo "-------- $NODE --------"
     kubectl debug -q "$NODE" -- chroot /host bash -c "hostname; timedatectl"
     echo
   done
   ```

   注意 `System clock synchronized:` 行。如果为 `no`，则表示内核不满意 chrony（或节点操作系统中使用的其他 NTP 实现）保持时钟对齐。

2. 在每个受影响的节点上，确认 chrony 正在运行并且至少有一个可达的上游源：

   ```bash
   kubectl debug node/<name> -- chroot /host chronyc tracking
   kubectl debug node/<name> -- chroot /host chronyc sources -v
   ```

   如果守护进程已停止，请启动它；如果没有可达的源，请修复 NTP 服务器列表或 UDP/123 的防火墙路径。

3. 为了持久配置，通过节点配置通道更新节点 NTP 配置，以便替换节点继承相同的 NTP 设置。单个手动编辑的 `chrony.conf` 在活动主机上不会在节点替换时存活。

4. 等待几分钟并确认 etcd 日志安静：

   ```bash
   kubectl -n cpaas-system logs -c etcd <etcd-pod> | grep "clock difference against peer"
   ```

   在 NTP 修复后没有新匹配项，确认集群的时间已恢复一致。

## 诊断步骤

首先检查 etcd pod 日志以确认哪些对等体受到影响——警告中的对等体 ID 告诉您是单个成员不同步还是整个集群已经漂移：

```bash
for POD in $(kubectl -n cpaas-system get pod -l app=etcd -o name); do
  echo "===== $POD ====="
  kubectl -n cpaas-system logs -c etcd "$POD" | grep "clock difference against peer" | tail -5
done
```

如果 `kubectl debug node/<name>` 不可用（例如，节点为 `NotReady` 或无法拉取调试镜像），请回退到 SSH 连接节点的主 IP：

```bash
CONTROL_IPS=$(kubectl get nodes -l node-role.kubernetes.io/control-plane= -o jsonpath='{.items[*].status.addresses[?(@.type=="InternalIP")].address}')
for IP in $CONTROL_IPS; do
  ssh -o StrictHostKeyChecking=no "$IP" "hostname; timedatectl"
done
```

在事件发生时捕获 chrony 状态以便事后分析：

```bash
journalctl -u chronyd --since "1 hour ago"
chronyc sourcestats -v
chronyc tracking
```

一个仅指向控制平面节点本身的 NTP 服务器列表，或指向一个已经消失的单一上游，是现场最常见的根本原因。将每个集群节点指向相同的一组外部（或负载均衡的）NTP 服务器，以便所有三个控制平面节点在同一参考时间上趋于一致。

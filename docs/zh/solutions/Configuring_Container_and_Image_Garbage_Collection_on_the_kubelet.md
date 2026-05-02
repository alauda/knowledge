---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500005
sourceSHA: c96a4f5dffd61a1b9471846d99035def67af4e6effdc921811c4d1e69c0385b9
---

## 概述

每个工作节点上的 kubelet 持续从本地容器运行时回收资源。两个相关机制驱动这一过程：

- **容器垃圾回收** — 定期删除属于已终止或被替换的 Pod 的死容器。
- **镜像垃圾回收** — 一旦磁盘压力超过阈值，定期删除未使用的容器镜像。

这两种行为默认启用，并且阈值设置较为保守。运维人员很少需要禁用它们；常见的任务是对它们进行*调优*，以确保节点在频繁变更（频繁发布、批处理作业节点、每天拉取多个标签的开发集群）时不会耗尽磁盘空间。

本文描述了参数、在 Alauda 容器平台上设置它们的位置，以及如何验证更改是否在节点上生效。

## 解决方案

### 参数的位置

kubelet 从每个节点上的 YAML 文件读取其配置（大多数发行版为 `/var/lib/kubelet/config.yaml`）。垃圾回收参数与驱逐阈值一起存在：

```yaml
# /var/lib/kubelet/config.yaml — 仅相关字段
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# --- 容器 GC ---
# 一旦节点上有超过这个数量的已终止容器，kubelet
# 开始优先删除最旧的容器。
maxContainersPerPod: 1                 # 过时；使用 maxPerPodContainerCount
maxPerPodContainerCount: 1             # 每个 Pod 保留的最大死容器数量
maxContainerCount: 100                 # 节点上保留的最大死容器数量

# --- 镜像 GC ---
# 一旦 imagefs 使用率超过 HighThresholdPercent，kubelet 删除
# 未使用的镜像，直到使用率降到 LowThresholdPercent 以下。
imageGCHighThresholdPercent: 85        # 默认 85
imageGCLowThresholdPercent: 80         # 默认 80
imageMinimumGCAge: 2m                  # 不对小于此年龄的镜像进行 GC

# --- 驱逐（节点压力）---
# 触发 Pod 驱逐的软阈值和硬阈值；与镜像 GC 一起调优，
# 以确保节点不会频繁波动。
evictionHard:
  memory.available:   "100Mi"
  nodefs.available:   "10%"
  nodefs.inodesFree:  "5%"
  imagefs.available:  "15%"
  imagefs.inodesFree: "5%"
evictionSoft:
  memory.available:   "200Mi"
  nodefs.available:   "15%"
evictionSoftGracePeriod:
  memory.available:   "1m30s"
  nodefs.available:   "1m30s"
```

驱动驱逐子系统的变量映射到运行时测量如下：

```text
memory.available    := node.status.capacity[memory] - node.stats.memory.workingSet
nodefs.available    := node.stats.fs.available
nodefs.inodesFree   := node.stats.fs.inodesFree
imagefs.available   := node.stats.runtime.imagefs.available
imagefs.inodesFree  := node.stats.runtime.imagefs.inodesFree
```

### 如何在节点池中应用更改

在 Alauda 容器平台上，kubelet 配置在节点池级别通过 `configure/clusters/nodes` 管理。编辑相关池的 kubelet 配置文件，设置所需的 GC 和驱逐值，让平台将更改推送到每个成员节点。平台按顺序序列化发布，逐个排空节点，重启 kubelet，并在节点变为 Ready 后再继续下一个。

对于没有平台界面的隔离环境或单节点环境，等效的编辑是直接进行：

```bash
# 在节点上 — 仅用于记录；上述平台管理的流程
# 在可用时更为推荐。
sudo cp -a /var/lib/kubelet/config.yaml /var/lib/kubelet/config.yaml.bak
sudo $EDITOR /var/lib/kubelet/config.yaml
sudo systemctl restart kubelet
```

重启 kubelet 会暂时使节点从 API 服务器的心跳中掉线 — 请在维护窗口期间安排更改，或使用平台管理的流程，该流程会为您处理排空/封锁。

### 针对工作负载配置的推荐调优

| 工作负载                                            | 显著的 kubelet 设置                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 长期运行的服务，发布不频繁                          | 默认设置即可。                                                                                                                           |
| 批处理 / CI 工作负载（许多短暂的 Pod）              | 将 `maxContainerCount` 降至 50，以减少死容器的杂乱；将 `imageMinimumGCAge` 降至 30s，以便快速回收瞬态镜像。 |
| 拉取多个镜像标签的开发集群                        | 将 `imageGCHighThresholdPercent` 降至 75，将 `imageGCLowThresholdPercent` 降至 70，以确保在长时间工作期间磁盘不会填满。            |
| 拥有单独 `/var/lib/containers` 分区的节点         | 独立于 `nodefs.available` 调整 `imagefs.available` 驱逐；检查 `crictl info` 以获取运行时报告的 imagefs 路径。          |

## 诊断步骤

检查 kubelet 的 *实时* 配置（它实际使用的解析配置，而不是磁盘上的文件 — 在排查漂移时非常有用）：

```bash
NODE=<worker-node-name>
kubectl get --raw "/api/v1/nodes/${NODE}/proxy/configz" | jq .
```

响应中的 `kubeletconfig` 块包含 kubelet 应用的每个默认值，包括 YAML 未显式设置的那些。

检查正在运行的 kubelet 进程的 GC 值：

```bash
kubectl debug node/${NODE} -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host sh -c 'grep -E "GC|eviction" /var/lib/kubelet/config.yaml'
```

通过尾随 kubelet 日志确认垃圾回收正在工作：

```bash
kubectl debug node/${NODE} -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host journalctl -u kubelet --since "10 minutes ago" | grep -iE 'image_gc|container_gc|evict'
```

健康的节点会记录偶尔的 `image_gc_manager` 行，报告回收了多少字节以及删除了哪些镜像；重复的驱逐行表明阈值对于工作负载来说过于紧张。

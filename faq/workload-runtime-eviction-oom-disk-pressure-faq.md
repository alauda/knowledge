---
title: ACP Workload Runtime Eviction / OOM / Disk Pressure FAQ
type: faq
status: active
domain: workload-runtime
product: acp
tags: [acp, workload-runtime, faq, eviction, oom, memory-pressure, disk-pressure]
updated: 2026-05-15
source: [official-docs, experience]
related:
  - ../notes/workload-runtime-triage-quick-card.md
  - ../faqs/workload-runtime-resource-units-operator-path-faq.md
  - ../faqs/workload-runtime-probe-readiness-hpa-faq.md
  - ../learning-progress.md
---

# ACP Workload Runtime Eviction / OOM / Disk Pressure FAQ

这页只处理一组高频又很容易混的问法：
- `Evicted`
- `OOMKilled`
- `MemoryPressure`
- `DiskPressure`
- 为什么 Pod 被赶走 / 为什么节点不再接收新 Pod

重点不是重复 Kubernetes 常识，而是把 ACP 官方文档里和现场最相关的口径压平。

---

## 1. Pod 被标成 `Evicted`，是不是等于应用自己崩了？
不一定。

`Evicted` 更常表示：
- **节点**检测到资源压力
- kubelet 依据 eviction policy 回收资源
- Pod 被系统层面终止并进入 `Failed`

也就是说，它更像“节点为了保命把 Pod 赶走”，不一定是应用进程自己 crash。

一句话：
> `Evicted` 先看节点压力，不要先把锅扣到应用代码。

---

## 2. `Evicted` 和 `OOMKilled` 是一回事吗？
不是。

### `Evicted`
- 触发者更像 **kubelet eviction policy**
- 背景常见是 `MemoryPressure` 或 `DiskPressure`
- 目标是节点级资源回收

### `OOMKilled`
- 触发者更像 **Linux OOM killer**
- 背景是内存已经顶到系统无法继续维持
- 会优先杀掉 OOM 分数更高的容器

一句话：
> `Evicted` 是节点主动回收；`OOMKilled` 是系统扛不住后的强制击杀。

---

## 3. 为什么节点已经有 eviction policy，还会发生 OOMKilled？
因为 eviction 是“尽量提前回收”，不是绝对兜底。

官方文档明确给出的边界是：
- 如果在内存真正回收到位前就发生系统级 OOM
- 那还是会进入 OOM killer 路径

常见原因：
- 阈值太激进或太晚
- 资源突刺太快
- system daemons 占用超出预留
- 节点本身 reserved / allocatable 配置不合理

一句话：
> eviction 解决的是“提前刹车”，不是“永远不会撞车”。

---

## 4. `MemoryPressure` 出现时，调度会发生什么？
官方口径很关键：
- 节点出现 `MemoryPressure` 时，调度器不会再把 **BestEffort Pods** 调度上去

这意味着：
- 不是所有 Pod 一律都不能调度
- 但调度已经开始保守，尤其对低保障 QoS 更不友好

如果现场看到：
- 某些 Pod 还能上
- 某些低保障 Pod 上不去

别急着说“调度器异常”，这可能就是压力条件下的正常行为。

---

## 5. `DiskPressure` 出现时，为什么新 Pod 基本上不再进来？
因为官方文档给出的调度行为是：
- 节点出现 `DiskPressure` 时，**不会再调度额外 Pod**

而且磁盘压力下，kubelet 会先尝试：
- 清理 dead pods / dead containers
- 清理 unused images

清不下来，才继续走 Pod eviction。

一句话：
> `DiskPressure` 先做垃圾回收，回收不够再赶 Pod；同时新调度会明显收紧。

---

## 6. 为什么明明看起来“磁盘还有空间”，Pod 还是因为磁盘问题被驱逐？
因为磁盘压力不只看一个维度。

官方文档至少区分：
- `nodefs.available`
- `nodefs.inodesFree`
- `imagefs.available`
- `imagefs.inodesFree`

所以有几种常见误判：
- 空间还够，但 **inode 不够**
- 根盘还好，但 **imagefs 已经吃满**
- 容器镜像层和节点根盘看的是不同文件系统

一句话：
> “还有空间”不代表没有 `DiskPressure`，inode 和 imagefs 经常才是真正卡点。

---

## 7. 为什么启用了 swap 以后，内存压力判断反而不准？
官方文档直接给了一个硬边界：
- **如果节点启用了 swap，就无法检测 memory pressure**

所以现场如果要解释：
- 为什么节点没及时进入 memory-based eviction
- 为什么资源压力判断怪异

先看 swap，不要只盯着 Pod 本身。

一句话：
> 想靠内存驱逐兜底，swap 先别开。

---

## 8. QoS 和 eviction / OOM 有什么关系？
关系非常大。

官方文档给出的核心口径：
- Pod eviction 会按 **QoS + 资源消耗** 排序
- OOM killer 也会根据 QoS 映射到不同的 `oom_score_adj`

大体理解：
- **BestEffort**：最脆，最容易先出事
- **Burstable**：看 request 基线和实际消耗
- **Guaranteed**：保护级别最高，但不是绝对不死

尤其要记住：
- Guaranteed Pod 只有在系统 daemons 超过 reserved 或只剩 Guaranteed Pod 时，才更可能被逼到 eviction

一句话：
> QoS 决定谁更容易先被牺牲，BestEffort 最先挨刀，Guaranteed 只是更抗，不是免死。

---

## 9. 为什么 DaemonSet Pod 看起来总是被“赶走了又回来”？
因为官方文档明确提示：
- DaemonSet Pod 被驱逐后会被立即重建

所以如果 DaemonSet 自己又是 BestEffort 或资源过低：
- 它会在资源紧张节点上不断回来
- 现场看起来就像“怎么删不干净 / 怎么反复复活”

官方建议方向也很明确：
- DaemonSet 尽量避免 BestEffort
- 尽量给出更稳的 QoS 保证

---

## 10. `request` / reserved / eviction threshold 为什么要一起看？
因为这三者共同决定：
- 节点可分配资源 `allocatable`
- 什么时候开始进入压力状态
- Pod 是否会在调度后把节点顶穿

官方文档强调的一个关键点：
- 仅靠调度并不能保证不会耗尽节点
- 如果 `system-reserved`、`kubeReserved`、eviction thresholds 配不合理，节点还是会被业务压穿

所以看到：
- “明明能调度，怎么还是 OOM / eviction”

不要惊讶，这恰恰是 allocatable 与 pressure threshold 之间没配稳时的典型现象。

---

## 11. Pod 被驱逐后，第一反应应该先看什么？
建议先按这条最短路径：

1. 看 Pod 是 `Evicted` 还是 `OOMKilled`
2. 看节点 condition：`MemoryPressure` / `DiskPressure`
3. 看节点是 `nodefs`、`imagefs` 还是 inode 问题
4. 看 workload QoS：BestEffort / Burstable / Guaranteed
5. 看 namespace / workload request-limit 是否过低或失真
6. 看 node reserved / eviction policy / swap 状态

一句话：
> 先分“节点驱逐”还是“系统杀进程”，再看 pressure signal，不要直接从应用日志开始猜。

---

## 12. 这类问题更适合沉淀成 FAQ 还是 Runbook？
这组内容先做 FAQ 很值，因为它最先解决的是口径混乱：
- `Evicted` vs `OOMKilled`
- `MemoryPressure` vs `DiskPressure`
- QoS / reserved / allocatable / threshold 的关系

后续如果继续深化，最适合再长出一页 runbook：
- **workload runtime eviction / node pressure runbook**
- 更偏执行步骤：看哪些指标、查哪些 node fields、如何判断是 imagefs 还是 nodefs 问题

---

## 13. 一句话总口径

> `Evicted` 先看 kubelet 的节点级资源回收，`OOMKilled` 先看系统级内存击杀；`MemoryPressure` 和 `DiskPressure` 不只是“资源少了”这么简单，还会直接改变调度行为，而 QoS、reserved、swap、inode/imagefs 才是现场最容易被漏掉的关键边界。

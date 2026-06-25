---
title: ACP Workload Runtime Probe Readiness HPA FAQ
type: faq
status: active
domain: workload-runtime
product: acp
tags: [acp, workload-runtime, faq, probes, readiness, hpa, pod]
updated: 2026-05-15
source: [official-docs, experience]
related:
  - ../notes/workload-runtime-triage-quick-card.md
  - ../notes/workload-runtime-pod-startup-checklist.md
  - ./workload-runtime-faq.md
  - ../learning-progress.md
---

# ACP workload runtime：probe / readiness / HPA FAQ

这页不再泛谈所有 Pod 问题，只压一组最容易答混的现场问法：
- Pod 明明 Running，为什么业务还是不通
- 为什么老重启
- 为什么 HPA 不触发 / 结果很怪
- readiness、liveness、startup 到底怎么分

---

## 1. Pod 都是 Running 了，为什么服务还是没流量？
因为 `Running` 和 `Ready` 不是一回事。

一个 Pod 可以：
- 进程已经在跑
- 状态显示 Running
- 但因为 `readinessProbe` 失败，**没有进入 Service Endpoints**

这时从业务侧看就会像：
- Pod 活着
- 但服务不接流量

最短判断：
> `Running` 先说明容器起来了，`Ready` 才更接近“能接业务流量”。

---

## 2. liveness 和 readiness 到底有什么本质区别？
别把它们当两个差不多的名字。

- **livenessProbe**：判断“这个容器该不该被重启”
- **readinessProbe**：判断“这个 Pod 该不该接流量”

结果差异很大：
- liveness 失败 → 可能触发容器重启
- readiness 失败 → 主要把 Pod 从 Service Endpoints 里摘掉，不一定重启

所以现场看到：
- **老重启** → 先查 liveness / startup
- **Running 但不服务** → 先查 readiness

---

## 3. startupProbe 有什么用，为什么慢启动应用特别需要它？
`startupProbe` 是给慢启动应用兜底的。

官方语义是：
- 在 startup probe 成功之前
- liveness 和 readiness 都不会开始执行

这意味着：
- 应用启动很慢时
- 如果你没有 `startupProbe`
- 很可能 liveness 先开始打，然后把还没启动完的应用误杀

一句话说：
> 慢启动应用不用 startupProbe，最常见结果就是“其实没坏，但被自己配置杀了”。

---

## 4. 为什么 Pod 会一直重启，但业务本身未必真的崩了？
高频情况是：
- liveness probe 过于激进
- path / port / command 配错
- timeout / initialDelay / failureThreshold 不合理
- 探针依赖了重外部链路，偶发超时就被当成应用死掉

所以“重启”不一定先说明业务逻辑崩溃，很多时候先说明：
- probe 配置本身不适配

---

## 5. HTTP probe 成功条件是什么？
官方口径很直接：
- HTTP probe 返回码在 **200-399** 之间算成功

所以现场别把它误解成：
- 只有 200 才成功

但也别反过来误解成：
- 任何返回内容都算成功

关键还是：
- path 正确
- port 正确
- 应用确实在那个端点上暴露了可用检查

---

## 6. exec / TCP / HTTP 三种 probe 该怎么理解？
可以这样分：

- **HTTP GET**
  - 适合 Web 服务 / API
  - 最适合检查“接口是否能正常响应”
- **exec**
  - 适合容器内检查某个命令或内部状态
  - 关键是命令必须真实可执行，退出码要是 0
- **TCP Socket**
  - 适合数据库 / 中间件这类先看端口是否可连

一线别一上来就觉得 HTTP 一定最好。
选 probe 类型，要看应用暴露方式。

---

## 7. HPA 不触发，第一反应该先看什么？
先别直接怪 HPA 控制器。

官方文档给的最短前提是：
- **监控组件已部署并健康**
- 指标已经可见
- HPA 本身 min/max replicas 合理

另外还要接受一个事实：
- 指标可见和 HPA 决策**不是瞬时**的
- 文档明确提到，指标出现可能要 **1-2 分钟**
- HPA control loop 默认也有同步周期

所以刚创建完就说“HPA 不工作”，常常只是看早了。

---

## 8. 为什么 readiness 会影响 HPA？
这是现场很容易漏掉的一层。

官方说明里很关键的一点是：
- **未 Ready 的 Pod** 在 HPA 里会被特殊处理
- scale up 时，它们的 CPU 可能按 0 看
- scale down 时，会被忽略或更保守地处理

这意味着：
- readiness 不是只影响流量接入
- 它还会影响 HPA 对当前负载的判断

一句话说：
> readiness 配得不对，可能同时把“服务接流量”和“HPA 缩扩容判断”一起搞歪。

---

## 9. 为什么 memory-based HPA 看起来经常“不聪明”？
因为内存指标并不是所有业务都适合拿来做缩扩容。

官方特别强调：
- memory-based autoscaling 更适合那种**副本数变化会明显改变单 Pod 内存占用**的场景
- 如果应用内存主要是缓存、常驻对象、JVM 特性或历史数据占用
- 副本增减未必会线性改变单 Pod 内存

这时就会出现：
- HPA 按内存做判断
- 但业务行为并不符合这个假设
- 结果看起来就“怪”

---

## 10. 为什么 HPA 指标缺失时，看起来不是简单报错，而是行为很保守？
因为 HPA 本身就有稳定性保护逻辑。

官方描述里提到：
- 对没有已知 metrics 的 Pod
- scale up 和 scale down 会采用不同的保守处理口径

所以现场表现可能不是“完全不算”，而是：
- 不敢轻易扩
- 不敢轻易缩
- 结果看起来像“很迟钝”

这通常不是它傻，而是它在避免因为数据不完整做出激进决策。

---

## 11. 为什么 Pod 起不来时，不能一上来就怪 probe？
因为 probe 只是在 **Pod 已经进入一定运行阶段后** 才开始变得关键。

如果 Pod 还卡在：
- Pending
- ImagePullBackOff
- 挂载失败
- command / args / env 错误
- init container 失败

那时候更早的根因层其实是：
- 调度资源
- 镜像拉取
- 卷挂载
- 容器启动

一句话说：
> probe 很关键，但它不是所有 Pod 问题的第一层原因。

---

## 12. 现场最短怎么先把 Pod / probe / HPA 问题分层？
可以先这样问：

1. **Pod 是 Pending、CrashLoopBackOff，还是 Running 但不服务？**
2. **失败的是 startup、liveness，还是 readiness？**
3. **Service endpoints 里有没有这个 Pod？**
4. **监控组件和指标现在是否正常可见？**
5. **如果是 HPA，min/max replicas、quota、target threshold 合不合理？**

---

## 13. 一句话口径

> Pod Running 不等于业务可用；先分清是 startup/liveness/readiness 哪一层，再判断是不是 HPA 指标、readiness 语义或 probe 配置本身导致的现象，别把“重启、没流量、不扩容”混成一类问题。

## 2026-06-05 补充：HPA 已经扩容后为什么不按页面使用率缩容？

先别直接判 HPA 失效。HPA 的 CPU 利用率通常按 `request` 口径计算，而很多页面或用户预期容易按 `limit` 口径理解。

最短换算：

> HPA 目标阈值 ≈ 预期展示阈值 / (`request` / `limit`)

现场处理顺序：
- 看工作负载 `resources.requests.cpu` 和 `resources.limits.cpu`
- 看 `kubectl describe hpa` 的当前指标和目标指标
- 确认用户说的“20%”是页面口径、limit 口径，还是 HPA 当前指标口径
- 再调整 target / request / limit，并考虑缩容稳定窗口

关联案例：
- [TICKET-1326623534](../../../ticket-documents/cases/TICKET-1326623534%20弹性扩容后，不会缩容.md)

---
title: ACP Service Mesh Traffic / Security FAQ
type: faq
status: active
domain: service-mesh
product: acp
tags: [acp, service-mesh, istio, asm, faq, ingress-gateway, mtls, cni]
updated: 2026-05-15
source: [official-docs]
related:
  - ../notes/service-mesh-taxonomy-quick-card.md
  - ../notes/networking-exposure-model-quick-card.md
  - ../notes/observability-tracing-query-boundary-quick-card.md
  - ../learning-progress.md
---

# ACP Service Mesh 流量 / 安全 FAQ

这页只回答 `asm-docs` 里最像支持现场的一组高频问法：
- 为什么装了 mesh 后 Pod 起不来
- 为什么 sidecar 在但流量还是不对
- 为什么 Ingress Gateway 会 404
- 为什么开了 mTLS 之后服务互调异常
- 为什么 canary / global rate limiting / bypass 看起来“配了没用”

不展开 tracing 查询细节；那部分应回到 observability 主线。

---

## 1. 为什么装了 Service Mesh 之后，Pod 起不来，还报 `timeout waiting for Envoy proxy to become ready`？
这是典型 sidecar 启动阶段问题，先别急着看业务容器。

官方 FAQ 提到的高频原因包括：
- sidecar CPU / memory limit 不够，来不及从 `istiod` 获取并处理 xDS 配置
- firewall / NetworkPolicy 一类规则挡住了 workload 到 `istio-system` 的访问
- 某些环境里 `istio-init` 拦截模式本身有兼容性问题，这时更适合切到 **Istio CNI**
- 有问题的 **WASM / EnvoyFilter** 把 sidecar 启动卡死

现场更稳的口径是：
> 这是 Envoy sidecar ready 失败，不一定是应用本身坏了；先查 sidecar 资源、到 `istiod` 的连通性、网络策略，以及最近是否上了 EnvoyFilter / WASM 插件。

---

## 2. 为什么 sidecar 明明注入了，流量还是没被 mesh 正确接管？
因为“注入成功”和“流量重定向成功”不是一回事。

如果使用的是 sidecar 模式，真正接管流量还依赖：
- `istio-init` 或
- **Istio CNI**
完成 iptables / CNI 层重定向。

如果这一步失败，常见现象是：
- Pod 起不来
- Pod 启动了但流量绕过 sidecar
- `istio-validation` 一直报错

一句话：
> sidecar 在，只说明容器进去了；流量有没有真正进 mesh，还得看重定向链路。

---

## 3. 什么时候应该优先怀疑 Istio CNI，而不是继续盯着 sidecar？
以下场景都很值得先看 CNI：
- 环境本来就不适合让业务 Pod 拿 `NET_ADMIN` / `NET_RAW`
- Huawei Cloud CCE
- OpenShift（通常默认启用）
- ambient data plane 模式
- Pod event / `istio-validation` 日志反复出现连接拒绝或 validation timeout
- Pod 被持续驱逐，像是“启动了又被修复逻辑踢掉”

特别要记住：
- **ambient mode 下 Istio CNI 是必需的**
- sidecar mode 下虽然常说“可选”，但在高安全环境里它经常不是可有可无

---

## 4. 为什么 Pod 会被 Istio CNI 一直驱逐，看起来像起不来又反复重建？
这通常是官方文档说的 **race condition repair** 在工作。

含义不是“mesh 太严格”，而是：
- Pod 启动时 CNI 插件还没准备好
- 或者插件根本没正确安装
- 系统判断该 Pod 的流量重定向是坏的，于是持续修复 / 驱逐

优先检查：
- `istio-cni-node` DaemonSet 是否 Ready
- `istio-cni-node` 日志
- kubelet / pod events
- `istio-validation` 日志

如果是 Multus + Kube-OVN 一类多 CNI 组合，还要警惕：
- CNI 配置被重复安装
- 形成循环链
- 需要显式指定 `cni.values.cniConfFileName`

---

## 5. 为什么用了 Ingress Gateway，外部访问还会 404？
先别直接怪 VirtualService。

官方 FAQ 里一个很像现场坑点的是：
- **多个 Gateway 配置了同一个 TLS certificate**
- 浏览器用了 **HTTP/2 connection reuse**
- 访问第二个 host 时打出 404

这不是“偶发玄学”，而是 Istio 社区已知问题。

更稳的判断口径：
> 如果多个域名 / Gateway 共用同一证书，且问题主要出现在浏览器 + HTTPS + HTTP/2 场景，要先怀疑这个 TLS cert 复用边界。

推荐解法优先级：
1. **合并 Gateway 资源**（官方更推荐）
2. 必要时再考虑 421 响应方案

---

## 6. 为什么 Ingress Gateway 能做入口，不等于平台所有北向暴露问题都该按 ASM 处理？
因为 Ingress Gateway 只是 **mesh 入口层**。

它擅长的是：
- mesh 边界入口
- L4/L7 协议治理
- TLS 终止
- 与 mesh 内服务治理联动

但如果问题本质是：
- 暴露模型选错
- LoadBalancer / VIP / 网关层级不对
- 北向网络路径本身不通

那它已经和 ACP networking 主线强相关，不该只在 ASM 页面里兜圈子。

一句话：
> 入口流量“进了 mesh 之后怎么走”偏 ASM；“请求怎么从平台外进来”往往还要回 networking 主线一起看。

---

## 7. 为什么开了 mTLS 以后，服务之间反而调不通了？
最常见原因不是“证书坏了”，而是 **strict / permissive 模式切换时机不对**。

官方给出的默认策略很关键：
- 默认是 **permissive**
- 迁移阶段推荐先 permissive，再逐步切 strict

原因很现实：
- permissive 可以同时接受明文和 mTLS
- strict 只接受 mTLS
- 如果客户端还没进 mesh、没注入 sidecar、或仍走明文，strict 会直接把流量打掉

一句话：
> mTLS 问题先看模式，再看调用方是否真的已经处在 mesh 里；很多“突然不通”其实是迁移没收口就切 strict 了。

---

## 8. 为什么 strict mTLS 对 mesh 外服务特别容易出问题？
因为 strict 要求双方都走 mTLS，且身份可被 sidecar 识别与校验。

mesh 外调用常见问题是：
- 客户端没有 sidecar
- 不会发 mTLS
- 即使能 TLS，也不是 mesh 认可的双向身份链路

所以对外部系统 / 非 mesh 工作负载，最需要避免的误判是：
> “更安全” 不等于 “可以立刻全局 strict”。

---

## 9. 为什么 Canary Release 看起来“配置了没效果”？
官方文档里有几个硬边界非常关键：
- **不能与已有 service routing configuration 共存**
- GitOps 管理服务时，UI 控制有限
- 跨集群还有服务命名等限制

所以很多“没效果”不是发布功能坏了，而是：
- 目标服务本来就有既有路由
- 你在 UI 上想改，但当前对象被 GitOps 管着
- 你的集群 / 服务前提不满足

一句话：
> canary 不是能叠加在任何现网流量规则上的第二层魔法，它对前置路由状态很挑。

---

## 10. 为什么 Global Rate Limiting 不是直接建个策略就能生效？
因为它有明确前提：
- **Redis cluster 必须预先集成**
- 目标服务必须在 mesh 中并有 sidecar
- 每个服务最多 1 个 global policy

如果这些前提没满足，再多调规则都不会变成“已生效限流”。

shadow mode 也别理解成无限追溯：
- 数据保留期是 **7 天**

---

## 11. 为什么改了 Sidecar Configuration / Bypass 之后，效果不像预期？
这类问题先看三个边界：
1. **namespace 作用域对不对**
2. 改的是不是默认配置（默认配置要求在 `istio-system`）
3. 是否还在变更传播窗口内（文档写的是约 60s）

另外别忽略 bypass 的代价：
- bypass mode 要求 Kubernetes 1.23+
- 去掉 sidecar / 绕过 sidecar，不只是“少一层代理”，而是可能连安全策略一起失效

---

## 12. 多集群 mesh 下，为什么 failover / 跨集群流量问题不能按单集群思路硬套？
因为官方多集群 mesh 模型本身就是：
- multiple control planes
- 跨集群服务发现
- east-west gateway 自动部署（某些模式）
- 区域、网络、拓扑一致性要求

所以如果问题出在：
- 跨集群发现
- 跨区权重分流
- 跨 cluster failover

那已经不只是单集群 Gateway / VirtualService 层面的问题。

---

## 13. 现场我应该先看哪些证据？
如果是 Pod / 注入问题，优先看：
- pod events
- `istio-proxy` 日志
- `istio-validation` 日志
- `istio-cni-node` 日志
- kubelet 日志

如果是入口 404 / TLS 问题，优先看：
- Gateway 数量与证书复用情况
- 是否 HTTP/2 浏览器复现
- VirtualService 指向关系

如果是 mTLS 问题，优先看：
- permissive / strict 模式
- 客户端是否已进 mesh
- 是否有 mesh 外流量

---

## 14. 一句话总口径

> Service Mesh 现场高频坑基本集中在四类：**sidecar/CNI 注入链路**、**Ingress Gateway 入口边界**、**mTLS 迁移时机**、**高级治理功能前置条件**。先把这四类分清，很多“看起来像网络问题”的问题才不会越查越散。

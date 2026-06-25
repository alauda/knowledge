---
title: ACP Certificate Triage Checklist
type: checklist
status: draft
domain: security
product: acp
tags: [acp, security, certificate, expiry, rotation, checklist, triage, ticket-derived]
updated: 2026-06-20
source: [experience, ticket-cases, official-docs]
related:
  - ../../product-catalog/office_docs/faqs/security-faq.md
  - ../../product-catalog/office_docs/notes/security.md
  - ../../ticket-documents/indexes/security-compliance-certificate-platform-security.md
  - ../../ticket-documents/indexes/security-compliance-certificate-expiry-rotation.md
---

# ACP 证书到期 / 过期现场分诊 Checklist

> 这份 checklist 只做一件事：把一线支持最常见的证书问题，先压缩成**现场可执行的最短判断链**。
>
> 适用场景：
> - 巡检 / 监控提示某证书即将过期
> - 客户反馈创建 Pod、webhook 调用、组件运行时出现证书过期/TLS 报错
> - 平台组件、operator、apiserver、etcd 相关证书需要先判断影响面和处理优先级

## 1. 先分流：是“巡检预警”还是“已影响业务”？

### A. 巡检预警 / 即将过期
- [ ] 当前主要现象是**剩余天数变短**、巡检告警、监控告警
- [ ] 业务侧**还没有**明显报错：没有创建 Pod 失败、没有 admission/webhook TLS 报错、没有核心组件持续重启
- [ ] 现场目标优先是：**判断是否自动续期、是否需要人工介入、是否需要提前升级处理**

### B. 已影响业务 / 已过期报错
- [ ] 已出现明确业务现象：创建 Pod 失败、组件报 `x509` / `certificate has expired`、webhook/APIService 调用异常
- [ ] 已出现控制面异常：`etcd` / `kube-apiserver` 频繁重启、集群状态异常
- [ ] 现场目标优先是：**先判断受影响组件、影响范围、是否需要立即升级和切换为更深处置**

**一句话分流：**
- **先把“剩余天数预警”与“已经影响业务”分开。**
- 不要把“9 天后到期”和“现在已经导致业务失败”当成同一优先级处理。

---

## 2. 先看什么组件

- [ ] **平台访问入口 TLS**：如平台访问地址、对外 HTTPS 入口
- [ ] **平台组件 / operator service cert**：如 `*-service-cert`、webhook/service 证书
- [ ] **集群基础证书**：如 `kube-apiserver`、`etcd`、内部 loopback 等
- [ ] **是否为 cert-manager / operator 自动托管对象**：是否存在 `Certificate`、issuer、controller 管理痕迹

**支持现场要先回答的不是“删不删 Secret”，而是：**
1. 这到底是哪一类证书？
2. 它是谁在管？
3. 它现在只是预警，还是已经影响业务？

---

## 3. 现场先收什么证据

### 3.1 如果是巡检预警 / 即将过期
- [ ] 证书名称、namespace、所在组件
- [ ] 剩余有效期 / 告警截图 / 指标截图
- [ ] 是否存在对应 `Certificate` / issuer / operator 管理关系
- [ ] 当前组件是否运行正常，有无重启/异常事件
- [ ] 同类证书是否不止一个一起告警

### 3.2 如果是已影响业务 / 已过期报错
- [ ] 具体报错原文：尤其 `x509`、`certificate has expired`、`tls`、`webhook`、`apiserver`、`etcd`
- [ ] 受影响动作：创建 Pod、访问平台、发布应用、webhook 调用、控制面组件启动
- [ ] 受影响范围：单组件 / 单集群 / 多集群 / 多项目
- [ ] 对应组件日志、事件、重启情况
- [ ] 是单个 master 还是多个控制面节点一起异常

---

## 4. 影响面怎么判断

### 4.1 更像“预警未伤业务”
- [ ] 只有巡检/监控在报，业务侧暂无失败
- [ ] 组件状态基本正常
- [ ] 没有大面积 TLS 报错
- [ ] 现场重点转为：判断它是**会自动续期**、**需手工轮换**，还是**属于基础证书需要计划性处理**

### 4.2 更像“已开始伤业务”
- [ ] 创建 Pod 或资源下发开始失败
- [ ] admission / webhook / APIService 链路报证书错误
- [ ] `etcd` / `apiserver` / operator 明显重启或异常
- [ ] 组件恢复依赖证书续期、重建或节点/控制面处理

**高优先级信号：**
- `etcd` 证书过期并伴随控制面异常
- `kube-apiserver` / loopback 相关证书临近或达到时限且已出现异常
- 多个核心组件同时因为证书问题报错

---

## 5. 哪些动作不要直接做

- [ ] **不要一上来直接删 Secret**，尤其还没确认是不是自动托管、删后是否会自动回补
- [ ] **不要把“operator 管理的部分 service cert”经验，直接套到所有证书**
- [ ] **不要没看影响面就承诺“删除不会有影响”**
- [ ] **不要把 apiserver / etcd / loopback 这类基础证书，当成普通业务组件证书处理**
- [ ] **不要只因为页面没更新，就误判续期没生效**；先确认是否存在组件缓存/展示延迟

**现场保守原则：**
> 在没确认托管关系和影响面前，`直接删 secret 试试` 不是默认动作，只能是有依据的后续动作。

---

## 6. 常见误判

- [ ] **“证书快到期” = “已经影响业务”**
- [ ] **“是 `*-service-cert`” = “一定能直接删 Secret 自动恢复”**
- [ ] **“页面日期没更新” = “实际上没有续期成功”**
- [ ] **“一个节点证书没过期” = “整个控制面一定没问题”**
- [ ] **“所有证书问题都是 cert-manager 自动处理”**
- [ ] **“apiserver loopback 一年到期” = 产品 bug**，但案例更接近原生机制 / 生命周期特性

---

## 7. 什么时候需要升级处理

### 升级到更深排障 / 工程师
- [ ] 已出现业务失败、组件起不来、控制面异常
- [ ] 涉及 `etcd`、`kube-apiserver`、loopback、控制面多节点异常
- [ ] 无法确认是自动续期失败、controller 异常，还是基础证书生命周期问题
- [ ] 证书处理动作可能涉及组件重启、控制面变更、手工续期文档执行

### 升级到产品 / 研发确认
- [ ] 客户要确认某类证书是否为**产品默认机制**或**版本共性行为**
- [ ] 客户要求给出“是否自动续期 / 是否官方推荐手工删除重建”的明确产品口径
- [ ] 现场遇到对象类型混杂，无法直接判断适用 runbook

---

## 8. 现场最小证据清单

- [ ] 证书名称 + namespace + 所属组件
- [ ] 当前现象：仅预警 / 已报错
- [ ] 剩余有效期或具体报错原文
- [ ] 是否有 `Certificate` / issuer / operator 托管证据
- [ ] 受影响动作与范围（单组件 / 单集群 / 控制面）
- [ ] 关键日志 / 事件 / 重启现象

---

## 9. 支持现场最短判断顺序

1. [ ] 先分清：**预警** 还是 **已影响业务**
2. [ ] 再分清：**平台组件 cert** 还是 **apiserver / etcd 等基础证书**
3. [ ] 再确认：**是不是 cert-manager / operator 自动托管**
4. [ ] 再判断：影响是**展示层延迟**、**单组件异常**，还是**控制面异常**
5. [ ] 最后才决定：继续观察、按托管关系处理、还是立即升级

---

## 10. 参考案例

- [TICKET-1265714924](../../ticket-documents/cases/TICKET-1265714924%20ACP%20K8S集群kube-apiserver%20内部loopback%20证书一年过期问题.md)：`kube-apiserver` 内部 loopback 证书一年到期，更像原生机制边界，不适合按普通组件证书理解
- [TICKET-1266703574](../../ticket-documents/cases/TICKET-1266703574%20rds-operator-controller-manager-service-cert证书即将过期.md)：典型“平台组件 service cert 即将过期，先判断续签路径”的预警类问题
- [TICKET-1285549894](../../ticket-documents/cases/TICKET-1285549894%20创建pod报证书过期报错.md)：创建 Pod 失败背后实际是 `etcd` 证书过期，属于已影响业务且需深排的场景
- [TICKET-1314153304](../../ticket-documents/cases/TICKET-1314153304%20平台组件证书过期处理.md)：多个平台组件 `*-service-cert` 即将过期，说明“operator 管理对象可重建”这类经验存在，但不能无条件泛化
- [TICKET-1347571974](../../ticket-documents/cases/TICKET-1347571974%20巡检问题--证书有效期还剩9天.md)：典型巡检预警场景，重点是先区分“剩余天数告警”与“业务已受影响”

## 11. medium/no-case 补充：客户自管证书、业务域名证书与无证书部署（2026-06-19）

- **客户自管 Sentry / 业务组件证书**：如果 Secret/证书没有 cert-manager `Certificate` 或 operator 管理痕迹，不能套用“平台自动续期”口径；需回到客户自管证书续期、Secret 更新和入口重载流程。
- **Global DR / HTTP 域名无合法证书**：客户无法提供合法域名证书时，可按自签证书路径处理，但要明确浏览器信任、客户端校验和合规风险。
- **业务域名证书更新**：优先走平台页面“网络管理 → 域名证书 → 更新”这类产品入口；不要直接让现场改 Secret，除非文档明确要求。
- **平台访问 / Dex 证书更换**：若是 global 管理集群前端 HTTPS 或平台访问域名证书更换，先按版本文档确认 `dex-serving-cert` / `dex.tls` 的备份、删除、重建和组件重载路径；容灾环境的备 global 也要同步按文档处理。详见 [[security-platform-access-dex-certificate-boundary-faq]]。
- **cert-manager 托管的 cacert / asm-istio-cacert**：如确认由 cert-manager 管理，通常应等待自动续签或按产品口径处理，不要为了“快到期”直接删除 Secret 触发人工续期，除非文档/产研明确要求。
- **operator 管理但 cert-manager 只监控的证书**：页面/Certificate 上看到 renew 时间，不代表一定由 cert-manager 负责轮换。packageserver、Katanomi operator 等证书可能由各自 operator 在临近到期时自动更新；告警等级可在告警策略中调整或静默，但不能把 renew 字段当成唯一续期依据。
- **已下线/停用 Istio 的残留证书**：如果业务已明确不再使用 Istio/ASM，且证书只属于残留 Secret，处理前仍应先全局查引用、备份 Secret，再在维护窗口删除；不要因为“功能已下掉”就跳过影响确认。
- **已关机业务集群仍上报告警**：先判断 global 侧是否仍保留该集群监控/证书数据，以及 courier/courier-api/告警链路是否缓存旧状态；不要因为业务集群关机就直接删除告警源对象。

### 关联工单

- TICKET-1349168384：Sentry 相关 TLS Secret 未由 cert-manager 管理，续期应按客户自管证书处理。
- TICKET-1349954194：Global 灾备部署若使用 HTTP 域名且无合法证书，可使用自签证书，但需说明信任边界。
- TICKET-1349969044：业务域名证书更新可从平台网络管理页面执行。
- TICKET-1350868174：管理集群前端 HTTPS 自定义证书更换，涉及备份 `dex-serving-cert` / `dex.tls`、删除旧对象并用客户提供证书重建。
- TICKET-1351072424：平台访问域名/证书更换不成功，v4.1.3 口径要求 global 与容灾备 global 均按文档执行。
- TICKET-1352497444：`cacert.ca-cert.pem`、`asm-istio-cacert-global` 快到期，现场确认由 cert-manager 管理，会自动续签。
- TICKET-1352597544：平台 SSL 证书到期告警在证书自动重签后恢复，适合按“预警/恢复态”处理。
- TICKET-1352927534：packageserver、Katanomi 相关证书由对应 operator 管理，cert-manager 只做监控/展示，告警等级需从告警策略侧处理。
- TICKET-1353678474：已关机业务集群仍上报 sentry-serving-cert 告警，先重启 global 侧 courier/courier-api 并确认监控部署形态与缓存状态。
- TICKET-1353699354：生产主集群 Istio 证书过期但业务已停用 Istio，若需清理，先 `kubectl get secret -A` 查找对应 Secret、备份 YAML，再删除；仍需确认无引用与维护窗口。

### Deep-case 信号

- 当前判断：不需要。
- 原因：这些是证书归属、更新入口和自动托管关系 FAQ。
- 还缺什么证据：若更新后仍 TLS 报错，需要证书链、Secret 内容、Certificate/issuer/operator 托管状态、Dex/Ingress/Gateway 引用、组件重载日志、容灾两端对象差异、告警链路缓存状态和客户端校验结果。

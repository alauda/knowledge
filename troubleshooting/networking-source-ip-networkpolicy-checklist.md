---
title: ACP Networking Source IP / NetworkPolicy / NodePort Checklist
type: checklist
status: draft
domain: networking
product: acp
tags: [acp, networking, checklist, source-ip, networkpolicy, nodeport, externaltrafficpolicy, ticket-derived]
updated: 2026-06-19
source: [experience, ticket-cases]
related:
  - ../../product-catalog/office_docs/notes/networking-symptom-runbook.md
  - ../../product-catalog/office_docs/faqs/networking-faq.md
  - ../knowledge-project-home.md
  - ./networking-north-south-exposure-triage-checklist.md
---

# ACP 源 IP / NetworkPolicy / NodePort 问诊 Checklist

> 适合这类场景：
>
> - 客户说“访问能通，但后端看到的不是客户端真实 IP”
> - 配了 NetworkPolicy 后，经 ALB / NodePort / 外部 LB 访问异常
> - NodePort 在某些节点通、某些节点不通

## 1. 先判断：问题更像哪一类

- [ ] 流量能到，但源 IP 不对
- [ ] 流量经 ALB / 外部 LB 不通，但集群内直连正常
- [ ] NodePort 只在部分节点可用
- [ ] 配策略前正常，配策略后异常
- [ ] 同样 YAML 在不同环境表现不一致

## 2. 现场必须先确认的 8 件事

- [ ] 后端看到的是节点 IP、LB IP、代理 IP，还是 XFF 第一段正确但应用展示错
- [ ] 流量路径里是否有外部 LB / HAProxy / F5 / CDN / 企业网关
- [ ] 入口是 ALB、Ingress NGINX、Envoy Gateway 还是 NodePort
- [ ] 是否开启 PROXY protocol
- [ ] Service 是否为 `externalTrafficPolicy: Local`
- [ ] 入口 Pod / controller 是否走 `hostNetwork`
- [ ] 是否刚新增或收紧过 NetworkPolicy
- [ ] 问题是所有节点都不通，还是只在部分节点不通

## 3. 如果是“真实源 IP 不对”

- [ ] 区分应用看的是 `remote_addr` 还是 `X-Forwarded-For`
- [ ] 核对上游是否发送 PROXY protocol，下游是否同步解析
- [ ] 核对 `externalTrafficPolicy: Local` 是否已配置
- [ ] 核对入口 Pod 是否真的落在可引流节点
- [ ] 若多层代理并存，优先看 XFF 第一段是否可信
- [ ] 不要把“代理 IP 被看到”直接等同于“入口没工作”

## 4. 如果是“NetworkPolicy 后访问异常”

- [ ] 先确认受影响对象是不是 `hostNetwork` Pod
- [ ] 普通 NetworkPolicy 是否只放通了 namespace / Pod，而未放通节点 IP
- [ ] ALB / Ingress 控制器实际流量源是不是节点 IP
- [ ] NodePort / hostNetwork / 外部 LB 回流路径是否经过策略边界
- [ ] 不要默认“集群内能通”就等于“外部入口链路也应能通”

## 5. 如果是“NodePort 只在部分节点通”

- [ ] Service 是否配置 `externalTrafficPolicy: Local`
- [ ] 不通的节点上是否根本没有本地 endpoint / 入口 Pod
- [ ] 访问节点是不是实际承接流量的节点
- [ ] 是否被误认为 kube-proxy / CNI 坏了，实则是 Local 模式的预期边界

## 6. 最小证据清单

- [ ] 用户访问路径图（外部 LB → VIP / NodePort → 入口 → Service → Pod）
- [ ] 后端实际看到的地址与头信息
- [ ] Service YAML 中 `type` 与 `externalTrafficPolicy`
- [ ] 是否开启 PROXY protocol
- [ ] 入口部署形态（hostNetwork / container / NodePort / LoadBalancer）
- [ ] 相关 NetworkPolicy 关键规则

## 6.1 HTTP 前置 LB / XFF、Node 侧自定义端口与隔离策略咨询（2026-06-19）

来自 medium + merged-existing/no-case 工单的稳定补充：这类通常是入口规划或策略配置问诊，先确认边界，不要直接当 CNI 故障。

- [ ] 客户问 global 前置 LB 是否能用 HTTP 协议时，先区分 443/6443/11443 的用途与 TLS 终止位置；如目标是审计/业务侧获取真实客户端 IP，可由前置 HTTP LB 写入 `X-Forwarded-For`，ALB/入口再按 XFF 处理；不应默认把 apiserver 6443 改成普通 HTTP。
- [ ] 如果前置 LB 仅 TCP 转发，平台审计或后端看到的是数据节点/LB 源地址，属于 L4 转发的预期边界；需要真实 IP 时要确认是否可使用 HTTP/XFF 或 PROXY protocol，并同步下游解析方式。
- [ ] 在 Node 主机上部署客户自有 License 服务时，端口建议避开 Kubernetes 默认 NodePort 范围 `30000-32767`、控制面端口和已知插件端口；`28000-29999` 可作为较保守的候选范围，但仍需现场端口扫描和变更登记确认。
- [ ] Namespace 与 Pod 隔离诉求先落到 NetworkPolicy/平台网络策略：明确是否要求“只允许经 Ingress/入口访问”、同 namespace Pod 是否默认互通、DNS/健康检查/监控采集是否需要例外放通。

### 关联工单

- TICKET-1353306034：global 前端负载均衡使用 HTTP/XFF 后，ALB 可处理真实客户端 IP；只开 443 即可满足该场景。
- TICKET-1353305854：Node 主机部署 License 服务，建议选择低于默认 NodePort 范围且避开核心组件的端口段，例如 28000-29999。
- TICKET-1352859014：namespace 与 pod 网络隔离按平台网络策略按需配置。

### Deep-case 信号

- 当前判断：不需要。
- 原因：前置 LB/XFF、主机端口规划、NetworkPolicy 隔离多为配置边界 FAQ。
- 还缺什么证据：若要 deep-case，需要完整入口链路、LB 配置、请求头/审计字段、Node 端口占用清单、NetworkPolicy YAML、抓包和访问前后对比。

## 7. 支持现场一句话口径

- 这类问题不要只看“IP 对不对”或“策略配没配”，更值得先确认的是：**流量到底经由哪一层被改写、入口是不是 hostNetwork / Local 模式、以及 NetworkPolicy 放通的对象是否真的覆盖了实际流量源。**

## 8. 参考案例

- [TICKET-1297918764](../../ticket-documents/cases/TICKET-1297918764%20创建networkpolicy之后，通过ALB的访问无法访问.md)：ALB 为 `hostNetwork`，仅按 namespace 放通不够，需要直接放通节点 IP
- [TICKET-1316507134](../../ticket-documents/cases/TICKET-1316507134%20web应用部署到灵雀云，应用获取不到客户端真实ip，获取到的是负载IP，如何获取真实ip.md)：获取客户端真实 IP 的典型问法
- [TICKET-1296857274](../../ticket-documents/cases/TICKET-1296857274%20alb客户端真实IP透传.md)：ALB 客户端真实 IP 透传
- [TICKET-1265018734](../../ticket-documents/cases/TICKET-1265018734%20工单99001，判断集群网络策略会把NodePort端口影响，如何解决？.md)：NetworkPolicy 与 NodePort 暴露链路边界
- [TICKET-1313282714](../../ticket-documents/cases/TICKET-1313282714%20nodeport访问问题.md)：`externalTrafficPolicy: Local` 语义下，NodePort 只在部分节点可用

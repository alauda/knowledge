---
title: ACP Networking Ingress / ALB / Gateway Triage Checklist
type: checklist
status: draft
domain: networking
product: acp
tags: [acp, networking, checklist, ingress, alb, gateway-api, triage, ticket-derived]
updated: 2026-05-13
source: [experience, ticket-cases]
related:
  - ../../product-catalog/office_docs/notes/networking-symptom-runbook.md
  - ../../product-catalog/office_docs/faqs/networking-faq.md
  - ../knowledge-project-home.md
  - ./networking-lb-ingress-ownership-and-api-boundary-faq.md
---

# ACP 入口 / ALB / Ingress / Gateway 分诊 Checklist

> 适合这类场景：
>
> - 有域名 / VIP，但返回 `404 / 500 / 502 / 503 / 504`
> - Service / Pod 直连正常，但挂到 ALB / Ingress / Gateway 后异常
> - 入口对象已创建，但请求像是没打到预期规则或实例

## 1. 先判断：更像哪一层

- [ ] 连 VIP / NodePort 都打不通，更像 L4 / 北向暴露
- [ ] TCP 通，但返回 `404`，更像 L7 路由未命中
- [ ] TCP 通，但返回 `5xx`，更像后端 Service / Endpoint / 协议链路异常
- [ ] 只有 HTTPS 失败，更像 TLS listener / 证书 / passthrough 问题
- [ ] Service / Pod 直连正常，只有入口异常，更像入口规则归属 / 实例归属 / 转发链路问题

## 2. 现场必须先确认的 8 件事

- [ ] 用户访问的是域名、VIP、NodePort 还是 ClusterIP
- [ ] 失败现象是超时、`404`、`5xx`、证书错误还是偶发抖动
- [ ] 外部访问失败时，集群内直连 Service / Pod 是否正常
- [ ] 入口类型是 Envoy Gateway、Ingress NGINX 还是存量 ALB
- [ ] 是否存在多个 GatewayClass / IngressClass / ALB 实例并存
- [ ] 最近是否改过 host、path、listener、证书、rewrite、backend port
- [ ] backend Service 名称、端口、targetPort 是否一致
- [ ] Pod 是否 Ready，Endpoint / EndpointSlice 是否真的有地址

## 3. 如果更像 404 / 路由不命中

- [ ] 用 VIP + 正确 Host 头直接访问一次，排除 DNS 干扰
- [ ] 故意带错 Host 头再访问一次，对比是否都是默认 404
- [ ] 核对 `HTTPRoute.hostnames` / `Ingress.spec.rules.host`
- [ ] 核对 path 匹配范围是否过窄
- [ ] 核对 `parentRefs` / `allowedRoutes` / `IngressClass` / `ingressClassName`
- [ ] 看请求是否其实进了错误的入口实例

## 4. 如果更像 5xx / backend 不可用

- [ ] backend Service selector 是否真的选中 Pod
- [ ] Endpoint / EndpointSlice 是否为空
- [ ] Pod 是 Running 还是 Ready
- [ ] Service.port / targetPort / 容器监听端口是否一致
- [ ] backend 是 HTTP、HTTPS 还是 gRPC，协议是否匹配
- [ ] 是否启用了 Endpoint Health Checker，endpoint 是否被主动摘除
- [ ] ALB / Ingress / Envoy 监控里 upstream 错误率和延迟是否抬升

## 5. 如果更像“对象在，但请求没进来”

- [ ] Gateway / Ingress / ALB 对象是否被预期控制器真正接管
- [ ] ALB 对应 Rule / Listener 是否有请求量
- [ ] Gateway listener / Route condition 是否 `Accepted / Programmed`
- [ ] LoadBalancer / NodePort / hostNetwork 暴露方式是否与用户实际访问路径一致
- [ ] 是否存在旧域名、旧 VIP、旧 LB 仍在承接流量

## 6. 最小证据清单

- [ ] 访问 URL / VIP / 端口
- [ ] 返回码或报错截图
- [ ] 请求时间点
- [ ] backend Service / Endpoint / Pod 名称
- [ ] 入口对象 YAML 或关键字段
- [ ] 是否有多入口实例并存

## 7. 支持现场一句话口径

- 如果 Service / Pod 直连正常，而经 ALB / Ingress / Gateway 异常，先不要泛化成“应用有问题”，更值得优先确认：**请求到底有没有进到预期入口实例、规则是否命中、以及 backend endpoint / 端口 / 协议链路是否真的成立。**

## 7.1 ALB 端口误删、权限隐藏与局部恢复边界（2026-06-25）

适用场景：namespace 用户误删 ALB 端口，担心端口下关联规则/Ingress 全部丢失；客户希望隐藏 ALB 负载均衡器菜单或删除权限；询问是否能只恢复某个端口/规则。

排查与处理：

1. 先确认被删对象：ALB 端口、Listener、Rule、Ingress、Service 还是关联 CR；导出当前残留 YAML 和事件。
2. 确认删除是否已经触发 controller reconcile：相关规则是否从页面/CR/实际 Envoy/LB 配置中消失。
3. 权限层面先查当前角色、RoleTemplate/FunctionResource、菜单可见性和 API 权限；不要只隐藏菜单而保留 API 删除能力。
4. 恢复层面，历史口径只确认可通过 etcd 备份做恢复，但这通常是集群级或人工提取式操作；不能承诺有产品化“只恢复某个 ALB 端口”的按钮。
5. 若确需恢复，先评估 etcd 备份时间点、影响范围、是否能离线提取局部资源 YAML，以及恢复过程中对现有资源的覆盖风险。

风险边界：

- etcd 全量恢复会影响整个集群状态，不适合轻率用于单个 ALB 端口误删。
- “隐藏菜单”不等于权限收敛；必须验证 API/RBAC。
- 端口删除后关联规则是否全部丢失，要以实际 CR/控制器状态为准，不要只凭页面现象下结论。

关联工单：

- TICKET-1355910284：namespace 用户可删除 ALB 端口，客户关注 80/443 端口及关联规则误删后的权限隐藏和局部恢复；当前样本只确认可寻求 etcd 备份恢复帮助，缺产品化局部恢复方案。

Deep-case 信号：

- 当前判断：可选。
- 原因：误删权限与恢复路径属于稳定运维边界 FAQ；若真实发生生产端口误删并影响入口流量，建议 deep-case。
- 还缺什么证据：被删前后 ALB/Ingress/Rule YAML、controller 事件、实际 LB 配置 diff、RBAC/RoleTemplate、etcd 备份时间点、恢复演练记录和业务影响时间线。

## 8. 参考案例

- [TICKET-1288114874](../../ticket-documents/cases/TICKET-1288114874%20alb%20转发规则不匹配.md)：典型规则归属错误 / `ingressClassName` 指错
- [TICKET-1327370614](../../ticket-documents/cases/TICKET-1327370614%20svc可以正常访问，但是配置alb后访问返回500.md)：Service 正常但入口层返回 `500`
- [TICKET-1306769204](../../ticket-documents/cases/TICKET-1306769204%20业务alb暴露域名，偶现部分请求访问超时，alb观察后端服务pod返回499.md)：偶发超时，ALB 侧已能看到 upstream 侧异常信号
- [TICKET-1304094484](../../ticket-documents/cases/TICKET-1304094484%20通过alb透传https请求到后端pod的https.md)：入口与后端 HTTPS / passthrough 模型边界问题
- [TICKET-1315068564](../../ticket-documents/cases/TICKET-1315068564%204.1.2版本ingressnginx+metallb配置问题.md)：Ingress NGINX + MetalLB 暴露链路配置问题
- [TICKET-1329056104](../../ticket-documents/cases/TICKET-1329056104%20underlay-alb创建失败.md)：underlay ALB 创建异常，适合作为入口对象未就绪样本
- TICKET-1355910284：ALB 端口删除权限与局部恢复诉求，适合作为权限/API 边界和 etcd 备份恢复风险样本。

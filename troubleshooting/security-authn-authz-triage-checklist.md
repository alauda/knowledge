---
title: ACP Security AuthN / AuthZ Triage Checklist
type: checklist
status: draft
domain: security
product: acp
tags: [acp, security, checklist, authn, authz, oidc, ldap, rbac, mfa, namespace, ticket-derived]
updated: 2026-06-22
source: [experience, ticket-cases, official-docs]
related:
  - ../../product-catalog/office_docs/notes/authn-authz-audit-runbook.md
  - ../../product-catalog/office_docs/faqs/security-faq.md
  - ../../product-catalog/office_docs/notes/security.md
  - ../../ticket-documents/indexes/security-compliance-authn-authz.md
  - ../../ticket-documents/indexes/security-compliance-oidc-ldap-login.md
  - ../../ticket-documents/indexes/security-compliance-permission-role-binding.md
---

# ACP 认证 / 授权现场分诊 Checklist

> 这个 checklist 适合一线先把问题压缩成最短判断：
>
> - 根本登不上
> - 能登录但没权限 / 菜单不对 / 看不到资源
> - 组继承像没生效
> - OIDC / LDAP 刚改完后现场说“还是不对”

## 1. 先分流：这是认证问题还是授权问题？

- [ ] 根本无法登录 ACP
- [ ] 能进入 ACP，但资源 / 菜单 / 按钮不对
- [ ] 刚改过 OIDC / LDAP / 用户组 / 角色后出现问题
- [ ] 现场说“没权限”，但还没确认是登录失败还是授权失败

**一句话判断：**
- **登不上** → 先走认证链
- **能登录但用不了** → 先走授权链
- **改完配置没变化** → 先优先怀疑同步 / token 刷新 / scope / binding

---

## 2. 如果是“登录失败”，先确认 8 件事

- [ ] 登录方式是 `local`、`OIDC` 还是 `LDAP`
- [ ] 用户状态是否为 `Normal`
- [ ] 是否出现 `Disabled / Locked / Invalid`
- [ ] 如果是 OIDC：该账号是否能返回 **email claim**
- [ ] 是否刚改过 `Client ID / Client Secret / Redirect URI`
- [ ] 是否已经做过 **IDP Service Configuration Validation**
- [ ] 如果是 LDAP：测试账号输入值是否真的符合 `Login Field`
- [ ] 问题是“跳不过去第三方页”“能跳转但回不来”还是“回来了但报错”

### 最小证据清单

- [ ] 登录入口类型
- [ ] 一次 validation 结果
- [ ] 一次真实登录现象截图或描述
- [ ] 用户当前状态

### 一线常见快结论

- **OIDC 没有 email claim** → 高优先怀疑登录唯一标识缺失
- **validation 失败** → 先回头查 IDP 参数，不要先怀疑权限
- **LDAP 能搜到人但登不上** → 先查 `Login Field / baseDN / filter / scope`
- **用户是 Invalid** → 更像外部 IDP/账号已变更，不是单纯密码问题

---

## 3. 如果是“能登录但没权限”，先确认 8 件事

- [ ] 用户状态仍然是 `Normal`
- [ ] 问题到底落在 `Platform Roles` 还是 `Kubernetes Roles`
- [ ] 权限是直接绑给用户，还是经由用户组继承
- [ ] 是否只看了用户个人页，没有看组详情
- [ ] 角色作用域是否绑在正确的 `cluster / project / namespace`
- [ ] 是否只有 `Role / ClusterRole`，没有对应 `Binding`
- [ ] 如果走 `RoleTemplate`，最终 `ClusterRole` 是否真的生成
- [ ] 用户当前登录态是否可能还没反映最近一次 IDP / 组同步变化

### 最小验证动作

- [ ] 先测一个**最小只读动作**，不要一上来测复杂写操作
- [ ] namespace 场景先测目标 namespace 内明确资源的 `get/list`
- [ ] cluster 场景先测一个 cluster 级只读资源
- [ ] 确认角色和 binding 后，让用户**重新登录**再测 UI 菜单 / 页面

### 一线常见快结论

- **role 在，binding 不在** → 更像授权没真正落地
- **binding 在，scope 不对** → 更像绑错层级
- **用户页看不到，组页有** → 更像组继承，不是没授权
- **Platform Role 补了还不够** → 用户缺的可能是更细粒度的 Kubernetes RBAC

---

## 3.1 升级后复制 / 自定义角色权限缺失：先走重渲染链

适用场景：升级后，复制的项目管理员 / 自定义 RoleTemplate 看起来还在，但菜单、资源动作或部分 Kubernetes 权限缺失。

- [ ] 确认问题角色是复制 / 自定义 RoleTemplate，而不是内置角色本身缺失
- [ ] 确认升级前后版本，以及缺失的是平台菜单、Kubernetes 资源动作，还是两者都有
- [ ] 查实际 RoleTemplate 名称与 `auth.cpaas.io/roletemplate.frozen` 状态
- [ ] 查最终生成的 ClusterRole / Role rules 是否已经包含新版本期望权限
- [ ] 查绑定该 RoleTemplate 的 UserBinding 列表
- [ ] 触发 RoleTemplate 与 UserBinding 重新渲染后，让用户重新登录并验证最小动作

**不要先做的事：** 不要手工逐条补 ClusterRole rules 当成长期修复；这容易被模板下一轮 reconcile 覆盖，也会让角色模板与最终权限继续漂移。

**参考案例：** [TICKET-1351464894](../../ticket-documents/cases/TICKET-1351464894%20acp%204.0.3升级4.2.1后，复制的项目管理员角色部分权限缺失.md)：ACP 4.0.3→4.2.1 后复制项目管理员权限缺失，通过 RoleTemplate frozen/bootstrap-fix 与 UserBinding 重新渲染恢复。

## 3.2 medium/no-case 补充：既有命名空间、MFA 与模拟登录需求边界（2026-06-22）

### 适用场景

- 客户希望把一个已经存在的 namespace 纳入项目管理；
- 客户咨询是否支持登录启用多因子认证（MFA）；
- 客户要求模拟登录、密码加密算法、长期不过期 cookie 或堡垒机自动代填。

### 最小判断链

1. **既有 namespace 加入项目**：先确认 namespace 当前是否已有项目/租户标签、是否已被其他项目引用、以及目标项目的 RBAC/ResourceQuota/NetworkPolicy 是否会覆盖现有业务预期；不要只看 UI 是否有“添加”按钮。
2. **MFA 登录**：先确认当前版本是否内置 MFA 能力；若未支持，应进入产品需求/外部 IDP 方案评估，不要在支持工单里承诺通过直接改 Dex/前端实现。
3. **模拟登录 / cookie 不过期**：这通常涉及安全策略和认证链路定制；只可说明已有正式 API/SSO/OIDC 能力边界，不应提供绕过会话、弱化过期策略或反向推导密码加密算法的方案。
4. **堡垒机/代填类诉求**：优先使用正式 SSO、OIDC、LDAP 或 API token；页面 XPath、cookie 生命周期、内部加密算法不作为稳定集成接口。

### 关联工单

- TICKET-1349156304：项目下添加已存在 namespace，应先确认命名空间归属、项目绑定和 RBAC/配额影响。
- TICKET-1349708944：登录启用多因子认证咨询，当前稳定口径是按产品能力/外部 IDP 方案评估。
- TICKET-1348983774：模拟登录、加密算法或不过期 cookie 诉求属于安全定制边界，不应替代正式认证集成。
- TICKET-1352043864：登录页 XPath 不承诺跨 UI 版本稳定，堡垒机代填不应依赖页面内部结构。
- TICKET-1348983774：如果客户要求长期不过期 cookie、反推密码加密算法或绕过标准登录链路，应明确拒绝作为排障方案，只能引导到 OIDC/LDAP/SSO/API token 等正式集成入口。

### Deep-case 信号

- 当前判断：不需要。
- 原因：这是认证/授权能力边界、项目归属与安全集成 FAQ；没有形成单点故障根因链。
- 还缺什么证据：若既有 namespace 加入项目后出现权限或网络异常，需要 namespace 标签/annotation、RoleBinding、NetworkPolicy、Quota、用户登录态和审计日志；MFA/模拟登录若进入方案评审，需要正式需求、IDP 能力、合规要求和风险接受方。

## 4. 如果是“组继承像没生效”，先确认 6 件事

- [ ] 这是 `Local User Group` 还是 `IDP-Synchronized User Group`
- [ ] 用户是否真的在目标组里
- [ ] 组上是否真的绑了目标角色
- [ ] 角色 scope 是否就是用户要访问的目标范围
- [ ] 是否刚改过 groups claim / LDAP 组映射
- [ ] 是否拿旧会话直接测试“改完是否生效”

### 快速判断

- **用户没在组里** → 不是继承失败，是成员关系未落
- **组有角色，但 scope 不对** → 不是继承失败，是授权范围不对
- **新登录正常，旧会话不正常** → 更像 token / 当前登录态未刷新

---

## 5. 现场必须带走的最小证据

- [ ] 问题用户是谁，来源是 local / OIDC / LDAP 哪种
- [ ] 用户状态（Normal / Disabled / Locked / Invalid）
- [ ] 出问题的具体动作：登录、看菜单、看资源、执行操作
- [ ] 目标作用域：cluster / project / namespace
- [ ] 当前角色与组关系截图或对象信息
- [ ] 如涉及 IDP：validation 结果与最近一次配置变更点

---

## 6. 支持现场一句话口径

- 如果**根本登不上**，先不要跳去查角色，优先确认登录方式、用户状态、OIDC email claim / LDAP 登录字段，以及 validation 是否通过。
- 如果**能登录但没权限**，先不要急着判平台故障，优先确认：权限到底走 Platform Role 还是 Kubernetes RBAC、是直绑还是组继承、binding 是否存在、scope 是否绑对。
- 如果是**刚改完 OIDC / LDAP / 组后“没变化”**，优先怀疑同步、token 刷新和旧会话，而不是先判配置完全未生效。

---

## 7. 参考案例

- [TICKET-1267142764](../../ticket-documents/cases/TICKET-1267142764%20平台登录页面报错，无法登录.md)：平台登录报错，适合作为认证入口异常样本
- [TICKET-1271901974](../../ticket-documents/cases/TICKET-1271901974%20我的管理员账号权限，用户账号权限突然消失（生产和测试都是）.md)：登录与权限感知混在一起，适合做认证/授权分流
- [TICKET-1298959034](../../ticket-documents/cases/TICKET-1298959034%20分配自定义项目角色后，katanomi报无权限错误.md)：典型“角色看起来有，但授权链没真正落地”
- [TICKET-1322138834](../../ticket-documents/cases/TICKET-1322138834%20项目经理查看中间件信息提示未部署管理组件，请联系平台管理员.md)：适合作为 scope / 角色边界误判样本
- [TICKET-1334827974](../../ticket-documents/cases/TICKET-1334827974%20集成禅道插件，无法集成.md)：看起来像功能异常，实则常要回头核对权限与接入边界

## 8. medium/no-case 补充：admin 密码重置与自定义角色入口边界（2026-06-20）

这类工单常被问成“后台怎么改”或“页面入口去哪了”，但更适合归入认证/授权 FAQ，而不是创建独立 case。

### A. 忘记 local admin 密码

- 先确认账号来源是 local，而不是 OIDC/LDAP 外部身份源。
- 后台重置应以对应版本文档为准，常见路径是定位 `cpaas-system` 下目标用户的 `password` 资源并更新 hash。
- 修改后如仍提示密码错误，要检查 Dex/认证组件是否需要重载或重启；不要只反复 patch 密码对象。
- 执行前应备份原对象，并记录操作窗口、影响范围与回退方式。

### B. 4.2+ 自定义平台角色入口变化

- 内置角色不建议也通常不支持直接修改。
- 若页面已下架创建/修改平台角色入口，应按官方文档使用 `RoleTemplate`/资源对象路径创建自定义角色。
- 自定义角色创建后仍要验证最终 Role/ClusterRole 与 Binding 是否生成，必要时让用户重新登录验证菜单与最小只读动作。
- 不要把“页面没有入口”直接判断为产品不支持任何自定义授权；也不要手工改内置角色当作长期方案。

### 关联工单

- TICKET-1348776724：遗忘 admin 密码，重置 `password` 资源 hash 后需重启 Dex 才登录成功。
- TICKET-1348787534：4.2 版本页面不再提供平台角色创建/修改入口，内置角色不支持更改，自定义路径需参考官方文档。

### Deep-case 信号

- 当前判断：一般不需要。
- 原因：这是 local 认证对象重置与 RoleTemplate 能力边界 FAQ，有稳定处理路径。
- 还缺什么证据：若重置后仍失败，需要用户来源、password 对象、Dex 日志、登录报错、外部身份源配置；若角色不生效，需要 RoleTemplate、生成的 RBAC、UserBinding、scope 与登录态刷新证据。

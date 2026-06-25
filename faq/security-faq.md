---
title: ACP Security FAQ
type: faq
status: active
domain: security
product: acp
tags: [acp, security, faq, oidc, certificate]
updated: 2026-05-13
source: [official-docs, experience]
related:
  - ../notes/security.md
  - ../notes/authn-authz-audit-runbook.md
  - ../../../knowledge_base/troubleshooting/security-authn-authz-triage-checklist.md
  - ../../../knowledge_base/troubleshooting/security-audit-logging-triage-checklist.md
  - ../../../knowledge_base/troubleshooting/security-compliance-certificate-triage-checklist.md
  - ../../../knowledge_base/troubleshooting/security-compliance-vulnerability-triage-checklist.md
  - ../../../knowledge_base/troubleshooting/oidc-client-secret-rotation-runbook.md
  - ../../../ticket-documents/indexes/security-compliance.md
  - ../../../knowledge_base/README.md
---

# ACP Security FAQ

### 平台 OIDC client secret 怎么轮换最安全？
只更新 `cpaas-system/cpaas-oidc-secret` 的 `client-secret`，不要改 `client-id`，也不要删除后重建整个 Secret。

### Pod Security 里的 `restricted` / `baseline` 与 `enforce` / `audit` / `warn` 分别是什么意思？
先别把这两组词混在一起，它们不是同一维度：

- `restricted` / `baseline`：是**安全标准级别**
  - `baseline`：基础安全基线，限制相对少一些
  - `restricted`：更严格，强调最小权限、非特权、受限 capabilities、受控宿主机能力暴露等
- `enforce` / `audit` / `warn`：是**执行方式**
  - `enforce`：真正拦截，不满足策略就拒绝
  - `audit`：不拦截，但记审计
  - `warn`：不拦截，但给告警/提示

所以现场如果看到“有 warning 但还能创建”，不要急着说策略没生效，那很可能只是当前运行在 `warn` 或 `audit` 模式。

### 如果命名空间默认是 `restricted`，想让容器正常运行，应该先改哪？
不要先找“一份万能 YAML”。更稳的顺序是：

1. 先确认当前命名空间实际用的是 `baseline` 还是 `restricted`
2. 再确认当前是 `enforce`、`audit` 还是 `warn`
3. 再看工作负载是否依赖这些高权限能力：
   - `privileged`
   - `hostPath` / `hostNetwork` / `hostPID`
   - 额外 `capabilities`
   - root 身份运行
   - 可写根文件系统
4. 最后才决定：
   - 是补 `securityContext`、按 `restricted` 约束改 YAML
   - 还是明确说明该工作负载天然更适合放在更宽松的策略级别

一句话说，**先分清策略级别和执行模式，再改 YAML；不是所有工作负载都应该硬凑到 `restricted`。**

参考 case：`TICKET-1334621084`

### 什么时候可以禁用 PKCE 的 `plain` method？
只有在相关插件都升级到兼容版本后，才能移除 `plain`，只保留 `S256`。

### 平台访问地址 TLS 证书怎么轮换？
备份旧证书对象，删除旧 `certificate/secret`，再用新证书重建 `dex.tls`。

### 为什么 LDAP / OIDC 用户看起来像“权限突然没了”，甚至账号都像失效了？
先不要直接当成授权丢失，先排 **用户唯一标识是否变了**。

在 ACP 里，第三方用户的登录与权限继承，往往依赖平台识别到的是“同一个用户对象”。如果 LDAP / OIDC 侧改了关键标识（尤其是邮箱、用户名映射字段、claim 映射结果），平台侧就可能把它识别成：
- 原账号失效
- 新账号未正确关联原权限
- 或同步后表现成“能看到人，但原来的权限像丢了”

最短排查顺序建议：
1. 看这个账号来自 **LDAP 还是 OIDC**
2. 看最近是否改过 **邮箱 / username / claim mapping / IdP 配置**
3. 看平台侧用户状态是否变成 `Invalid`，或 source / 标识是否发生变化
4. 再回头看这是不是授权问题，而不是身份映射问题

一句话说，**现象像权限丢失，不代表根因就在 role/binding；有时根因在登录身份映射链路。**

参考 case：`TICKET-1271901974`

### 为什么有些用户加了组、绑了自定义角色，页面还是提示没权限，甚至像“未部署管理组件”？
先不要急着把这类问题都当成“组件没装”或“平台坏了”，很多时候根因还是**授权链路缺项**。

尤其是自定义命名空间级角色时，现场很容易出现：
- 业务页面能打开
- 但具体查看某个模块/组件时提示无权限
- 或页面文案看起来像“未部署管理组件”

这类现象常见根因是：
- 角色只补了业务模块表层权限，**没补到底层关联的 K8s 资源查看权限**
- 复制内置角色后做裁剪，但裁掉了某些页面背后依赖的资源权限
- 用户已经从组里移出，但当前权限链路、角色复制结果、底层资源调用关系没有重新核对清楚

最短排查顺序建议：
1. 先用**平台内置角色**做对照（如 namespace admin / developer）
2. 若内置角色正常，而自定义角色异常，优先怀疑**自定义角色缺权限**，不是先怀疑组件没装
3. 重点回看页面背后依赖的 **container platform / K8s 资源查看权限**
4. 再决定是补业务模块权限，还是补底层资源权限

一句话说，**“未部署管理组件”这类文案不一定真是组件没部署，也可能是角色看不到它依赖的数据。**

参考 case：`TICKET-1322138834`

### 为什么同样勾了很多权限，Katanomi / DevOps 里还是报无权限？
先不要只看“这个角色勾没勾某个功能权限”，要先把问题拆成三层：
- **项目级权限**
- **集群级权限**
- **具体动作权限**（例如 exec 进入 Pod）

这类问题最容易误判成：
- “DevOps 权限都给了，为什么还不行”
- “功能按钮有了，就等于底层动作也一定被授权了”

但真实现场里，经常是：
- 页面 / 模块级权限有了
- 业务项目权限也像有了
- 但执行动作实际还依赖更高一级或另一条 RBAC 权限链

最短排查顺序建议：
1. 先确认报错动作到底是什么：页面查看、流水线操作、还是 `exec` / `kubectl` 一类动作
2. 再确认这类动作属于**项目权限**还是更高一级的**集群 / K8s RBAC 权限**
3. 用一个已知正常账号做同动作对照，而不是只对照角色勾选项
4. 不要把“工具链功能权限”和“底层 K8s 动作权限”混成一件事

一句话说，**功能权限看起来齐，不代表底层动作权限也已经齐；尤其是 DevOps / Katanomi 场景，经常是两层权限模型叠在一起。**

参考 case：`TICKET-1298959034`

### 为什么用户删掉后，同名账号还是不能重新创建或同步？
通常是 deleted user 残留：
- local 用户：先删 `password`，再删 `users`
- IDP 用户：按 connector label + deleted 状态清理

## 证书 / API 安全 / 合规

### cert-manager 管的证书怎么认？
看 `Secret` 的类型是不是 `kubernetes.io/tls`，并检查 `controller.cert-manager.io/fao: "true"` 和一组 `cert-manager.io/*` 注解。

### 证书监控看什么指标？
主要看：
- `certificate_expires_status`
- `certificate_expires_time`

### 巡检提示某个平台组件证书快过期，第一反应先看什么？
先别急着直接删 Secret，先确认这 4 件事：
1. **是哪一类证书**：平台访问地址 TLS、组件 webhook/service cert、还是 apiserver / etcd 这类集群基础证书
2. **是不是 cert-manager 在托管**：看 Secret 类型、`cert-manager.io/*` 注解、相关 `Certificate` 对象是否存在
3. **离过期还有多久、是否已有告警/现象**：不要把“剩余天数变短”和“已经影响业务”混成一个问题
4. **影响面在哪**：只是巡检告警，还是已经出现组件重启 / 创建 Pod 报 TLS 错 / webhook 调用失败

现场最短结论通常是：**先分清“监控提示”还是“业务已受影响”，再决定是续签、轮换，还是继续观察。**

如需支持现场更快分诊，可直接套用：
- [ACP 证书到期 / 过期现场分诊 Checklist](../../../knowledge_base/troubleshooting/security-compliance-certificate-triage-checklist.md)

参考 case：
- `rds-operator-controller-manager-service-cert` 即将过期：`TICKET-1266703574`
- 巡检提示证书有效期仅剩数天：`TICKET-1347571974`

### packageserver / operator 一类组件证书快过期时，现场最短怎么处理？
先别泛化成“等它自动续签”。

对这类组件证书，更稳的现场口径通常是：
1. 先备份对应 Secret 的 YAML
2. 删除对应 Secret，触发重新签发
3. 确认 Secret 已重建
4. 如组件依赖前端或缓存刷新链路，再重启相关组件让新证书真正生效

这类场景里，一个容易漏的点是：**证书重建成功 ≠ 使用它的组件已经立即生效**。

例如某些现场需要在 Secret 重建后再重启 `courier`，否则页面或组件状态看起来仍像没有恢复。

参考 case：
- [TICKET-1347571974](../../../ticket-documents/cases/TICKET-1347571974%20巡检问题--证书有效期还剩9天.md)

### 平台组件证书即将过期，可以直接删掉旧 Secret 让它自动重建吗？
**不建议先删再说。**

先判断是不是 cert-manager / operator 自动管理的对象：
- **如果是自动托管证书**：优先查对应 `Certificate`、issuer、controller 事件，确认是否本应自动续期但没成功
- **如果不是自动托管**：再按组件文档走手工轮换/重建路径

原因很简单：
- 有些 Secret 删掉后会自动回补
- 有些删掉后会导致组件短时不可用
- 还有些问题根因根本不是“证书没续”，而是 controller 没跑、issuer 不通、依赖对象缺失

所以一线支持更稳的动作是：**先识别托管关系，再决定删不删对象。**

如需把“巡检预警 vs 已影响业务、最小证据、误判、升级条件”压成更短现场步骤，可直接看：
- [ACP 证书到期 / 过期现场分诊 Checklist](../../../knowledge_base/troubleshooting/security-compliance-certificate-triage-checklist.md)

### 漏扫或客户想直接屏蔽 `/console-portal`，这样能算“安全加固”吗？
通常**不建议**把 `/console-portal` 整段直接屏蔽掉。

因为这往往不是一个“可独立下线的低风险页面”，而是平台多个模块会依赖的访问路径。直接禁掉后，可能导致平台功能整体不可用或大量页面异常。

更稳的说法是：
- 先确认漏洞报告里扫到的是**真实可利用风险**，还是“暴露了页面/路径”这类表象
- 再区分是要做**访问控制、反向代理限制、账号口令加固、组件升级**，还是只是想“让扫描不再报”
- 如果诉求只是“不要暴露某个入口”，要先评估该入口是否承载平台主功能，不能把“隐藏页面”当成通用修复手段

参考 case：`TICKET-1336026414`

### 客户拿着漏洞报告来问“平台侧是否受影响”，最短怎么答？
先不要直接回答“有”或“没有”，先按 3 层拆：
1. **报告提到的组件，平台侧到底有没有安装/使用**
2. **即使有同名组件，平台里的部署方式和暴露方式是否真的命中漏洞条件**
3. **问题是在平台默认组件里，还是客户自行安装/外挂的软件里**

高频场景里，真正有价值的不是一句“未使用”，而是把边界说清楚：
- 平台自身是否内置该组件
- 是否默认对外暴露
- 是否还需要用户名密码 / Secret / 内网访问条件才能触达

如果现场要更快分诊，可直接套用：
- [ACP 合规 / 漏洞报告 / 暴露边界现场分诊 Checklist](../../../knowledge_base/troubleshooting/security-compliance-vulnerability-triage-checklist.md)

参考 case：`TICKET-1340435744`

### 漏扫命中 9100 端口的 TLS / SHA-1 / OpenSSL 风险，第一反应先看什么？
先不要一看到 OpenSSL、TLS、SHA-1 就把问题泛化成“整个平台都有漏洞”。

最短先看这 3 件事：
1. **命中的是不是 `9100` 端口**
2. **这个 9100 是不是 `node-exporter` 暴露面**
3. **这是观测组件暴露面的加固问题，还是业务接口真实暴露问题**

这类票里，更稳的判断通常是：
- 先把漏洞命中范围压回**具体端口和组件**
- 再决定是做 TLS 能力整改、访问收敛，还是继续核对扫描口径
- 不要直接扩大成“平台所有 OpenSSL 都有同样风险”

一句话说，**先分清“命中了哪个端口/组件”，再谈全平台影响面。**

参考 case：`TICKET-1348639014`

### Kyverno / 合规策略导致工作负载发布失败，第一反应先看平台还是看策略？
先优先看 **Kyverno 策略本身**，不要一上来判平台故障。

因为这类现象更常见的根因是：
- 镜像签名校验策略配置不完整
- secret / 公钥 / attestations 引用不对
- 新项目/新 namespace 与旧环境策略不一致
- 策略比业务镜像当前做法更严格

最短判断动作：
1. 先看报错是不是 admission / policy deny
2. 再看是不是只有特定项目、特定 namespace、特定镜像失败
3. 最后回到对应 Kyverno 文档或策略 YAML 对配置

参考 case：`TICKET-1304508664`

### Harbor / Trivy 离线扫描 Java 镜像时扫不出 Java 漏洞，第一反应先看什么？
先不要直接下结论说“平台离线模式不支持 Java”。

最短先看：
1. **平台实际运行的 Trivy 版本**
2. **同一镜像在外部 Trivy 的对照结果**
3. **Java DB / metadata 是否一致**

如果外部 Trivy 能扫出 Java 漏洞，而平台侧完全扫不出来，且离线库 metadata 也一致，更稳的结论通常不是“库坏了”，而是：
- 平台集成的 Trivy 版本还没到支持线
- 或 Harbor 实际调用的 Trivy 二进制仍是旧版本

已沉淀样本表明：**ACP 4.0 对应 Harbor 2.12 + Trivy v0.62.1 已支持 `trivy-java-db`。**

参考 case：`TICKET-1346009864`

### API Refiner 的默认过滤范围是什么？
默认过滤 `namespaces`、`projects`、`clustermodules`、`clusters`，并脱敏 `metadata.annotations.cpaas.io/creator`。

### API Refiner 有什么限制？
- 只过滤 GET / LIST
- label selector 不支持 OR
- 资源必须带 tenant 相关 label 才能稳定做隔离

### Compliance 是基于什么实现的？
基于 **Kyverno**。安装入口是 Marketplace 的 Cluster Plugin，插件名是 `kyverno`。

### API Refiner 默认过滤哪些资源？
默认过滤：
- `namespaces`
- `projects`
- `clustermodules`
- `clusters`

默认还会脱敏：
- `metadata.annotations.cpaas.io/creator`

### API Refiner 装在哪个集群？YAML 安装要注意什么？
只能装在 `global` 集群。
YAML 安装时要先确认 `ModulePlugin` 和 `ModuleConfig` 已发布，然后创建 `ModuleInfo`，其中：
- `cpaas.io/module-name` 必须是 `apirefiner`
- `cpaas.io/module-type` 必须是 `plugin`
- `spec.version` 必须和 `ModuleConfig` 对齐

### Online Operations / ACP Telemetry 怎么启用？
先在 `global` 集群安装 **ACP Telemetry** 插件，前提是：
- license 有效
- `global` 集群可以访问 Internet

安装完成后，还要到：
- `System Settings > Platform Maintenance`

手工把 **Online Operations** 打开。

### 一个 project、cluster、namespace 之间怎么理解？
可以记成三条：
- 一个 project 可以用多个 cluster 的资源
- 一个 cluster 也可以把资源分给多个 project
- 一个 namespace 只能属于一个 project，且它的 quota 只能来自一个 cluster

### 用户为什么会“自动继承”已有权限？
因为 ACP 对同名用户有自动关联规则：
- local 用户名必须全局唯一
- 第三方用户（OIDC/LDAP）如果与已有用户名同名，会自动关联到已有账号
- 关联后会继承原账号权限
- 平台界面只显示一条同名用户记录

### OIDC 配好了，但第三方账号还是登不上 ACP，先看什么？
先看这个账号有没有 **email claim**。

官方文档明确说，ACP 会把 **email** 当成 OIDC 用户唯一标识。没有 email，通常就没法登录。

### local 用户密码规则是什么？
至少记住三条：
- 长度 **8-32** 位
- 必须包含**字母**和**数字**
- 必须包含特殊字符：`~!@#$%^&*() -_=+?`

### 为什么有些用户管理按钮是灰的，或者根本不能操作？
先排两个产品限制：
- **系统生成账号**不能被管理
- **当前登录账号**不能管理自己

这两个限制会直接影响重置密码、删用户、改状态、调角色等操作。

### ACP 4.2+ 角色模型怎么理解？
分两层：
- **Platform Roles**：系统模板角色，只能绑定/解绑，不能在 UI 里编辑
- **Kubernetes Roles**：原生 `Role/ClusterRole`，用来做更细粒度定制授权

旧版那种“勾选权限生成自定义角色”的方式已经移除。现在如果要做自定义授权，应该走原生 Kubernetes role/binding。

### 创建 project 时为什么会多出一个同名 namespace？能改吗？
因为平台会在关联 cluster 中自动创建一个**与 project 同名的 namespace**，用于隔离平台级资源。

不建议改，文档明确说：**不要修改这个 namespace 及其资源**。

### project 名称有什么限制？
不能和已有 project 重名，也不能命中平台黑名单。

黑名单里包括很多保留 namespace，比如：
- `cpaas-system`
- `cert-manager`
- `default`
- `kube-system`
- `kube-public`
- `kube-ovn`
- `alauda-system`
等。

### 为什么有些 cluster 在创建/添加 project 时选不了？
因为**异常状态的 cluster 不能被选中**。

### ProjectQuota 和 namespace 的 ResourceQuota 有什么关系？
可以记成：
- `ProjectQuota` 是 project 总桶
- `ResourceQuota` 是 namespace 小桶

平台会校验：**一个 project 下所有 namespace 的 ResourceQuota 总和，不能超过 ProjectQuota**。
所以正确顺序是：先调 ProjectQuota，再调 namespace 的 ResourceQuota。

### 删除 project 或移除 cluster 时要注意什么？
两个风险点：
- 删除 project 会释放它在 cluster 中占用的资源
- 从 project 中移除 cluster 后，这个 project 就不能再使用该 cluster 的业务资源

另外，如果要移除的 cluster 本身状态异常，相关资源可能清不干净，最好先修复 cluster。

### 用户组分哪两类？
两类：
- **Local User Group**：平台本地创建，可改成员、可删组、可改角色
- **IDP-Synchronized User Group**：从 LDAP / Azure AD 等外部系统同步，不能改成员、不能删组，只能调角色

### Local User Group 有人数上限吗？
有。

**单个 local user group 最多 5000 人**。达到上限后，不能继续导入成员。

### 为什么用户加进组后，个人角色列表里看不全？
因为**组继承来的角色**和**用户直接绑定的角色**不是同一个展示视角。

常见情况是：
- 用户会自动继承组角色
- 但组角色更适合到**用户组详情页**里看
- 用户个人页里更显眼的通常是“直接绑定”的角色

所以如果现场说“已经加组了，怎么像没权限”，第一步不要急着判故障，先去：
- 看这个用户是否真的已经在组里
- 看这个组是否真的绑了目标角色
- 看角色的作用域是不是绑在了正确的 cluster / project / namespace

### 用户能登录，但就是看不到资源 / 菜单 / 操作按钮，最短排查路径是什么？
先按授权链路排，不要一上来就怀疑平台故障：

1. **先看账号状态**：是不是 `Disabled / Locked / Invalid`
2. **再看直接绑定**：用户详情页里的 `Platform Roles` 和 `Kubernetes Roles` 都看一遍
3. **再看组继承**：确认用户是否在目标组里，组上是否绑了目标角色
4. **再看作用域**：角色是绑在正确的 `cluster / project / namespace` 上，还是绑错层级了
5. **最后看绑定是否真的存在**：尤其是 Kubernetes 权限，只有 `Role/ClusterRole` 没有 `RoleBinding/ClusterRoleBinding`，等于没授权

高频根因通常是：
- 角色绑错 scope
- 只建了 role，没建 binding
- 权限其实来自组继承，但排查时只看了用户个人页
- 用户缺的是 Kubernetes 细粒度权限，却只补了 Platform Role
- IDP / group claim 刚改过，当前登录态还没反映

### 为什么我明明创建了 Kubernetes Role，用户还是没权限？
因为 **Role/ClusterRole 只是权限定义，不是授权结果**。

真正让权限落到用户身上的，是：
- `RoleBinding`
- `ClusterRoleBinding`

所以最短检查就是：
1. 这个 role 是不是建在正确的 cluster / namespace
2. 有没有对应的 binding
3. binding 里的 subject 是不是这个用户或这个用户所在的组
4. 如果是 `RoleBinding`，namespace 是否就是用户要访问的那个 namespace

### RoleTemplate 已经创建了，怎么判断最终 ClusterRole 真的生成了？
先别直接看用户有没有权限，先看**中间产物有没有长出来**。

最短动作就是查：
- `kubectl get clusterrole -l auth.cpaas.io/role.relative=<roletemplate-name>`

如果这里查不到，优先判断为：**模板还没生成最终授权对象**，这时继续看 binding 意义不大。

### RoleTemplate 用 selector 聚合后还是没权限，先怀疑什么？
先怀疑 **selector 没匹配到目标 ClusterRole**，而不是先怪 binding。

高频根因有三个：
1. 目标 `ClusterRole` 根本没带对应 label
2. 只配了“角色聚合标签”，没配“scope 标签”
3. `scope` 写错了，比如该用 `business-ns` 却写成别的范围

也就是说，`aggregationRules` 只是“选谁进来”，不是“写了就自动有权限”。

### 用户明明加了角色但没生效，怎么最快判断是模板没生成、binding 没落，还是 scope 不对？
按这 4 步最省时间：

1. **先看 role/template 是否存在**
2. **再看最终对象是否生成**：如果是 `RoleTemplate`，查 `auth.cpaas.io/role.relative=<roletemplate-name>` 对应的 `ClusterRole`
3. **再看 binding 是否真的存在**：`UserBinding / RoleBinding / ClusterRoleBinding`
4. **最后看 scope 是否对**：cluster / project / namespace 是否正好对应用户要访问的目标

可以直接这样判断：
- **查不到生成的 ClusterRole**：更像模板没生成
- **role 在，但没 binding**：更像 binding 没落
- **binding 在，但访问的不是那个 cluster/project/namespace**：更像 scope 绑错
- **用户页看不到，但组上有角色**：更像继承链看错了

### Platform Role / UserBinding 看起来已经有了，为什么还是没生效？
因为 `UserBinding` “存在”还不够，**scope 字段必须对**。

排查时至少对这几项：
- `auth.cpaas.io/role.level`
- `auth.cpaas.io/role.name`
- `cpaas.io/cluster`
- `cpaas.io/project`
- `cpaas.io/namespace`

这些字段只要层级或目标值错了，现象就会是“像绑上了，但实际访问不到目标资源”。

### 做授权排障时，最小验证动作应该怎么选？
推荐先测**最小只读动作**，不要一上来就测复杂写权限。

更稳的做法是：
- namespace 场景：先测目标 namespace 里的一个 `get/list`
- cluster 场景：先测一个 cluster 级只读资源
- 一次只验证一个明确资源动作

这样最容易区分：到底是**对象没生成**、**binding 缺失**，还是**规则/作用域不匹配**。

### 用户安全策略主要管什么？
主要覆盖：
- 双因子认证
- 密码安全
- 自动禁用
- 登录锁定
- 通知
- 访问控制

有个细节很重要：**策略关闭后不会丢配置，重新启用时会恢复原来的参数。**

另外这几类策略别混着答：
- **Disablement**：长期不登录后自动禁用
- **Locking**：24 小时内登录失败次数过多后临时锁定
- **Access Control**：会话超时、并发人数、关标签页退出、禁止同客户端重复登录

### 审计功能为什么有时看不了？
先查两个前提：
- 账号是否有 `platform management` 或 `platform auditing` 权限
- 日志相关插件是否已安装：`ACP Log Essentails`、`ACP Log Collector`、`ACP Log Storage`

审计依赖日志栈，少了日志插件，这个功能本身就起不来。

再补一个现场很有用的判断：
- **连审计页面都进不去**：更像权限问题
- **能进页面，但始终没数据**：更像 logging 底座、时间窗或过滤条件问题
- **能查到记录，但结果失败**：更像认证/授权/对象操作本身失败

### ACP 的 audit 和 logging 到底是什么关系？
可以直接记成一句：**audit 是安全功能，logging 是数据底座**。

官方文档明确写了，审计依赖 logging service，而 logging 本身负责：
- 日志采集
- 日志存储
- 日志查询

它的后端核心是：
- `Filebeat`
- `Elasticsearch`
- `ClickHouse`

所以 audit 页面不是自己“产生日志”，而是消费 logging 链路已经采集和存储好的数据。

### 怎么区分“权限/认证有问题”还是“日志/审计底座没起来”？
最短判断可以这样做：

1. **先看能不能进审计页**
   - 进不去，优先看 `platform management` / `platform auditing` 权限
2. **再看有没有任何审计数据**
   - 页面能打开，但完全没数据，优先看 logging 三件套和时间范围
3. **再看结果码**
   - 有记录，且 `Operation Result` 不是 2xx，更像操作本身失败，而不是审计没工作
4. **再看旁证**
   - 如果 **Event 也没数据**，更像共享的 logging 底座异常，不像单独 audit 模块故障

一句话判断：
- **没权限进页面** → 更像授权问题
- **页面空、审计和事件都空** → 更像 logging 底座问题
- **有记录但失败** → 更像认证/授权/资源操作问题

### 审计里到底能看到哪些对象、动作和结果？
最常见能直接看到的是：
- **对象**：资源名称、资源类型、所在 cluster、所在 namespace
- **动作**：`create / update / delete / manage / rollback / stop` 等
- **操作者**：用户账号或 `system:` 开头的系统账号
- **结果**：`Operation Result`，其中 **2xx 表示成功，其他表示失败**
- **补充信息**：`Client IP`、操作时间、完整 JSON 明细

如果要区分“用户自己做的”还是“系统代做的”，记住两个 tab：
- **User Operations**
- **System Operations**

### 审计明明应该有数据，但我查不到，先排什么？
先别急着判成“审计没开”，按下面顺序最快：

1. **先放大时间范围**
   - 默认只看 **Last 30 Minutes**，这是最常见误判点
2. **再放宽过滤条件**
   - `operator / actions / clusters / resource type / resource name` 任一条件太窄，都可能把结果滤没
3. **确认 tab 选对**
   - 用户操作去 `User Operations`
   - 系统账号操作去 `System Operations`
4. **再回看 logging 三件套**
   - `ACP Log Essentails`
   - `ACP Log Collector`
   - `ACP Log Storage`

实战里最常见不是“审计坏了”，而是：**时间窗太窄、tab 选错、过滤过头，或者共享日志底座根本没数据**。

### 要验证 audit 能力是否正常，最小动作怎么做？
建议走一条最短闭环：

1. 确认账号有 `platform management` 或 `platform auditing`
2. 确认 logging 三件套已安装
3. 在平台做一个**低风险、容易命中审计的修改类动作**
4. 立刻进入 **Auditing** 页面
5. 把时间窗调大到能覆盖刚才的动作
6. 优先按 `operator` 或 `resource name` 搜索
7. 看 `Operation Result` 和 `Details` JSON

如果还想顺手确认是不是底座问题，可以额外看一下 **Event** 是否也有数据：
- **audit 和 event 都空**：更像 logging 底座异常
- **audit 有记录，只是 result 失败**：更像真实操作失败

### OIDC / LDAP 改配置或删除后，会影响已有用户吗？
会，而且影响不小。

- **Update OIDC / LDAP**：会按新配置重新同步已有用户信息；如果外部侧已经删人，平台侧可能把这些用户变成 `Invalid`
- **Delete OIDC / LDAP**：该 IDP 同步来的用户会变成 `Invalid`，角色绑定关系通常还在，但用户不能再登录
- 如果删除 IDP 时勾选 **Clean IDP Users and User Groups**，还会顺带清掉同步来的用户和组

所以这类变更不要只当“改一个连接参数”，它会实打实影响现有用户状态和后续登录。

对“登录成功但权限忽然不对”的场景，还要额外想到两件事：
- 这次 IDP 变更是否让**组同步结果**变了
- provider 侧 group claim 改了以后，当前用户是不是还没等到 **ID token refresh**

### LDAP 用户一定要先手工同步，才能登录吗？
不一定。

官方文档给出的边界是：**LDAP 用户在手工同步前也可能先登录成功，首次成功登录时会自动同步到平台**。

所以现场如果出现“明明没点 Sync，为什么用户已经能登录/已经出现在平台”——这通常是产品预期，不一定是异常。

### 用户安全策略明明配了，为什么看起来不生效？
先别急着判定产品故障，优先按下面顺序排：

1. **先确认是哪类策略**：2FA / Disablement / Locking / Access Control 的触发条件完全不同
2. **Access Control 只对新登录生效**：改完策略后，当前在线会话通常不会立刻被踢
3. **浏览器恢复标签页不一定触发退出**：所以“关了浏览器又恢复页面还在”不一定算失效
4. **禁止同客户端重复登录时，只保留最后一次登录**：如果拿同一浏览器反复测，现象容易看错
5. **最小验证动作**：退出当前账号，重新登录，再测会话超时/并发/关标签页行为

如果用户测的是 2FA，还要顺手确认：
- 他是不是走**密码登录**
- 验证码依赖的**通知服务器**有没有配通

### OIDC 登录失败，最短排查路径是什么？
先走最短三步：

1. **看 email claim**：ACP 用 email 作为 OIDC 用户唯一标识，没有 email 基本就登不上
2. **看 IDP 配置校验能不能过**：添加/修改 OIDC 时，用真实账号做 `IDP Service Configuration Validation`
3. **看回调和凭据**：`Identity Provider URL / Client ID / Client Secret / Redirect URI` 是否和 IDP 侧注册值一致

如果第 2 步都过不了，优先回头查 OIDC 侧账号、client 配置和回调，不要先怀疑平台登录页。

### OIDC 组不同步 / 字段映射不对，先看什么？
先看四个字段有没有对齐：
- `claimMapping.groups`
- `groupsKey`
- ID token / UserInfo 里真实返回的 group claim key
- `overrideClaimMapping` 是否需要开启

补两条高频边界：
- 如果 provider 用的是**非标准 group claim**，通常要显式改映射
- 如果 provider 侧组变更后平台没立刻看到，可能只是 **ID token refresh** 还没发生，不一定是同步坏了

### LDAP 配好了但登录/同步还是异常，最短排查路径是什么？
按这三层排最快：

1. **校验层**：先用真实 LDAP 账号做 `IDP Service Configuration Validation`
2. **登录层**：确认测试账号输入值真的符合 `Login Field`
3. **检索层**：核对 `baseDN / filter / scope / username(id)` 和组相关的 `groupAttr / userAttr / nameAttr`

常见根因不是“平台不会同步”，而是：
- 搜索起点错了
- filter 过窄
- 登录字段和实际输入不一致
- 组成员属性映射和目录结构对不上

### LDAP / OIDC 用户被删后，平台里为什么还看得到？
因为删除外部 IDP 里的用户，不等于平台会立刻消失。

更准确地说：
- 再次同步后，这类用户通常会变成 **`Invalid`**
- 角色绑定关系通常**保留**
- 如果只是删了 IDP 配置本身，平台也只是把这批同步用户打成 `Invalid`

所以“还看得到”不等于“还能登录”。先看状态是不是 `Invalid`。

### API Refiner 为什么“像没生效”？
高频原因先看四个：
- 它**只过滤 GET / LIST**，不是所有 API 都管
- **platform-level userbindings** 不过滤
- `LabelSelector` **不支持 OR**
- 目标资源如果没有 `cpaas.io/project / cluster / namespace` 这类租户标签，隔离结果可能不稳定

### K8s 证书轮换插件装了，是不是就不用再管证书了？
还不能这么理解。

要记住两个边界：
- 轮换触发条件是：**剩余有效期少于 20% 或少于 30 天**
- 如果轮换窗口里 `kubelet` 本身异常，**自动轮换可能失败**，这时仍要人工 `cert-renew`

另外，`kube-apiserver`、`kube-controller-manager`、`kube-scheduler`、`kubelet` 在轮换时都需要重启/重载新证书。

### OLM 相关 Operator 证书需要自己轮换吗？
通常不用。

官方说明里，`olm-operator`、`catalog-operator`、`packageserver`、`marketplace-operator`，以及 Operator CSV 里定义的 webhook / APIService 证书，都是 **OLM 自动生成和自动轮换**。

### Compliance 和 Compliance Service 是一回事吗？
不是，至少不要直接混着答。

- **Compliance**：文档主线里是基于 **Kyverno** 的策略校验、违规监控、报表
- **Compliance Service**：更偏 **STIG / MicroOS** 扫描与报告

用户问“合规”时，最好先确认他是在问 **Kyverno 策略治理**，还是在问 **主机/OS 扫描服务**。

## 一线支持更常见的 security 问法

### 用户能登录，但项目里什么都看不到，第一反应查什么？
先别急着说“权限丢了”，按这个顺序最快：
1. 账号状态是不是 `Normal`
2. 看的到底是 **Platform Roles** 还是 **Kubernetes Roles**
3. 权限是直接绑给用户，还是从用户组继承
4. `cluster / project / namespace` 的 scope 有没有绑对
5. 有没有只有 `Role/ClusterRole`，但没有 `RoleBinding/ClusterRoleBinding`

这类问题高频根因通常不是“平台坏了”，而是 **scope 绑错、binding 缺失、只看了用户页没看组页**。

### OIDC 配好了，用户也能跳第三方登录页，为什么还是回不来或登不上？
能跳到第三方页，只能说明“跳转动作发生了”，**不等于 ACP 这侧配置一定正确**。

先看三件事：
- provider 是否真的返回了 **email claim**
- `Client ID / Client Secret / Redirect URI` 是否和 IDP 侧注册值一致
- 添加/修改 OIDC 时的 **IDP Service Configuration Validation** 是否通过

如果 validation 都没过，就先回头查 OIDC 参数，不要先怀疑平台登录页。

### LDAP 用户能搜到，但就是登录不上，最该先查哪一项？
先查 **Login Field**，再查用户检索链。

最短路径：
1. 用真实 LDAP 账号做一次 validation
2. 确认测试账号输入值真的符合 `Login Field`
3. 核对 `baseDN / filter / scope / username(id)`
4. 如果只是组不对，再看 `groupAttr / userAttr / nameAttr`

很多现场不是 LDAP 服务坏了，而是**输入字段和目录映射对不上**。

### 组里明明有角色，为什么用户还是像没继承到权限？
先不要只盯用户个人页。

高频情况是：
- 用户其实已经在组里
- 组上也确实绑了角色
- 但角色 scope 不是用户当前要访问的 `cluster / project / namespace`
- 或者现场拿**旧会话**直接测，IDP / group claim 变化还没反映

一句话说，很多“没继承到”其实是 **scope 不对** 或 **会话没刷新**。

### 自定义角色都配了，为什么业务还是提示无权限？
最常见不是角色定义没写，而是**授权链没真正落地**。

先按这 4 步查：
1. role / roletemplate 是否存在
2. 如果走 `RoleTemplate`，最终 `ClusterRole` 是否真的生成
3. `UserBinding / RoleBinding / ClusterRoleBinding` 是否存在
4. binding 的 scope 是否就是目标业务要访问的范围

可以直接记：
- **role 在，binding 不在** → 没真正授权
- **binding 在，scope 不对** → 绑错层级

### RoleTemplate 建了，怎么最快判断是不是“模板没生成最终权限对象”？
直接查最终产物，不要先猜缓存或 UI 展示。

最短动作：
- `kubectl get clusterrole -l auth.cpaas.io/role.relative=<roletemplate-name>`

如果这里查不到，优先判断为：**模板还没生成最终 ClusterRole**。这时继续排用户权限，价值不高。

### 审计页面能打开，但就是查不到记录，先怀疑什么？
先怀疑 **时间窗、过滤条件、tab 选错**，然后再怀疑 logging 底座。

最短排法：
1. 把时间窗从默认 **Last 30 Minutes** 放大
2. 去掉过窄过滤条件
3. 确认查的是 `User Operations` 还是 `System Operations`
4. 再确认 `ACP Log Essentails / ACP Log Collector / ACP Log Storage` 是否正常

实战里最常见误判不是“审计坏了”，而是**默认时间窗太短**。

### 审计没数据，但 Event 也没数据，这更像什么？
更像 **共享 logging 底座问题**，不是单独 audit 模块故障。

因为 audit 和 event 都依赖同一套日志采集、存储、查询链路。

所以现场同时出现“审计空、事件也空”时，优先回头查：
- logging 三件套是否安装
- 组件是否健康
- 数据是否真正采集/存储成功

### 用户昨天还能用，今天突然没权限了，最值钱的三项回看是什么？
优先回看这三件事：
1. 用户是否被移出组
2. 组上角色是否被解绑或 scope 被改
3. 外部 IDP / LDAP 变更后，用户是否变成 `Invalid`，或 group claim 是否发生变化

这种“昨天好好的，今天不行”的问题，常常不是即时故障，而是**身份或授权关系发生了变更**。

### 改了用户安全策略，为什么用户说“看起来没变化”？
先确认他测的是不是**旧会话**。

特别是 `Access Control` 相关策略，要记住两个边界：
- **通常只影响新登录**，不会立即追踢当前在线会话
- 浏览器恢复标签页，不一定等于策略失效

最小验证动作是：
1. 退出当前会话
2. 重新登录
3. 再测试会话超时 / 并发登录 / 关闭标签页退出等行为

### 外部 IDP 用户删掉了，平台里为什么还看得到？
“还看得到”不等于“还能用”。

更常见的真实状态是：
- 用户被重新同步后变成 **`Invalid`**
- 角色绑定关系可能还保留
- 但这个用户已经不能继续登录

所以先看**状态字段**，不要只看“列表里还有没有这个人”。


### `cpaas-system/sentry-serving-cert` 即将过期，一定要人工处理吗？
先不要把“临期告警”直接等同于“自动续签失效”。

更稳口径是：
- `sentry-serving-cert` **通常会自动续签**
- 常见续签时点是**到期前一天**
- 如果客户想人工触发，或确认已经没有自动轮转，再走：**先备份 Secret，再删除 Secret 促发重新签发**

所以一线先做的不是立刻手工换证书，而是先分清：
1. 现在只是临期告警，还是已经出现 TLS/组件异常
2. 是否仍在自动轮转窗口内
3. 是否真的需要人工触发

参考 case：`TICKET-1348861004`


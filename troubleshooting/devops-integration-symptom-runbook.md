---
title: ACP DevOps Integration Symptom-Based Runbook
type: runbook
status: draft
domain: devops-integration
product: acp
tags: [acp, devops-integration, runbook, sso, plugin, nexus, katanomi, troubleshooting, ticket-derived]
updated: 2026-06-21
source: [experience, ticket-cases]
related:
  - ../../product-catalog/office_docs/faqs/devops-integration-faq.md
  - ./devops-sso-domain-proxy-checklist.md
  - ./devops-jenkins-branch-slash-image-tag-quick-card.md
  - ../knowledge-project-home.md
  - ../../ticket-documents/indexes/problem-clusters.md
---

# ACP DevOps 集成与插件现象排障手册

## 1. 首页分诊

先把问题分成四层：
1. 域名/代理/入口层
2. SSO/认证回调层
3. 权限与角色层
4. 第三方工具/插件配置层

---

## 2. 现象：平台主页正常，但 DevOps/DP 通过域名做 SSO 登录失败

### 更像卡在哪一层
优先怀疑：**SSO 回调链路** 与 **代理配置层**。

### 最小验证动作

1. 确认平台是否新增了额外域名访问地址
2. 确认代理/Nginx 是否正确透传协议、Host、回调链路信息
3. 确认 DevOps/DP 使用的新域名是否全部纳入认证回调配置
4. 区分是 ACP 本体正常，还是工具链子系统单独异常

### 代表案例
- [TICKET-1310428344](../../ticket-documents/cases/TICKET-1310428344%20dp和devops工具链使用sso登录无法正常通过acp的域名进行认证登录.md)

---

## 3. 现象：已授权，但插件/工具链仍提示无权限

### 更像卡在哪一层
优先怀疑：**权限模型理解偏差** 与 **缺少上层权限**。

### 最小验证动作

1. 对比有权限账号与无权限账号的完整权限集
2. 区分项目权限、集群权限、exec 权限等层次
3. 看是否只是某个动作缺少附属权限
4. 必要时用测试账号复现验证

### 代表案例
- [TICKET-1298959034](../../ticket-documents/cases/TICKET-1298959034%20分配自定义项目角色后，katanomi报无权限错误.md)

---

## 4. 现象：代码提交后没有自动触发流水线

### 更像卡在哪一层

先分三段：**提交是否命中触发规则**、**eventing/trigger 入口是否安装并正常**、**是否已生成 PipelineRun**。

### 最小验证动作

1. 确认这次提交是否只是 README/文档或被路径过滤排除的文件。
2. 确认 eventing / trigger / Tekton 相关组件是否安装并 Running。
3. 查最近是否生成 PipelineRun；没有 PipelineRun 时不要先看 Task 日志。
4. 若 PipelineRun 已生成，再进入凭据、构建节点、镜像仓库和脚本阶段。

### 代表案例

- [TICKET-1313622684](../../ticket-documents/cases/TICKET-1313622684%20CI%20CD%20中的流水线配置了代码仓库自动触发，代码提交后怎么没自动触发呢？.md)：README 提交未触发有路径过滤可能，最终闭环为 eventing 未安装，安装后触发成功。

## 5. 现象：外部工具迁移 / 集成后行为不符合预期

### 更像卡在哪一层
优先怀疑：**集成配置层** 与 **支持边界层**。

### 最小验证动作

1. 明确是接入失败、迁移失败，还是功能行为异常
2. 确认目标工具是否在当前方式下被支持
3. 核对认证、入口、回调、权限、配置项是否完整
4. 再判断是不是产品边界问题

### 代表案例
- [TICKET-1308704484](../../ticket-documents/cases/TICKET-1308704484%20外部二进制部署nexus数据迁移devops%20nexus%20v3.md)
- [TICKET-1334827974](../../ticket-documents/cases/TICKET-1334827974%20集成禅道插件，无法集成.md)
- [TICKET-1285393984](../../ticket-documents/cases/TICKET-1285393984%20gitea和gitee支持情况.md)

---

## 5. 现象：流水线排队不执行 / Git clone 失败 / Tekton workspace 只读 / 执行后日志丢失

### 更像卡在哪一层
优先怀疑：**流水线执行层**，其次再细分到 **Jenkins executor 调度**、**Git 集成地址/凭据映射**、**Tekton workspace 绑定**、**日志采集/结果存储前置**。

### 最小验证动作

1. 先确认流水线是否真的拉起了 executor Pod / TaskRun，而不是只停留在页面状态
2. 如果是 Jenkins 类执行链，先看 Pod 是否被 Kubernetes 正常调度，重点看 request 与节点剩余 allocatable
3. 如果 clone 失败，核对 pipeline 引用的仓库地址、integration 地址、secret 凭据是否一一对应
4. 如果报 `Read-only file system`，优先检查 workspace/output 是否绑定到了可写卷
5. 如果执行过程中能看到日志、执行完后历史日志不可见，先确认流水线所在集群是否部署日志采集与日志存储插件，以及 Results/日志归档链路是否正常
6. 如果用户问的是 step 级条件跳过，先区分这是语法问题还是当前版本支持边界问题

### 代表案例
- [TICKET-1316020544](../../ticket-documents/cases/TICKET-1316020544%20Pipeline%20queued%20forever，不是自定义%20Python%20镜像本身，而是%20Jenkins%20执行%20Pod%20根本没被%20Kubernetes%20正常调度.md)
- [TICKET-1318135504](../../ticket-documents/cases/TICKET-1318135504%20Pipeline%20clone%20失败，不是%20GitLab%20本体故障，而是流水线使用的集成地址与实际仓库地址不匹配.md)
- [TICKET-1333458354](../../ticket-documents/cases/TICKET-1333458354%20流水线%20Git%20鉴权异常，不是简单跳过%20TLS，而是历史%20HTTP%20集成与现网%20HTTPS%20仓库地址长期错位.md)
- [TICKET-1344080604](../../ticket-documents/cases/TICKET-1344080604%20Tekton%20git-clone%20报%20Read-only，不是仓库权限问题，而是输出%20workspace%20绑定到了只读路径.md)
- [TICKET-1337335014](../../ticket-documents/cases/TICKET-1337335014%20想按表达式跳过%20step，不是%20YAML%20写法问题，而是当前版本对%20step%20级条件执行支持不足.md)
- TICKET-1349822224：流水线执行时能看到日志、执行完后日志不可见；样本口径为流水线所在集群需要部署日志采集/日志存储插件，先补前置再排流水线本身。

### 历史日志不可见补充

- “执行中有日志”只说明实时流可见，不代表历史日志已经被采集、索引和持久化。
- 先确认日志采集、日志存储、Results/归档相关插件在**流水线实际运行的集群**可用；不要只看 global 或 DevOps 页面。
- 如果插件齐全仍丢历史日志，再补 PipelineRun/TaskRun、日志 collector、存储索引和页面查询接口证据。

### Deep-case 信号

- 当前判断：可选。
- 原因：缺日志采集/存储插件属于稳定前置 FAQ；如果插件齐全仍稳定丢日志，才需要深入执行结果链路。
- 还缺什么证据：PipelineRun/TaskRun、实时日志与历史日志时间线、日志采集插件状态、collector 日志、存储索引、Results 组件状态和页面查询请求。

---

## 6. 现象：Jenkins 构建 Pod 要固定节点 / 分支名导致镜像 tag 失败

### 更像卡在哪一层

优先怀疑：**构建节点调度配置** 与 **流水线变量到镜像 tag 的转换**。

### 最小验证动作

1. 固定构建节点时，先在构建节点配置页核对“节点标签器 / node label”，确认 Jenkins executor Pod 或构建 Pod 的 nodeSelector/label 是否实际生效。
2. 如果目标节点带污点，单独确认构建节点配置里是否支持 toleration；没有明确入口时，不要承诺直接由页面自动容忍。
3. 分支名包含 `/` 导致构建失败时，检查镜像 tag 或镜像名是否直接使用了 `${GIT_BRANCH}`。
4. Docker/OCI 镜像 tag 不能直接包含 `/`；可改用已经规整的 `${BRANCH_NAME}`，或在流水线中显式替换非法字符。
5. 若失败发生在 push 阶段，再继续检查 registry 地址、登录凭据、项目权限与网络，不要把 tag 格式错误误判为 Harbor 故障。
6. 关联短卡：[[devops-jenkins-branch-slash-image-tag-quick-card]]、[[devops-jenkins-build-pod-node-affinity-faq]]。

### 构建 Pod 固定节点补充

- “节点标签器 / node label”只能证明调度目标表达出来了，还需要看实际生成 Pod 的 `nodeSelector` / affinity 与调度事件。
- 目标节点如果有污点，必须同时确认构建节点配置是否能表达 toleration；如果不能表达，不能假设平台会自动容忍。
- 固定节点后流水线仍一直加载中或无法创建时，要先看是否生成了 Jenkins executor Pod / PipelineRun / TaskRun，再按调度、资源、权限或模板错误拆分。

### 代表工单

- TICKET-1352032864：Jenkins 构建 Pod 固定节点可先用节点标签器/node label；污点容忍需要另确认配置入口；后续“流水线一直加载中”需另按生成对象与调度事件排查。
- TICKET-1352408354：分支名带 `/` 时，若用 `${GIT_BRANCH}` 作为镜像 tag 会失败，可改用 `${BRANCH_NAME}` 或做字符替换。

### Deep-case 信号

- 当前判断：不需要。
- 原因：这是构建节点调度与变量格式 FAQ，已有稳定操作口径。
- 还缺什么证据：如要升级为 deep-case，需要 Jenkins 配置截图/ConfigMap、生成 Pod spec、TaskRun/PipelineRun 事件、完整失败日志与变量展开结果。

---

## 6. 现象：DevOps v3 集成 Harbor / 插件服务异常

### 更像卡在哪一层
优先怀疑：**Katanomi 控制链、插件服务访问链、RBAC 权限链**，不要先把问题归到 Harbor 本体。

### 最小验证动作

1. 确认 Katanomi 实例和 `katanomi-operator` 是否正常。
2. 查 operator ServiceAccount 是否具备 `proxy.katanomi.dev` 下 `proxies` / `proxies/path` 等必要权限。
3. 从相关 Pod 内验证 `katanomi-plugin.cpaas-system.svc.cluster.local` 的 DNS 解析、Service Endpoints 与访问耗时。
4. 补权后如果仍报 `i/o timeout`，继续查 CoreDNS、NetworkPolicy、Service、Endpoints，而不是反复修改 Harbor 凭据。

### 代表案例

- [TICKET-1338870724](../../ticket-documents/cases/TICKET-1338870724%20ACP部署devops%20v3无法集成harbor镜像仓库.md)：DevOps v3 集成 Harbor 失败先暴露 Katanomi operator RBAC 缺口，临时补权后继续暴露 `katanomi-plugin` DNS / 访问超时，最终根因弱闭环。

## 7. 现象：配置同步失败 / GitOps 应用不收敛

### 更像卡在哪一层

优先怀疑：**GitOps 控制器运行态**，其次再排 Git 仓库、凭据、目标集群权限与应用 YAML。

### 最小验证动作

1. 先看 `argocd-controller` / GitOps controller Pod 是否 CrashLoopBackOff 或频繁重启。
2. 查 event、`previous log` 与资源曲线，确认是否有 `OOMKilled`。
3. 如果 OOM 明确，先按对象规模、应用数量和集群数量调整 controller requests/limits，再观察同步队列是否恢复。
4. 只有 controller 稳定后仍失败，才继续排 Git 鉴权、网络、目标集群权限或 YAML 合法性。

### 代表案例

- [TICKET-1296708454](../../ticket-documents/cases/TICKET-1296708454%20集群配置同步失败.md)：配置同步失败最终由 `argocd-controller` OOM/频繁重启导致，扩内存后恢复。

---

## 8. 现象：GitLab 首页正常，但进入仓库目录报 500

### 更像卡在哪一层

优先怀疑：**Workhorse / Gitaly / repository storage / 底层文件系统**。GitLab 首页可访问只能证明入口和登录链路大体可用，不代表仓库数据链正常。

### 最小验证动作

1. 先确认 500 是否只发生在仓库文件浏览，还是项目列表、CI、制品库也异常。
2. 保存 Webservice、Workhorse、Gitaly 同一 request/correlation id 的日志。
3. 查看 Gitaly hang 进程、线程、`lsof` 和慢请求，定位是否卡在特定 repository/path。
4. 对异常仓库路径执行 `stat/ls/du`，同时查看 `dmesg`、`iostat`、文件系统错误。
5. 若怀疑 jar/大文件，补仓库对象大小、LFS 状态和近期提交证据，不能只凭经验冻结根因。

### 代表案例

- [TICKET-1351211004](../../ticket-documents/cases/TICKET-1351211004%20gitlab异常.md)：GitLab 仓库目录 500 只收敛到 Gitaly 读文件 hang 与仓库路径无法 `ls`，大文件/磁盘故障均需补证。


## 8.1 现象：DevOps v4 镜像 tag 需要时间戳 / 动态变量

### 更像卡在哪一层

优先按 **Pipeline 参数展开与 Task result 传递边界** 处理，不要先归因构建器、Harbor 或镜像推送链路。

### 最小验证动作

1. 先确认用户要的是镜像 tag 动态生成，而不是普通环境变量传入脚本。
2. 如果 tag 字段直接引用时间戳变量无法识别，按当前能力边界处理。
3. 在构建前加一个最小 `runscript` task，先输出固定字符串到 result，验证后续 task 能否引用。
4. 固定字符串可用后，再把输出替换为时间戳命令，并在镜像仓库核对最终 tag。
5. 若仍失败，回查 result 名称、引用语法、task 顺序与参数传递，不要直接进入 Harbor 凭据排查。

### 代表案例

- [TICKET-1351536474](../../ticket-documents/cases/TICKET-1351536474%20devops%20v4流水线构建镜像时如何使用时间戳变量.md)：DevOps v4 镜像 tag 当前不直接支持内置时间戳变量，稳定 workaround 是 `runscript` 生成时间戳并输出到 result，再由构建 task 引用。

## 8.2 现象：Knative / Tekton / 物理机发布类流水线能力边界（2026-06-19）

### 更像卡在哪一层

优先拆成 **插件前置安装**、**页面执行能力边界**、**任务镜像/脚本能力** 三层；不要把所有“流水线用不了”都归到 Jenkins/Tekton 本体故障。

### 最小验证动作

1. Knative 相关咨询先确认是否已在目标集群通过应用商店/Operator 安装 `knative-operator`，并创建所需的 `KnativeEventing` 实例；未安装前不要进入流水线触发器排障。
2. Tekton 页面直接执行 Pipeline 时，若客户希望绑定自定义 ServiceAccount，先确认当前页面/版本是否支持暴露 `taskRunTemplate.serviceAccountName`；若不支持，应按能力边界或后续版本需求处理。
3. DevOps v4 Connector 与 v3 工具链集成要分开说明：Harbor connector 后续能力不等于当前页面已可在创建应用时下拉选择任意镜像。
4. 流水线需要把 jar 推到物理机时，优先确认执行镜像是否包含 Ansible/SSH 等必要工具、目标主机网络与凭据是否可用；更换为带 Ansible 的镜像能恢复时，不要误判为平台发布链路故障。
5. 若仍失败，再收集 PipelineRun/TaskRun、Pod event、执行镜像、脚本日志、目标主机 SSH/网络证据。

### 关联工单

- TICKET-1348863194：Knative 安装咨询，稳定口径为先安装 `knative-operator` 并创建 `KnativeEventing`。
- TICKET-1349520794：Tekton 页面执行 Pipeline 的 ServiceAccount 绑定与 Harbor connector 下拉选择镜像属于当前能力边界/后续支持范围。
- TICKET-1348917234：流水线构建后把 jar 推到物理机，最终通过更换带 Ansible 的执行镜像完成。

### Deep-case 信号

- 当前判断：一般不需要。
- 原因：当前样本主要是插件前置、页面能力边界和执行镜像工具链问题，适合 FAQ/runbook 化。
- 还缺什么证据：若要 deep-case，需要 PipelineRun/TaskRun YAML、ServiceAccount/RBAC、执行 Pod spec、完整日志、目标主机连接证据与版本能力说明。


## 8.3 现象：Pipeline Results / EventListener 暴露 / Hub 模板参数短链路 FAQ（2026-06-19）

### 更像卡在哪一层

优先按 **版本能力边界** 与 **模板参数类型** 处理，不要把所有报错都直接归到 Tekton controller 或 Harbor/S3 故障。

### 最小验证动作

1. Pipeline Results API 访问 S3 secret 失败时，先确认 Pipelines/operator 版本；4.7 时代不宜默认支持完整 S3 secret 能力，4.8+ 已有相关能力说明，现场升级到 4.11 后恢复的样本可作为版本边界参考。
2. Tekton EventListener 暴露诉求要区分 Gateway API/HTTPRoute 与 Ingress；在 DevOps Pipelines 4.10 中，EventListener 通过 Gateway API/HTTPRoute 自动暴露不作为支持路径，Ingress 是当前可复用入口。
3. 使用 Hub 创建流水线时若页面提示参数类型错误，优先核对模板参数 schema 与页面字段类型；数组值传给 string 字段时，先移除 `[0]` 等数组包装再验证。
4. 以上问题若已升级/调整模板后仍失败，再收集 PipelineRun/TaskRun、controller 日志、模板渲染结果、S3 secret 引用和入口对象 YAML。

### 关联工单

- TICKET-1351652324：Pipeline operator 4.7 Results API 访问 S3 secret 边界；4.8 后支持相关能力，现场使用 4.11.0 已解决。
- TICKET-1350882224：DevOps Pipelines 4.10 不支持通过 Gateway API/HTTPRoute 自动暴露 Tekton EventListener，当前支持路径为 Ingress。
- TICKET-1352597054：Hub 流水线模板参数给的是数组但页面字段为 string，去掉 `[0]` 后正常。

### Deep-case 信号

- 当前判断：不需要。
- 原因：当前样本属于版本能力、入口支持路径和模板参数类型 FAQ。
- 还缺什么证据：如要 deep-case，需要 Pipelines/operator 版本、Results API controller 日志、S3 secret YAML、EventListener/Ingress/HTTPRoute 对象、Hub 模板 schema、渲染后的 PipelineRun/TaskRun 与完整报错。

## 8.4 现象：Helm Chart 表单/模板应用导入/组件 limit 调整边界（2026-06-20）

### 更像卡在哪一层

优先拆成 **Hub/Chart 前端展示能力**、**模板导入版本缺陷与跨环境可移植性**、**平台组件资源由谁托管** 三层；不要把这些咨询直接归成流水线或 Helm controller 故障。

### 最小验证动作

1. 自定义 Chart 的 `values.schema.json` 字段未在表单展示时，先确认 schema 嵌套深度、字段类型与当前前端支持能力；已知前端只展示较浅层级时，深层字段不显示属于能力边界/需求。
2. 模板应用导入显示成功但资源未创建时，先确认平台版本；若命中已知版本缺陷，优先建议升级到修复版本后复测。
3. 模板导出跨环境复用前，检查 storageClass、`volumeClaimTemplates`、内部路由标签、`imagePullSecrets`、`nodeSelector`、annotations、resources 等是否写死环境信息。
4. `olm-operator`、`katanomi-proxy` 等平台组件资源 limit 调整时，优先查对应实例/helm values 的托管入口；若低版本存在字段不生效缺陷，临时 `skip-sync`/直接改 Deployment 只能作为受控绕行，不能沉淀成默认方案。
5. 若调整后仍不生效，再补 operator 版本、实例 YAML、helm values、reconcile 日志、Deployment diff 和资源水位证据。

### 关联工单

- TICKET-1350764534：自定义 Chart schema 字段未展示，当前前端只支持较浅 depth 的表单展示。
- TICKET-1351007804：模板导入未创建资源命中版本缺陷，4.2.5 及之后修复；导出模板跨环境通用性不足属于需求/设计边界。
- TICKET-1351382064：`olm-operator` / `katanomi-proxy` 资源 limit 调整应走托管实例/helm values；旧版本 katanomi proxy 存在字段不生效 bug，现场曾用 `skip-sync` 绕行。

### Deep-case 信号

- 当前判断：可选。
- 原因：当前样本多数是前端能力、版本缺陷、模板可移植性和托管配置边界，适合 FAQ 化。
- 还缺什么证据：若要 deep-case，需要前端 schema 渲染规则、缺陷版本矩阵、导入/导出对象 diff、operator reconcile 日志、资源调谐链与绕行风险记录。

## 9. 支持现场优先问这 6 个问题

1. 这是入口访问问题、SSO 问题、权限问题，还是插件配置问题？
2. ACP 本体正常吗，还是只有子系统异常？
3. 是否刚做过域名切换、代理接入或回调地址调整？
4. 报无权限的是项目动作、集群动作，还是 exec 一类高权限动作？
5. 问题是否可用测试账号稳定复现？
6. 当前问题是支持边界咨询，还是现网功能故障？

---

## 9. 常见误判速查

- **平台主页正常 ≠ 工具链 SSO 一定正常**
- **角色里看起来都勾了 ≠ 权限链路完整**
- **插件页面能打开 ≠ 功能调用一定有权限**
- **集成失败 ≠ 一定是网络问题，也可能是支持边界或配置链路问题**

---

## 10. 从这类问题里最值得继续沉淀什么

优先建议继续沉淀：

- 域名/代理切换后的 SSO 排查清单
- DevOps / DP / 插件权限模型对照说明
- 第三方工具接入支持边界 FAQ
- 测试账号复现与权限比对模板

## 10. 现象：插件/AI Essentials 一直安装中但 Pod 无明显异常（2026-06-06）

来自 [[TICKET-1347979744 Alauda AI Essentials安装失败]] 的补充：

- 如果不是单个插件，而是所有插件都卡在“安装中”，优先查统一编排/状态同步链（如 `sentry`），不要直接归因到 AI Essentials 或具体插件本体。
- 对比页面安装状态、`moduleplugin` / `helmrelease` / ARS 对象与实际 Pod；Pod Running 不代表安装状态回写链正常。
- 重启 `sentry` 只能作为恢复动作；重启前后要保存 stuck 对象清单、日志与恢复时间，避免把一次性运行态刷新误写成通用产品缺陷。


## 8. 现象：制品晋级跨网络分区失败或不清楚应放通哪段网络

### 更像卡在哪一层

优先怀疑：**执行 Pod 所在集群到源/目标 Harbor 入口的网络路径**，而不是两个 Harbor 后端之间直接复制。

### 最小验证动作

1. 确认源 Harbor、目标 Harbor 是否都已集成到平台。
2. 执行一次制品晋级，定位一次性晋级 Pod 的集群、命名空间和节点。
3. 从执行 Pod/节点分别访问源 Harbor 与目标 Harbor 的 VIP/NodePort/Ingress 入口端口。
4. 查看晋级任务日志，区分失败发生在 pull 源 Harbor 还是 push 目标 Harbor。
5. 网络策略不要依赖一次性 Pod 固定 IP；优先围绕执行集群节点到两端 Harbor 入口放通。

### 代表案例

- [TICKET-1350095344](../../ticket-documents/cases/TICKET-1350095344%20制品晋级策略使用咨询.md)：制品晋级由执行资源所在集群/命名空间的一次性 Pod 从源 Harbor 拉取并推送目标 Harbor，放通策略围绕执行节点与两端 Harbor 入口验证。

---


## 11. 现象：DevOps 外部工具、构建镜像与制品链路边界短 FAQ（2026-06-21）

### 适用场景

- Jenkins 构建时要选择第三方依赖仓库 / Nexus，或客户询问外部 GitLab、Nexus、SonarQube 版本是否支持；
- Maven/JDK/NodeJS 构建镜像地址修改后拉取失败，或平台内置构建环境版本不满足业务；
- DevOps v4 集成外部 Harbor 后，部署 Deployment 时想从镜像选择器中选择镜像；
- `violet push`/插件包上传后平台里看不到版本，或 Jenkins 部署缺镜像；
- 开启自定义 CA 后，HTTP Git/OCI 拉取反而失败。

### 典型现象

- 外部 Nexus 集成后，构建页面是否能选择第三方依赖仓库存在疑问；
- 修改 maven cm/jdk 镜像地址后，构建 Pod 拉不下来镜像，改为可访问/公开仓库后恢复；
- 客户需要 Node 15/16 等构建环境，但平台下拉只提供少量版本；
- 插件包上传后没有版本，重启 `cluster-transformer` 后恢复；
- 自定义证书配置后，原本 HTTP 明文 Git 拉取链路被信任/协议配置影响。

### 排查路径

1. 先拆清楚是 **工具链集成**（GitLab/Nexus/Sonar/Harbor Connector）、**构建镜像选择**、**流水线运行时拉镜像**，还是 **扩展包上传/登记**。
2. 外部 Nexus/GitLab/SonarQube 先确认产品版本支持矩阵、Connector 类型、地址/证书/认证；“理论可接入”不等于已验证该客户版本。
3. Maven/JDK/NodeJS 构建环境优先按镜像处理：镜像必须能被执行集群拉取，且地址、凭据、架构、仓库可见性匹配。
4. 如果需要未内置的 NodeJS/npm 版本，优先自制构建镜像并推送到平台可访问仓库；页面未显示时再查镜像元数据同步/模板配置。
5. `violet push` 成功但页面无版本时，先查 Artifact/ArtifactVersion、`moduleConfig`、`cluster-transformer`/catalog/OLM/minfo 状态，不要只重复上传 tgz。
6. 自定义 CA 与 HTTP 明文拉取要分开：信任 CA 解决 HTTPS 证书链，不等于允许 HTTP cleartext；需核对 Git/OCI 地址协议与 controller/runtime 配置。

### 处理建议

- 对 Nexus/GitLab/SonarQube：给出“按支持矩阵 + API 兼容 + Connector/凭据验证”的边界，必要时让项目侧做最小接入验证。
- 对构建镜像：优先把所需工具链封装成业务构建镜像，推到 11443/外部 Harbor，并在流水线模板里显式引用。
- 对镜像拉取失败：先用 Pod event、registry 响应和节点 runtime 日志判断，不要只改 ConfigMap。
- 对插件上传：复用扩展包 runbook 的 `violet show/verify/push → Artifact/ArtifactVersion → ModuleInfo/安装对象` 链路。

### 风险边界

- 外部工具版本未经测试时，只能按 API/协议兼容给边界，不应承诺正式支持。
- 构建镜像自定义后，维护责任、漏洞修复、架构适配通常转向客户/项目侧。
- 重启 `cluster-transformer` 只能作为运行态恢复动作；需保留重启前对象状态和日志。
- HTTP 明文拉取与 HTTPS 自定义 CA 是两类问题，不能互相替代。

### 关联工单

- TICKET-1352703964：Jenkins 第三方依赖仓库需先集成符合版本要求的 Nexus。
- TICKET-1352747264：修改 maven cm/jdk 镜像地址后拉取失败，改为可访问仓库后恢复。
- TICKET-1352712564：Node/npm 构建环境版本不足，可自制所需 NodeJS 镜像并推送到平台仓库。
- TICKET-1350421104：DevOps v4 部署 Deployment 镜像选择外部 Harbor 能力，当前样本指向后续版本支持边界。
- TICKET-1350449994：外部 Harbor 单命名空间可用镜像服务 Secret，多命名空间/无密工作负载可评估 Harbor Connector。
- TICKET-1352655324：Service Mesh Essentials tgz 通过 violet 上传后无版本，重启 `cluster-transformer` 后恢复，仍需保留对象链证据。
- TICKET-1353420804：Jenkins 3.20 部署缺镜像，现场先回退/使用 3.20.17 版本。
- TICKET-1352317694：开启自定义证书后 HTTP 拉代码失败，需区分 CA 信任与明文协议支持。
- TICKET-1352980154：制品晋级参数咨询，优先复用制品晋级 FAQ/执行 Pod 网络路径分层。
- TICKET-1353446524：ACP 4.3 ArgoCD operator 源码版本咨询，属于版本物料确认，不应扩写成故障。

### Deep-case 信号

- 当前判断：可选。
- 原因：本组多为外部工具版本、构建镜像、插件上传状态和能力边界 FAQ，适合短链路沉淀。
- 还缺什么证据：若要 deep-case，需要 Connector CR/Secret、PipelineRun/TaskRun、构建 Pod event、registry/Git/Nexus/Sonar 响应、`violet` 输出、Artifact/ArtifactVersion、controller 日志和版本支持矩阵。


## 11.1 Jenkins 队列、AC 登录、Tekton Hub 与 OLM 资源边界（2026-06-21）

### 适用场景

- Jenkins 流水线再次执行后一直排队，不进入执行；
- `ac login` 报 session 已存在或 kubeconfig/context 仍使用旧凭证；
- 需要通过 TektonConfig 覆盖 Tekton Hub catalog；
- `olm-registry-platform` 等 operator 管理组件资源使用率高，直接改 Deployment 会被还原。

### 排查路径

1. Jenkins 队列问题先确认 Jenkins operator 版本、controller 日志、队列状态和是否命中已知缺陷；已确认产品 bug 时按插件版本修复口径处理。
2. `ac login` 先查本地 session/context/kubeconfig 是否同名残留；清理 session 或同名 kubeconfig 后再登录验证。
3. Tekton Hub catalog 配置优先按 TektonConfig `spec.hub.options.configMaps` 覆盖 tekton-hub-api 的 `CATALOGS`，再看 operator 渲染结果。
4. OLM/operator 管理组件资源调整时，先找声明源（如 ConfigMap/CSV/OperatorHub 配置），不要改生成 Deployment。

### 风险边界

- Jenkins 已知 bug 需要版本修复，不建议通过重启或手工改内部状态长期绕行。
- 清理本地 session/kubeconfig 可能影响当前终端上下文，操作前需确认目标集群。
- 修改 operator 声明源可能触发组件滚动重启，应在维护窗口执行。

### 关联工单

- TICKET-1354487434：Jenkins operator v3.20.20 再次执行流水线一直排队，研发确认后续插件版本修复。
- TICKET-1354782264：`ac login` 报 session already exists，可清理 session 或同名 kubeconfig 后重试。
- TICKET-1354810404：TektonConfig 可通过 `spec.hub.options.configMaps` 覆盖 tekton-hub-api `CATALOGS`。
- TICKET-1354643464：`olm-registry-platform` 资源使用率高，需通过 global 集群 `olm-registry-config` ConfigMap 等声明源调整 limit，Pod 会自动重建。

### Deep-case 信号

- 当前判断：一般不需要。
- 原因：多为已知版本 bug、客户端状态残留或声明态配置入口问题。
- 还缺什么证据：若要 deep-case，需要 Jenkins queue/controller 日志、operator 版本矩阵、ac session/kubeconfig diff、TektonConfig 渲染资源、OLM ConfigMap/CSV 与生成 Deployment diff。

## 8.4 现象：GitLab / Nexus / SonarQube 工具链咨询与迁移短 FAQ（2026-06-23）

### 更像卡在哪一层

优先按 **工具自身配置 → 平台集成对象 → 流水线/使用入口 → 存储/网络/迁移边界** 拆分，不要把所有 GitLab/Nexus/SonarQube 报错都归到 DevOps 平台故障。

### 最小验证动作

1. GitLab token/CI/CD 异常时，先确认 GitLab 版本、管理员设置和对象存储/Job logs 配置；新版本 GitLab 的默认选项可能触发平台外部依赖问题。
2. GitLab 迁移/停用/只读恢复时，先区分是实例级操作、Deployment 副本数、Alb/域名复用、PostgreSQL/Redis 数据清理，还是文档 NodePort 与现场端口范围不一致。
3. Nexus 代理仓库 502/503 或依赖不存在时，先确认依赖是否实际存在于上游/代理仓库、Nexus PVC/健康、外网访问和流水线失败时间；不要只看“平台 Nexus 正常访问”。
4. Nexus 插件安装、镜像替换或 `skip-sync` 类操作属于非标准维护边界，必须明确客户自维护、回滚和升级同步风险。
5. SonarQube 登录/Token/扫描失败时，先按默认账号、token 配置、扫描 Pod 事件/日志、Java heap/执行镜像资源分层；不要直接跳到平台集成问题。

### 典型处理建议

- GitLab 新版本无法生成 token 且报 Job logs/object storage 相关错误时，可检查管理员 CI/CD 设置中的 Job logs/object storage 开关；若未配置对象存储，不要默认定责平台。
- GitLab 备份设置只读后，若实际只是把相关 Deployment 副本数缩为 0 并加注解防止回滚，恢复路径通常是按文档还原副本数；生产需确认操作对象。
- Nexus 代理报 502/503 时，用同一依赖在上游、平台 Nexus、流水线 Maven 三处对齐时间线；依赖创建时间晚于流水线失败时间时，不应归为平台故障。
- SonarQube 扫描 Java heap OOM，应先留扫描 Pod 日志、事件、执行参数与项目规模，再评估扫描器资源或规则集。

### 关联工单

- TICKET-1311999904：GitLab 17.11.2 默认开启 CI/CD Job logs 相关选项但未配置对象存储，导致 token 配置异常。
- TICKET-1316439134：GitLab 数据迁移文档中的 NodePort 可按现场实际端口调整，建议与原 GitLab 暴露端口保持一致。
- TICKET-1325417804：GitLab v3 停用并切 v4 涉及 ALB 复用、Redis sentinel YAML、PG 双库凭据和脏数据清理。
- TICKET-1317158634：GitLab 备份只读后恢复，样本中实质为还原两个 GitLab Deployment 副本数。
- TICKET-1275705194：Nexus proxy 502/503 需核对上游依赖是否存在、远端仓库和流水线失败时间线。
- TICKET-1268515694：流水线失败由 Nexus 中缺少依赖 jar 或下载慢触发，依赖补齐后再次执行成功。
- TICKET-1275732814：流水线添加 Nexus 需通过工具链集成把 Nexus 分配到流水线所在项目。
- TICKET-1263215774：Nexus 插件安装/镜像替换依赖 skip-sync 和自维护镜像，属于维护风险边界。
- TICKET-1313358664：SonarQube 实例默认 `admin/admin` 登录后修改密码并生成 token。
- TICKET-1293978044：SonarQube code scan Java heap OOM，需要回到流水线 Pod 事件/日志和扫描资源。

### Deep-case 信号

- 当前判断：可选。
- 原因：多数样本是工具配置、迁移操作、依赖仓库内容或能力边界 FAQ；只有跨组件迁移失败、仓库数据异常、持续 5xx/OOM 或生产流水线大面积失败时才值得 deep-case。
- 还缺什么证据：工具版本、实例 YAML、Deployment/Pod 事件、数据库/Redis/Nexus PVC 状态、流水线日志、上游仓库访问日志、迁移前后域名/端口/ALB 配置、客户变更步骤和回滚记录。


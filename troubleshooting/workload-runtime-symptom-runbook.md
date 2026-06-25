---
title: ACP Workload Runtime Symptom-Based Runbook
type: runbook
status: draft
domain: workload-runtime
product: acp
tags: [acp, workload-runtime, runbook, cpu, gpu, memory, pod, troubleshooting, ticket-derived]
updated: 2026-06-20
source: [experience, ticket-cases]
related:
  - ../../product-catalog/office_docs/faqs/workload-runtime-faq.md
  - ../knowledge-project-home.md
  - ../../ticket-documents/indexes/problem-clusters.md
---

# ACP 容器运行时与资源现象排障手册

> 这份手册按支持现场最常见的**现象**写，不按组件目录写。
>
> 核心目标：先判断问题更像卡在 **调度 / 资源 / 运行时 / 应用 / 展示换算** 哪一层，再做最小验证。

## 1. 首页分诊

先把问题放回这条链路：

**资源配置 → 调度 → Pod 创建 → 运行时启动 → 探针/依赖 → 平台展示/监控**

### 最短判断顺序

1. 这是“真的运行异常”，还是“展示值看起来怪”
2. Pod 是否创建成功、是否 Ready
3. 节点资源、配额、污点、亲和性是否拦住
4. runtime / 挂载 / 镜像 / 探针 是否异常
5. 是否被 Operator 周期性回写
6. 指标异常是瞬时峰值还是持续异常

---

## 2. 现象：CPU 周期性过高

### 更像卡在哪一层
优先怀疑：**组件行为特征** 或 **资源配置层**，其次才是故障。

### 最小验证动作

1. 观察是否固定周期出现
2. 确认对应组件是否有定时同步、索引刷新、后台任务
3. 看峰值期间是否伴随请求异常、重启、限流
4. 确认资源限制是否被 Operator 管理
5. 再判断是否需要调优或扩容

### 常见根因

- 组件按固定周期执行任务
- 资源限制过低导致放大峰值影响
- 手工修改 Deployment 被 Operator 回写
- 指标采样窗口导致“看起来很高”

### 代表案例

- [TICKET-1282398824](../../ticket-documents/cases/TICKET-1282398824%20CPU周期性过载且调整CPU限制配额后总被还原.md)
- [TICKET-1292277224](../../ticket-documents/cases/TICKET-1292277224%20asm-otel-backend-collector组件cpu占用高.md)

---

## 3. 现象：YAML 里的资源值和页面显示不一致

### 更像卡在哪一层
优先怀疑：**展示换算层**，不是故障层。

### 最小验证动作

1. 先区分 CPU 还是内存
2. 核对是否有单位（如 `m`、`Mi`、`Gi`）
3. 如果无单位，确认是否按 byte 展示
4. 看平台页面是否做了人类可读换算
5. 再判断是否真有数据错误

### 常见根因

- CPU `500m` 与 `0.5` 核混用
- 内存无单位时按 byte 保存
- 页面换算为 G / GiB 展示
- 上游 YAML 采集逻辑默认单位不一致

### 代表案例

- [TICKET-1297935034](../../ticket-documents/cases/TICKET-1297935034%20页面显示的容器资源限制的值，和yaml中不一致.md)

---

## 4. 现象：手工修改资源配置后又被改回去

### 更像卡在哪一层
优先怀疑：**Operator 管理层**。

### 最小验证动作

1. 确认目标 Deployment 是否由 Operator 管理
2. 查真正的配置源是 CR、ConfigMap 还是其他对象
3. 观察是否存在周期性 reconcile
4. 改正确入口，而不是只改 Deployment 本身

### 常见根因

- 直接改了派生产物
- 没改 Operator 的真实配置源
- 平台或 Operator 周期性回写

### 代表案例

- [TICKET-1282398824](../../ticket-documents/cases/TICKET-1282398824%20CPU周期性过载且调整CPU限制配额后总被还原.md)

---

## 5. 现象：Pod 起不来 / 启动异常 / 容器运行异常

### 更像卡在哪一层
这是最典型的多层交叉问题，优先按顺序拆层，不要一上来深挖应用。

### 最小验证动作

1. 看 Pod 是 Pending、CrashLoopBackOff 还是 Running NotReady
2. 检查节点资源、配额、污点、亲和性
3. 检查镜像拉取、挂载、探针、依赖服务
4. 检查 runtime 与节点基础环境
5. 再看应用自身错误日志

### 常见根因

- 资源不足或调度受限
- 挂载失败
- 镜像拉取问题
- 探针失败
- runtime 异常
- 依赖服务不可达

### 镜像拉取凭据最小链路

遇到 `ImagePullBackOff` / `no basic auth credentials`，不要只看 Harbor 项目是否 public，也不要默认自定义 ServiceAccount 会继承 `default` SA 的 pull secret：

1. 看 Pod 最终使用的 `serviceAccountName` 与 `.spec.imagePullSecrets`。
2. 看对应 SA 是否绑定 `imagePullSecrets`，以及 Secret 类型是否为 `kubernetes.io/dockerconfigjson`。
3. 解码 `.dockerconfigjson`，确认 registry host 与镜像引用 host 完全一致。
4. 多 Harbor 集成时，按镜像域名、项目名、namespace 与平台/项目级集成关系判断凭据来源。
5. Harbor UI/API public 状态不一致时，以 kubelet event、registry API 与节点/运行时实际 pull 响应交叉验证。

代表样本：

- [TICKET-1352079154](../../ticket-documents/cases/TICKET-1352079154%20拉取镜像时候imagepullsecret的注入逻辑是什么.md)：多 Harbor 集成 + 自定义 SA + Harbor public UI/API 差异，按 Pod→SA→Secret→Harbor 集成→registry 响应分层定界。

### 代表案例

- [TICKET-1339792844](../../ticket-documents/cases/TICKET-1339792844%20部署在容器中的软件都没法运行.md)
- [TICKET-1289381754](../../ticket-documents/cases/TICKET-1289381754%20测试集群-dev-region%20deployment启动异常.md)
- [TICKET-1313311794](../../ticket-documents/cases/TICKET-1313311794%20容器信创改造后在灵雀云三期上有内存持续缓慢增长问题.md)

### 5.1 KubeVirt / virt-handler 启动失败补充

遇到 `virt-handler` 启动失败时，不要只重启 Pod。先确认节点虚拟化运行时与内核/安全上下文：

1. 对比正常/异常节点 OS、kernel、SELinux/AppArmor/安全模块与 libvirt/qemu 版本。
2. 在容器内确认 `/dev/kvm`、VIRTTYPE、KVM 检测结果。
3. 复跑并保留 `virsh domcapabilities --machine q35 --arch x86_64 --virttype kvm` 输出。
4. 如果报 `Unable to query peer security context: Invalid argument`，优先查内核/security context/libvirt 支持矩阵。
5. 若客户已使用虚拟化，不要把“卸载 KubeVirt 后升级”当通用修复，先评估迁移与维护窗口。

代表样本：

- [TICKET-1351725704](../../ticket-documents/cases/TICKET-1351725704%20Rosneft%20virt-handler%20pod%20fails.md)：Astra Linux 1.8 / kernel 6.1.124 下 KVM 检测通过但 domcapabilities 失败，作为 KubeVirt 兼容性 evidence-boundary。

---


### 5.2 HAMI WebUI 数据源提示 Prometheus，但集群使用 VictoriaMetrics

遇到 HAMI WebUI 安装页提示填写 Prometheus 地址，不要直接要求同集群再安装 Prometheus。当前 ACP 使用 VictoriaMetrics 监控组件时，可把该地址填写为 VM 查询地址，再验证 WebUI 指标读取。

最小验证：

1. 先区分是 WebUI 入口不可访问，还是数据源地址/兼容性疑问。
2. 获取当前集群 VM 监控查询地址，填入页面提示的 Prometheus 地址字段。
3. 部署后检查 HAMI WebUI 是否能读取 GPU/任务指标。
4. 若仍无数据，再查 VM 地址、网络、认证和 HAMI metrics 暴露，不要先判 HAMI scheduler/device-plugin 故障。

代表案例：

- [TICKET-1351019544](../../ticket-documents/cases/TICKET-1351019544%20hami%20webui无法正常使用.md)：HAMI WebUI 支持对接 VictoriaMetrics，页面 “Prometheus 地址” 文案是提示边界，不是必须另装 Prometheus。

## 5.3 现象：Pod 起不来但根因在外部日志服务器 / Web CLI 菜单缺失 / 镜像拉取限速咨询

### 更像卡在哪一层

优先按 **平台边界 + 外部依赖 + 插件上架状态** 分流，不要把所有现象都归到 kubelet/runtime 故障。

### 最小验证动作

1. Pod 起不来时，仍先看 `kubectl describe pod` 事件与 `kubectl logs`；如果应用日志指向外部日志服务器空间不足，要把平台事件用于定界，后续转外部日志服务器空间处理。
2. 如果生产环境“没有 Web CLI 工具”，先确认 Web CLI 插件是否已上架/安装；菜单缺失不等于集群 exec 能力故障。
3. 客户咨询 ACP 是否具备镜像拉取速率限制时，按能力边界回复：当前不作为平台内置限速能力处理；若客户需要限速/配额，应回到 registry、网络出口或需求评估。
4. 若同时出现 `ImagePullBackOff`，再按 Pod→SA→Secret→Harbor/registry 响应链路排查，不要被“限速咨询”带偏。

### 常见误判

- Pod 启动失败 ≠ 一定是平台运行时问题，也可能是外部日志/挂载/依赖空间耗尽。
- Web CLI 菜单缺失 ≠ Kubernetes exec 故障，先看插件是否安装。
- 镜像拉取慢/失败 ≠ 平台一定有内置限速策略，需区分 registry、网络和凭据问题。

### 关联工单

- TICKET-1352181384：容器启动异常最终指向应用挂载的外部日志服务器空间不足，平台侧用事件/日志定界。
- TICKET-1352003784：生产环境没有 Web CLI 工具，原因是未上架/安装 web-cli 插件。
- TICKET-1351667224：客户咨询 ACP 镜像拉取速率限制，当前按非平台内置能力边界处理。

### Deep-case 信号

- 当前判断：不需要。
- 原因：外部依赖空间、插件安装状态和能力边界咨询均是短链路 FAQ。
- 还缺什么证据：若要 deep-case，需要 Pod 事件、挂载链路、外部日志服务器容量曲线；Web CLI 需插件安装记录与菜单权限；镜像限速需 registry/网络侧限流证据。

## 5.4 现象：Web Terminal 镜像加工具 / HAMi Ascend 镜像来源咨询（2026-06-19）

### 更像卡在哪一层

优先按 **平台组件支持边界** 与 **插件/镜像物料来源** 处理，不要直接改平台组件镜像或把镜像来源咨询写成运行时故障。

### 最小验证动作

1. 客户问 Web Terminal / Web CLI 使用哪个镜像、能否加 `helm` 等工具时，先确认当前版本该能力是否已下线或由 web-cli 插件承接。
2. 不建议为了增加工具直接修改平台标准组件镜像；如确有需求，应走项目/产品需求评估或提供客户自维护工具容器方案。
3. HAMi Ascend device-plugin 镜像来源咨询，先按文档版本确认镜像仓库与可达性；若需从 DockerHub/镜像站拉取，单独验证网络、代理和镜像同步策略。
4. 只有出现 `ImagePullBackOff`、device-plugin 不 Ready 或 GPU 资源未暴露时，才进入镜像拉取、节点驱动、device-plugin 日志和调度链路排查。

### 关联工单

- TICKET-1348955644：客户希望在 kubectl 网页终端镜像中增加 helm，稳定口径是不建议修改平台标准组件；4.2 版本相关旧能力已下线/由插件能力承接。
- TICKET-1348692044：HAMi Ascend device-plugin 镜像来源咨询，按文档/镜像仓库来源处理，先确认镜像可达。

### 补充：进入容器内部 / exec 功能开关

- 客户问“如何在容器平台进入容器内部”时，先区分 Kubernetes 原生 `kubectl exec`、平台 Web Terminal/Web CLI、以及具体工作负载页面的 exec 入口。
- 如果页面入口不存在或点击失败，先确认 exec/Web CLI 相关功能开关、插件安装状态、权限与浏览器基线；功能开关未启用时，按帮助文档开启后复测，不要直接判定容器运行时异常。
- 若命令行 `kubectl exec` 正常而页面不可用，再补 web-terminal/web-cli 后端日志、认证 token、浏览器控制台和页面请求。

关联工单：

- TICKET-1351135124：咨询如何在容器平台进入容器内部，确认是 exec 功能开关未开启，按帮助文档开启后解决。

### Deep-case 信号

- 当前判断：不需要。
- 原因：这是组件工具边界、镜像来源与 exec 功能开关 FAQ，不是故障证据链。
- 还缺什么证据：若要 deep-case，需要插件安装状态、菜单/权限、功能开关配置、页面/API 请求、镜像拉取事件、registry 响应、device-plugin 日志、节点驱动/NPU 状态和调度事件。

## 5.5 现象：Pod 反亲和配置、Web Exec/Debug 浏览器兼容边界（2026-06-20）

### 更像卡在哪一层

优先按 **调度策略语义 / 客户端兼容矩阵** 分流。反亲和是调度约束，不是运行时故障；Web Exec/Debug 页面按钮缺失也不一定是集群 exec 能力异常。

### 最小验证动作

1. 配置 Pod 反亲和前，先确认目标是“尽量分散”还是“必须分散”。
2. 平台基础模式通常由页面补齐底层参数；高级模式需显式确认 label selector、topologyKey、`preferred` / `required` 类型。
3. 生产环境优先使用 `preferredDuringSchedulingIgnoredDuringExecution` 做软约束；`requiredDuringSchedulingIgnoredDuringExecution` 会在节点/标签不满足时导致 Pod Pending。
4. 如果客户反馈浏览器里 Exec/Debug 入口缺失或只剩文件传输，先核对浏览器类型与版本是否在产品基线内，再看 Web CLI/exec 插件、权限和后端服务。
5. 不要把“统信浏览器不在基线内”写成 Kubernetes exec 故障；若换基线浏览器可用，应按客户端兼容边界处理。

### 常见误判

- 反亲和配置后 Pod Pending ≠ 调度器故障，可能是 `required` 约束过强或节点/标签不足。
- 选择高级反亲和 ≠ 一定更安全；错误 selector/topologyKey 会扩大调度风险。
- Web Exec/Debug 按钮缺失 ≠ 容器不可进入，可能是浏览器兼容、插件上架或权限问题。

### 关联工单

- TICKET-1352072594：Pod 反亲和生产配置咨询；基础/高级模式区别、`preferred` 与 `required` 的调度风险已形成稳定口径。
- TICKET-1349819914：统信浏览器无法使用 Exec/Debug，页面仅有“文件传输”按钮；确认浏览器版本不在产品基线内。

### Deep-case 信号

- 当前判断：不需要。
- 原因：反亲和语义和浏览器基线是稳定 FAQ/边界说明。
- 还缺什么证据：若要 deep-case，需要 Pod spec、调度事件、节点标签/污点、反亲和 YAML、浏览器版本、插件安装状态、页面请求和后端 web-terminal/exec 日志。

## 6. 现象：GPU 使用异常 / 单卡隔离不符合预期

### 更像卡在哪一层
优先怀疑：**节点能力 + 调度 + 运行时暴露**。

### 最小验证动作

1. 确认节点是否真的具备 GPU 能力
2. 确认驱动、device plugin、runtime 是否正常
3. 检查 GPU 资源是否被正确暴露
4. 检查调度标签、污点、隔离策略
5. 再看应用使用方式是否符合预期

### 常见根因

- 节点 GPU 能力未正常暴露
- device plugin 异常
- 调度标签或资源声明不匹配
- 单卡 / 多卡隔离策略理解偏差

### 代表案例

- [TICKET-1313719784](../../ticket-documents/cases/TICKET-1313719784%20GPU单卡隔离.md)
- [TICKET-1285416614](../../ticket-documents/cases/TICKET-1285416614%20模型应用同时使用CPU和GPU，cpu使用率不高问题.md)

---

## 7. 首页速查：支持现场优先问这 6 个问题

1. 这是“运行异常”还是“展示换算疑问”？
2. Pod 现在是 Pending、CrashLoop 还是 Ready？
3. 资源限制是谁在管理？人工还是 Operator？
4. 节点本身资源是否紧张？
5. 是否涉及挂载、探针、依赖服务？
6. 如果是 GPU，驱动 / device plugin / runtime 正常吗？

---

## 8. 常见误判速查

- **CPU 高 ≠ 一定故障**
- **页面与 YAML 不一致 ≠ 一定数据错**
- **Deployment 改回去 ≠ 配置没保存成功，而可能是 Operator 正常回写**
- **Pod 起不来 ≠ 平台页面问题**
- **GPU 问题 ≠ 只看 Pod 资源字段就够了**

---

## 9. 从这类问题里最值得继续沉淀什么

优先建议继续沉淀：

- 资源单位换算说明表
- Operator 管理对象资源修改标准路径
- Pod 启动失败最小分诊图
- GPU / CPU / 内存异常的支持现场问诊模板
- 2026-06-02 batch189：Pod `FailedScheduling` 同时出现 CPU、taint、affinity 时，参考 [[workload-runtime-scheduling-failedscheduling-quick-card]] 逐项拆调度过滤条件。

### batch231-kubevirt-virt-handler：KubeVirt virt-handler 启动失败

- 先确认这是虚拟化运行时/内核兼容性问题，还是普通 Pod 启动失败。
- 在 virt-handler 容器内保留 KVM 检测、`virtqemud`、`virsh domcapabilities` 完整输出；`/dev/kvm` 存在只能证明基础设备可见，不代表 libvirt/security context 可用。
- 对比正常/异常节点 OS、kernel、安全模块、libvirt/qemu 版本，并核对 ACP/KubeVirt 支持矩阵。
- 若客户已使用虚拟化，不要把“卸载 KubeVirt”当默认修复，先评估迁移与维护窗口。

代表案例：

- [TICKET-1351725704](../../ticket-documents/cases/TICKET-1351725704%20Rosneft%20virt-handler%20pod%20fails.md)


## 6.1 现象：GPU/NPU 支持矩阵、全局拉镜像凭据与反亲和配置咨询（2026-06-19）

### 更像卡在哪一层

优先按 **资源能力边界 / 调度策略语义 / 凭据分发范围** 分流，不要把咨询类问题直接写成 GPU、调度器或镜像仓库故障。

### 最小验证动作

1. NVIDIA T4 支持咨询：先确认 ACP 版本、GPU 驱动版本与支持矩阵；已有样本为 ACP 4.2.4 支持 NVIDIA T4，驱动要求 450+，但仍需以当前版本发布说明/产研确认为准。
2. Ascend NPU 安装调度：先走 NPU Operator 安装文档，确认节点前置、驱动/firmware 包、NPU 节点重启、`npuclusterpolicy` Ready 与 node allocatable，不要先调业务 Pod YAML。
3. 全局 ImagePullSecret/云凭据诉求：当前不支持用一个全局 ImagePullSecret 自动覆盖所有 namespace；仍需按 namespace、ServiceAccount、镜像仓库集成关系确认凭据注入。
4. Pod 反亲和：区分基本/高级配置，以及 `Preferred` 与 `Required`。`Preferred` 是尽量分散，资源紧张仍可同节点；`Required` 是强约束，节点不足时可能导致 Pod Pending。
5. GPU 使用量 API 咨询：区分 Pod 生命周期 API 与监控查询 API；GPU/CPU/内存用量通常通过 VictoriaMetrics/vmselect 指标查询链路完成鉴权与 PromQL/expr 查询。

### 关联工单

- TICKET-1350042644：ACP 4.2.4 支持纳管 NVIDIA T4，驱动 450+；在线文档当时未及时更新，需按当前支持矩阵复核。
- TICKET-1349547724：Ascend NPU 安装调度建议先参考 NPU Operator 安装文档。
- TICKET-1351204154：客户希望创建全局 ImagePullSecret/云凭据覆盖所有 namespace，当前暂不支持。
- TICKET-1352072594：Pod 反亲和基本/高级配置与 `Preferred`/`Required` 语义咨询，重点风险是强约束导致 Pending。
- TICKET-1348199944：Pod 启停接口与 GPU 使用量查询需要拆分；资源使用量查询更接近监控 API / vmselect 指标查询。

### Deep-case 信号

- 当前判断：不需要。
- 原因：这些样本主要是支持矩阵、凭据范围、调度语义和 API 入口 FAQ。
- 还缺什么证据：若要 deep-case，需要节点 GPU/NPU 驱动与 device-plugin 状态、allocatable、Pod 调度事件、namespace/SA/Secret YAML、监控查询 expr 与 API 返回、版本能力说明。

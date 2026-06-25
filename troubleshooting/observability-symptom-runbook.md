---
title: ACP Observability Symptom-Based Runbook
type: runbook
status: draft
domain: observability
product: acp
tags: [acp, observability, runbook, alerting, inspection, logging, troubleshooting, ticket-derived]
updated: 2026-06-20
source: [experience, ticket-cases]
related:
  - ../../product-catalog/office_docs/faqs/observability-faq.md
  - ../../product-catalog/office_docs/notes/observability.md
  - ./observability-inspection-alert-checklist.md
  - ../knowledge-project-home.md
  - ../../ticket-documents/indexes/problem-clusters.md
---

# ACP 可观测性现象排障手册

> 这份手册补的是历史工单里高频出现的支持现场问题，重点不再重复 tracing 官方能力，而是补 **告警、巡检、组件异常重启、日志查询、apiserver 报错** 这类场景。

## 1. 首页分诊

先把问题放回这条链路：

**采集/上报 → 存储/查询 → 告警/巡检规则 → 展示/通知**

### 最短判断顺序

1. 这是采集不到，还是采到了但展示/通知异常
2. 是单个组件异常，还是整条监控/日志链路异常
3. 是告警内容问题，还是告警触发/通知问题
4. 是巡检发现异常，还是客户想知道“该不该处理”

---

## 2. 现象：apiserver 持续报错，如 `invalid bearer token`

### 更像卡在哪一层
优先怀疑：**组件调用链路** 与 **认证/时间同步层**。

### 最小验证动作

1. 先确认报错是否持续、是否影响实际功能
2. 确认是否是某个组件（如 nevermore）持续发起请求
3. 检查节点时间是否同步
4. 必要时提高 apiserver 日志级别再取证
5. 再决定是否需要针对具体组件做重启或替换验证

### 常见根因

- 某组件携带了失效 token 持续请求
- 节点时间不同步导致 token 校验异常
- 日志报错存在，但未必已经影响功能面

### 代表案例

- [TICKET-1267752414](../../ticket-documents/cases/TICKET-1267752414%20apiserver报错.md)

---

## 3. 现象：组件异常重启 / 巡检提示异常 / 告警很多但现场说没影响

### 更像卡在哪一层
优先怀疑：**采集到的信号是真异常，还是阈值/规则/背景任务导致的表象**。

### 最小验证动作

1. 先确认异常对象：Pod、节点、指标还是巡检项
2. 看异常是否可复现、是否持续
3. 看是否伴随业务影响
4. 确认是采集数据异常、规则过敏，还是组件本身重启
5. 如果是巡检，优先给出“哪些要立即处理、哪些可观察”的分级判断

### 常见根因

- 组件确实异常重启
- 阈值太敏感或规则不够贴合现场
- 周期性任务导致短暂指标波动
- 巡检报告列出风险，但并非每项都必须立即处置

### 代表案例

- [TICKET-1272944244](../../ticket-documents/cases/TICKET-1272944244%20cpaas-system命名空间下出现rds-api组件异常重启.md)
- [TICKET-1281361754](../../ticket-documents/cases/TICKET-1281361754%20csi-nfs-controller，asm-controller等频繁重启.md)
- [TICKET-1332781464](../../ticket-documents/cases/TICKET-1332781464%20pod自动重启.md)
- [TICKET-1346709304](../../ticket-documents/cases/TICKET-1346709304%20五一节前巡检，根据巡检报告分析，当前存在哪些问题和隐患，需要处理。.md)

---

## 4. 现象：客户想定制告警 summary / 通知内容

### 更像卡在哪一层
优先怀疑：**通知模板层**，不是监控采集层。

### 最小验证动作

1. 先确认告警本身是否正常触发
2. 确认通知模板是否支持取目标字段
3. 明确客户是想带出对象名、指标、阈值还是当前值
4. 在模板中验证字段渲染是否符合预期

### 常见根因

- 模板字段没取对
- 客户期望的是“自由拼装 summary”，但当前模板未覆盖
- 告警字段本身存在但未正确透传到通知内容

### 代表案例

- [TICKET-1313412894](../../ticket-documents/cases/TICKET-1313412894%20告警描述summary应该可以灵活的使用模板渲染出告警对象和告警指标记忆告警阈值.md)

---

## 5. 现象：实时日志输出卡住 / 超长日志后续不再刷新

### 更像卡在哪一层
优先怀疑：**前端展示层** 与 **日志流式输出链路**。

### 最小验证动作

1. 先确认 `kubectl logs -f` 是否还能正常持续输出
2. 如果命令行正常，再看平台 UI 是否卡在超长单行日志
3. 区分是后端采集问题，还是前端渲染/分页问题
4. 确认是否存在单行超长日志触发 UI 性能问题

### 常见根因

- 后端日志流正常，但前端 UI 渲染异常
- 单条日志过长导致展示侧卡住
- 客户把 UI 表现问题误判成采集链路问题

### 代表案例

- [TICKET-1297933294](../../ticket-documents/cases/TICKET-1297933294%20实时日志输出问题.md)

---

## 6. 现象：日志 Kafka backlog / 消费滞后

### 更像卡在哪一层
优先怀疑：**日志写入与消费链路**，不要只看查询页面或 ES 当前资源。

### 最小验证动作

1. 先确认日志组件是否整体 Running，是否有重启 / OOM / 磁盘只读。
2. 看 Kafka topic 与 consumer group lag 的趋势，是持续增长还是正在追平。
3. 同时看 `lanaya` / `razor` / ES 写入侧报错，判断是消费并发不足、下游写入慢，还是异常消息卡住。
4. 同窗记录 Kafka 生产速率、消费速率、lanaya 副本/分区分配、ES write queue/rejection、磁盘水位，避免只看 ES CPU 或单点 lag。
5. 如果调整 partition、消费者副本或 ES 容量，必须观察 backlog slope 是否下降，不能只看单点值。
6. 估算追平窗口：`current_lag / (consume_rate - produce_rate)`；若消费速率仍低于生产速率，扩容/删索引只是止血。

### 常见根因

- topic partition 数限制消费并发。
- lanaya/razor 消费吞吐低于日志生产速率，历史 backlog 需要追平窗口。
- 下游 ES / ClickHouse / Razor 写入链变慢，反推 Kafka 堆积。
- 单条异常消息、超大日志或格式问题卡住消费者。
- 存储容量 / 磁盘性能 / 网络路径先打坏日志链。

### 代表案例

- [TICKET-1341251114](../../ticket-documents/cases/TICKET-1341251114%20生产日志集群kafka消息滞后.md)：日志组件 Running、ES 资源不算高时，仍需看 Kafka partition 与 consumer group lag；本单将 log topic partition 从 30 扩到 60 后观察到堆积逐步下降。
- [TICKET-1350997834](../../ticket-documents/cases/TICKET-1350997834%20global集群es节点cpu飙升.md)：global ES CPU 高、日志停更与 Kafka lag 同现时，按生产/消费速率、lanaya 吞吐、ES 写入队列和历史 backlog 追平窗口联查，不把 ES CPU 高单点冻结为根因。


## 6.1 现象：告警邮件是否已发送 / SMTP 侧没有收到

### 更像卡在哪一层

优先按 **规则触发 → 通知策略匹配 → courier-api 投递 → SMTP 对端接收** 四层拆分。courier-api 是平台侧确认“是否向 SMTP 发起投递”的最小观测点。

### 最小验证动作

1. 对齐告警 firing 时间、通知策略、接收人和邮件渠道。
2. 查看 `courier-api` 对应时间窗口日志，确认是否产生 SMTP 发送记录。
3. `courier-api` 无记录时，回查通知策略匹配与联系人配置。
4. `courier-api` 有失败记录时，再按 SMTP 地址、TLS、认证、网络与对端拒收分层。
5. SMTP 服务器侧日志要与 `courier-api` 时间窗口交叉验证。

### 易误判点

- Alertmanager 有 firing 不等于邮件已投递。
- SMTP 侧没收到不等于平台没发送，可能是认证/TLS/对端策略拒收。
- 只查 Alertmanager 或只问 SMTP 服务器，都会缺平台投递层证据。

### 代表案例

- [TICKET-1351508304](../../ticket-documents/cases/TICKET-1351508304%20环境内配置了邮件服务器，需要确认下是哪个组件将告警邮件发送到邮件服务器.md)：告警邮件发送组件与投递日志以 `courier-api` 为最小观测点。


### 6.1.1 邮件通知网络与配置前置补充（2026-06-23）

当客户问“配置邮件通知需要放通哪些节点/端口”时，先把它当成通知链路前置条件，不要直接进入告警规则排障。

- 网络放通：样本口径是 **global 集群全部节点** 到 SMTP/邮箱服务器 IP 与端口放通；原因是通知相关 Pod 可能随调度漂移，不宜只放通单个当前节点。
- 邮箱端口：SMTP 服务器地址、端口、TLS/SSL/STARTTLS、应用专用密码等以客户邮箱服务商官方配置为准；QQ/企业邮箱/自建 SMTP 不应套同一端口。
- 配置顺序：先配置通知服务器并测试，再给用户/通知策略配置邮件渠道；告警 firing 后再按 courier-api 投递日志验证。
- 收不到邮件：先查通知服务器配置、告警历史发送详情、courier-api 日志和 SMTP 对端日志；不要只重启 Alertmanager。

关联工单：

- TICKET-1318012254：平台配置邮件通知，需要放通 global 节点访问邮箱服务器。
- TICKET-1292314524：通知组件 Pod 可能漂移，建议放通 global 集群全部节点到通知服务器 IP:端口。
- TICKET-1331559324：QQ 邮箱等端口需查邮箱官网；global 全部节点需可访问 SMTP 地址和端口。
- TICKET-1288101244：配置邮件通知后未收到，先核对通知服务器配置和告警历史发送详情。
- TICKET-1294551014：升级后邮件发送失败伴随 TLS handshake failure，需要按 courier/alertmanager/SMTP TLS 分层补证。
- TICKET-1310167404：告警策略与邮件通知需先配置通知服务器，再给对应用户配置邮件。

Deep-case 信号：

- 当前判断：不需要。
- 原因：邮件通知多数是网络放通、SMTP 参数、联系人/通知策略和 courier-api 投递链路 FAQ。
- 还缺什么证据：若配置正确仍失败，需要告警 firing 时间、通知策略匹配、courier-api 日志、SMTP 对端日志、TLS 握手错误、网络连通性测试和 Pod 调度节点。

## 6.2 现象：Pod 监控图表显示异常 / 纵坐标异常

### 更像卡在哪一层

不要先按前端展示 bug 处理；优先拆 **展示异常 → VM 查询链 → vmstorage/vmselect 运行态 → /cpaas 或监控存储容量**。

### 最小验证动作

1. 确认异常是单个 Pod、单页图表还是整套监控查询异常。
2. 查询 `/cpaas`、监控 PVC/hostPath 的当前与历史容量水位。
3. 查看 `vmstorage` / `vmselect` / `vminsert` 事件、日志、重启原因和资源限制。
4. 若历史满盘或进程被 kill，重启/扩容恢复后仍要评估容量与保留策略。
5. 对比同一指标在 UI、VM direct query 与 Grafana/API 的表现。

### 代表案例

- [TICKET-1350393454](../../ticket-documents/cases/TICKET-1350393454%20pod监控图表纵坐标显示有问题.md)：Pod 监控图表异常最终与 `/cpaas` 满盘、`vmstorage` 进程被关闭相关，重启 VM cluster 并扩容后恢复。

## 6.3 现象：vmselect 参数调大 / NodeDNS 或 ovn-pinger 指标缺失

### 更像卡在哪一层

优先按 **查询负载风险** 与 **监控采集 DaemonSet 调度覆盖** 两条线拆分。

### 最小验证动作

1. 客户要求给 `vmselect` 增加或调大 `search.maxLabelsAPIDuration` 时，先说明这是查询耗时/负载边界参数，不是无风险功能开关。
2. 调大到较长时间可能带来更多慢查询排队、CPU/内存升高、VM 响应变慢，极端情况下可能 OOM 或拖垮查询集群；调整前要有慢查询样本、查询来源和容量评估。
3. NodeDNS/ovn-pinger 类指标缺失时，先看对应 DaemonSet 是否在目标节点运行；如果 master 节点有不调度业务组件的污点，可能导致 ovn-pinger 未覆盖 master。
4. 需要监控 master 上的 NodeDNS/网络探测时，按产品/现场口径确认是否应给 ovn-pinger 增加 toleration；修改后验证 Pod 调度和指标恢复。
5. 混合咨询工单里要拆题：网关默认超时、etcd 切主、容器磁盘指标无数据、NodeDNS 指标缺失可能不是同一根因。

### 常见误判

- `search.maxLabelsAPIDuration` 调大 ≠ 单纯“提高超时时间”，它可能放大 VM 查询负载。
- 指标无数据 ≠ 一定是 UI 问题；也可能是采集 Pod 没有调度到对应节点。
- master 污点导致采集缺口 ≠ etcd 频繁切主的根因，两者需要分开证据链。

### 关联工单

- TICKET-1352073884：咨询 vmselect 添加 `search.maxLabelsAPIDuration: 20s`，风险在查询变多/变慢、CPU/内存升高、OOM 和 VM 集群响应变慢。
- TICKET-1351873034：混合咨询中 NodeDNS 指标缺失与 ovn-pinger 受 master 污点影响相关，添加容忍后恢复；etcd 切主需另补证据。

### 可链接草稿

- [[observability-vmselect-certificate-rule-oom-quick-card]]
- [[observability-victoriametrics-capacity-triage-quick-card]]
- [[observability-nodedns-metrics-taint-and-mixed-question-faq]]

### Deep-case 信号

- 当前判断：可选。
- 原因：参数风险与 DaemonSet 调度覆盖是可复用 FAQ；只有出现查询集群雪崩或 etcd 切主事故才值得 deep-case。
- 还缺什么证据：vmselect 慢查询、资源曲线、并发来源、OOM 日志；NodeDNS/ovn-pinger 需要 DaemonSet spec、节点 taint、Pod 调度事件和指标恢复前后对比。

## 6.4 现象：巡检提示无日志/Event/Audit、外部 ES/Kafka 版本或本地日志节点规划咨询

### 更像卡在哪一层

优先按 **预警语义 / 外部依赖支持矩阵 / 日志存储节点规划** 拆分，不要把所有巡检红项都当成日志链路故障。

### 最小验证动作

1. 巡检提示某类 `event/log/audit` 15 分钟未发送时，先确认该节点/应用在对应窗口是否确实产生了这类数据；没有数据产生时可能只是静默窗口预警。
2. ServiceMonitor 抓取业务 metrics 超时或需要认证时，先核对 endpoint、认证配置和 ServiceMonitor 字段；不要直接归因监控组件故障。
3. 文件句柄数巡检预警要对比主机 `file-max` 与实际占比；只超过平台阈值不等于已经有安全隐患。
4. 对接外部 ES/Kafka 时，先确认版本是否在支持矩阵内；超出支持范围只能按项目风险尝试，不能作为稳定交付承诺。
5. 外部 Kafka/ES 网络策略至少要覆盖集群网段到外部 Kafka/ES 地址端口；Kafka 还可能需要到 Zookeeper 端口。
6. 日志/Prometheus 使用本地盘时，明确 Pod 固定节点、节点不可调度、故障不漂移和 `/cpaas` 容量规划边界。

### 常见误判

- 巡检无数据预警 ≠ 日志链路一定坏了。
- 请求 metrics 超时 ≠ VM/Prometheus 一定异常，也可能是业务 metrics endpoint 需要认证。
- 外部 ES/Kafka 能连通 ≠ 版本受支持。
- 将日志 ES 节点设为不可调度可以减少业务干扰，但本地盘/固定 Pod 故障不会自动漂移。

### 关联工单

- TICKET-1349890534：巡检中的无 event/log/audit、metrics timeout、文件句柄阈值等需要逐项判断，部分可观察或调阈值。
- TICKET-1348790544：外部 ES/Kafka 版本超出支持范围时只能按风险尝试，对接还需放通集群到 Kafka/ES/Zookeeper 的网络。
- TICKET-1348962884：日志 ES/Prometheus 使用本地存储时，节点专用与不可调度要结合固定 Pod 和故障不漂移边界说明。

### Deep-case 信号

- 当前判断：可选。
- 原因：巡检阈值、外部依赖支持和本地盘节点规划多为 FAQ/方案边界；只有出现持续数据缺失、采集失败或生产故障才需要 deep-case。
- 还缺什么证据：需要巡检规则、采集器日志、ServiceMonitor 配置、外部 ES/Kafka 版本与连通性、节点本地盘容量/Pod 调度事件和故障时间线。

## 6.5 现象：日志归档/告警 Webhook/NodeOOM 告警字段能力边界（2026-06-20）

### 更像卡在哪一层

优先按 **日志存储策略**、**告警通知转发链**、**告警规则语义与标签粒度** 拆分，不要把容量诉求、Webhook 对接和告警勿扰混成一个监控故障。

### 最小验证动作

1. 日志希望“本地保留 7 天，7 天后自动转存 NAS”时，先说明现有归档常见模式是**日志产生时同步一份到外部 NAS/归档路径**，不是本地保存期满后再搬迁。
2. `/cpaas` 日志占用过大时，在“扩容、缩短保留、启用归档/外部存储、清理策略”之间做方案取舍；不要承诺“不清理且无需扩容”的稳定方案。
3. Alertmanager 对接 Webhook 时，先确认是单集群还是集中 VM/代理模式；集中模式下通常改一个接收端即可覆盖多集群代理上报，但要以现场拓扑为准。
4. 客户希望 Webhook 再转发到 Zabbix 时，区分“平台发 Webhook”与“自定义转发服务解析 JSON 后写 Zabbix”两段；后者通常不是内置能力，需要项目/需求评估。
5. NodeOOM/Pod OOM 聚合告警缺少具体 Pod 列表时，先说明内置规则的标签粒度与告警语义；如要区分单 Pod 高频 OOM 与多 Pod 分散 OOM，需要新增/改造规则或功能需求。

### 关联工单

- TICKET-1351986024：ES 日志归档咨询，现有归档是产生新日志时同步到外部 NAS，不是本地 7 天后再转存。
- TICKET-1352466914：日志占用 `/cpaas` 较大，最终在归档手册与扩容之间选择扩容。
- TICKET-1352490794：Alertmanager Webhook 对接，多集群场景可结合集中 VM/代理拓扑减少重复配置。
- TICKET-1351483624：Webhook 到 Zabbix 的 JSON 解析转发服务不属于简单配置多个接收器，需走需求/项目评估。
- TICKET-1352217724：NodeOOM 告警无法直接展示具体异常 Pod，单 Pod 高频 OOM 与多 Pod 分散 OOM 区分属于规则/功能增强诉求。

### Deep-case 信号

- 当前判断：可选。
- 原因：当前样本主要是日志保留策略、通知集成边界和内置告警标签粒度说明，可复用为 FAQ。
- 还缺什么证据：若要 deep-case，需要日志组件拓扑、ES/归档配置、容量增长曲线、Alertmanager 配置与消息样例、Zabbix 接口要求、OOM 指标查询和告警规则 YAML。

## 6.6 现象：告警规则 API、Kibana 部署、运行时长与 Envoy Gateway 看板咨询

### 更像卡在哪一层

优先按 **API 使用入口 / 组件部署文档 / 指标口径 / Dashboard 模板** 拆分。这类工单通常不是监控链路故障，而是“应该用哪个受支持入口、有没有内置统计口径、面板指标怎么补”的 FAQ。

### 最小验证动作

1. 使用接口创建告警规则时，确认调用的是正式 API 文档接口或 Kubernetes/PrometheusRule 资源路径，不要复用浏览器页面请求 endpoint 当稳定 API。
2. 若 `apply` 成功但 `kubectl get prometheusrule` 未见对象，核对资源 namespace、CRD 类型、API 版本、返回 JSON 是否只是前端页面数据而非创建结果。
3. Kibana 部署咨询先按当前 ACP/日志组件/ES 版本匹配文档处理，不要跨版本套用旧方案。
4. “平台稳定运行多久”当前只能按 global/集群创建时间、组件 uptime、事件/告警历史近似判断；没有内置“全年无故障累计时长”统计时要明确边界。
5. Envoy Gateway Dashboard 若缺 4xx/5xx 等指标，先核对已有 dashboard JSON、网关日志/metrics 暴露项和指标标签，再决定是导入面板、补 PromQL，还是走告警规则定制。

### 常见误判

- 页面请求成功 ≠ 对外 API 创建成功。
- Kibana 能否部署 ≠ 所有版本都使用同一部署清单。
- 创建时间 ≠ 无故障运行时长；后者需要告警、事件、SLO 或审计口径支撑。
- Dashboard 没有现成图 ≠ 数据链路坏了，可能只是面板模板未覆盖。

### 关联工单

- TICKET-1349603594：开始使用页面显示接口创建告警规则失败，后改用 API 文档接口解决。
- TICKET-1349808944：新建集群 Kibana 部署需参考对应版本文档。
- TICKET-1350049044：平台运行时间可从 global 创建时间估算，暂无故障/异常累计时长统计。
- TICKET-1349166614：Envoy Gateway Dashboard 与 4xx/5xx 指标属于面板/指标使用咨询。

### Deep-case 信号

- 当前判断：可选。
- 原因：当前是接口入口、部署文档和指标口径 FAQ；只有正式 API 创建失败、Kibana 部署失败或指标链路缺失可复现时才需要 deep-case。
- 还缺什么证据：API 请求/响应、资源 YAML、PrometheusRule/VMRule 对象、Kibana 版本与部署日志、global 创建时间来源、dashboard JSON、metrics endpoint 与 PromQL 查询结果。

## 6.7 现象：node-exporter 端口冲突、外部 Prometheus 对接与概览探测指标误读（2026-06-22）

### 适用场景

- Prometheus 插件部署失败，`node-exporter` 报 9100 端口被占用；
- 客户要求对接外部 Prometheus，希望平台指标远程写出；
- 平台概览同一集群出现两组监控数据，一组正常一组异常；
- 应用网络监控图表报文发送/接收速率周期性降为 0，但持续流量未中断。

### 排查路径

1. `node-exporter` 起不来时先查节点 9100 端口占用，区分平台插件端口冲突和客户侧主机监控进程占用。
2. 若确认客户侧进程占用 9100，可协调让出端口，或按插件支持方式调整 node-exporter 端口后重新部署。
3. ClickHouse / CK operator 包缺失时，不要和 Prometheus 端口冲突混为一因；需回到软件包/Operator 同步状态。
4. 外部 Prometheus 对接优先按 remote_write / 远程写入方案处理，确认写出方向、认证、网络和指标范围。
5. 概览里 `platform.cluster.prometheus.down` 一类探测指标异常，表示监控链路探测失败或 curl 不通，不等同于 CPU/内存资源监控本身有两份冲突数据。
6. 网络报文速率周期性为 0 时，用持续流量压测和原始 PromQL 对照；`irate()` 计算窗口可能导致瞬时 0，不一定代表业务流量中断。

### 风险边界

- 调整 node-exporter 端口会影响采集配置、ServiceMonitor/VMServiceScrape 和告警规则，需同步验证。
- remote_write 会增加外部链路依赖和指标外发范围，需确认安全与容量边界。
- UI 概览或 `irate()` 展示异常不能直接写成监控链路故障；需用原始查询和真实流量佐证。

### 关联工单

- TICKET-1353980934：Prometheus 插件部署失败，node-exporter 9100 被客户侧主机监控进程占用，调整端口后部署成功；CK operator 包另需同步。
- TICKET-1354064644：对接外部 Prometheus 需求，现场提供远程写入方案。
- TICKET-1354224894：平台概览同一集群两组监控信息，一组为资源监控，一组为 Prometheus 探测指标。
- TICKET-1353513754：应用网络监控报文速率周期性为 0，持续 5MiB/s 下载验证流量未中断，更像 PromQL `irate()` 计算特性。

### Deep-case 信号

- 当前判断：可选。
- 原因：端口冲突、remote_write、探测指标语义和 PromQL 展示多为配置/解释型 FAQ。
- 还缺什么证据：若要 deep-case，需要端口占用进程、插件配置 diff、remote_write 配置、vmagent 日志、原始 PromQL、页面查询请求、持续流量测试数据和告警规则。

## 7. 支持现场优先问这 6 个问题

1. 这是采集问题、存储查询问题，还是展示/通知问题？
2. 影响的是单个组件、单条规则，还是整条可观测链路？
3. 现场有没有真实业务影响，还是只有告警/巡检信号？
4. 如果是日志问题，`kubectl logs` / 后端查询是否正常？
5. 如果是告警问题，异常在触发、模板，还是通知派发？
6. 节点时间、token、认证链路有没有明显异常？

---

## 8. 常见误判速查

- **有告警 ≠ 一定有业务故障**
- **巡检报告有风险 ≠ 每项都必须立即处理**
- **apiserver 日志报错 ≠ 一定已经功能受损**
- **日志界面卡住 ≠ 日志采集一定坏了**
- **告警 summary 不理想 ≠ 监控能力缺失，很多时候只是模板问题**

---

## 9. 从这类问题里最值得继续沉淀什么

优先建议继续沉淀：

- 巡检报告分级处置模板
- 告警模板字段速查表
- 日志实时输出 / UI 展示异常最小分诊路径
- apiserver / nevermore / token 类异常的标准确认口径

## 9.1 现象：日志部署缺 Secret、`kubectl top node` 无 metrics、VMUI 不可访问

### 更像卡在哪一层

优先按 **插件前置 / 控制器调谐 / adapter 规则与重启 / 已知缺陷确认** 拆分，不要把它们都归成“监控组件坏了”。

### 最小验证动作

1. 日志组件部署报 `secret "log-collector-bearer-auth" not found` 时，先确认 Log Essentials 插件是否已安装，再查 `log-center-secret` 等前置 Secret 是否存在；若前置存在但对象未生成，可重启 `cluster-transformer` 触发调谐恢复。
2. `kubectl top node` 无法获取 metrics 时，先核对是否命中已知 adapter 表达式问题；修改 `cpaas-monitor-prometheus-adapter` ConfigMap 后，需要重启 adapter，不能只改 CM 后等待页面自动恢复。
3. ACP 4.3.1 VMUI 无法访问且已确认缺陷单时，按版本/Jira/修复版本跟踪，不要在现场反复重启 VM 组件来替代缺陷确认。
4. 处理完恢复动作后，保留最小证据：缺失对象、插件状态、ConfigMap diff、adapter/cluster-transformer 重启前后日志与页面/API 验证。

### 关联工单

- TICKET-1353314714：日志部署报 `log-collector-bearer-auth` 缺失，确认 Log Essentials 前置与 `log-center-secret` 后，重启 `cluster-transformer` 恢复。
- TICKET-1353414504：`kubectl top node` 无 metrics，按 AIT-70648 调整 adapter 表达式后需重启 adapter。详见 [[observability-log-display-and-metrics-adapter-faq]]。
- TICKET-1353511064：页面实时日志中文乱码但 `kubectl logs` 与平台日志查询正常，优先按实时日志展示/UTF-8 分片边界处理，详见 [[observability-log-display-and-metrics-adapter-faq]]。
- TICKET-1352992384：ACP 4.3.1 VMUI 无法访问，已提交缺陷跟踪。

### Deep-case 信号

- 当前判断：可选。
- 原因：Secret 缺失、adapter 重启生效、VMUI 已知缺陷属于可复用短链路处理。
- 还缺什么证据：若要 deep-case，需要插件安装/升级时间线、缺失 Secret 的 owner/reconcile 链、adapter 配置 diff 与查询错误、VMUI 前端/后端日志、缺陷版本与修复验证。
## 10. Sentry 资源不足导致后台调谐链卡住（2026-06-11）

### 适用现象

- 监控/平台组件卸载卡在 deleting 或页面长期无进展；
- RPCH 长时间 `pending`，同时 sentry / sentry-service / cluster-transformer 异常；
- sentry Pod 有 `OOMKilled`、反复重启或资源 limit 明显不足。

### 最小判断链

1. 先确认卡住对象：`minfo`、RPCH、插件状态，还是页面状态展示。
2. 同时检查 sentry 运行态、资源水位、previous log 与重启次数。
3. 如果 sentry OOM 成立，先恢复 sentry 资源与调谐链，再重试卸载/部署/RPCH 收敛。
4. 只有确认控制器无法自动释放且下游依赖已安全处理时，才考虑 finalizer/对象清理。

### 代表案例

- [[TICKET-1329450214 卸载组件卡着]]：Prometheus `minfo` finalizer 卡住叠加 sentry OOM，不能只删 finalizer。
- [[TICKET-1329215374 sentry报错oom，修改资源的时候，rpch处于pending]]：RPCH pending 是 sentry OOM 打断调谐链的表象。

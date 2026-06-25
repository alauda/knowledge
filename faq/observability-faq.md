---
title: ACP Observability FAQ
type: faq
status: active
domain: observability
product: acp
tags: [acp, observability, faq, tracing, monitoring]
updated: 2026-05-12
source: [official-docs, experience]
related:
  - ../notes/observability.md
  - ../../../knowledge_base/troubleshooting/trace-missing-runbook.md
  - ../../../ticket-documents/TICKET-0000-template/README.md
---

# ACP Observability FAQ

## 日志 / 审计 / 事件导出

### 平台支持导出事件吗？
先把对象分清，不要把“事件”与“日志 / 审计”混成一类。

当前稳定口径是：
- **支持日志导出**
- **支持审计导出**
- **暂不支持事件导出**

所以如果客户问“如何导出事件日志”，不要先默认和日志导出走同一条路径，更不要因为日志/审计可导就推断事件也能导。

更稳的答法是：
- 先明确当前**事件导出不支持**
- 如果客户真实诉求是排查或留痕，再引导改查日志或审计作为替代信息源

关联案例：
- [TICKET-1349575034](../../../ticket-documents/cases/TICKET-1349575034%20如何导出事件日志.md)

### 平台内置告警规则能直接修改吗？
更稳口径是：**不能直接修改内置规则**。

如果客户需要改阈值、表达式或通知策略，不要先帮他找“编辑内置规则”的入口，优先建议：
- 复制内置规则表达式
- 新建一条自定义告警规则
- 将原内置规则静默

模板变量和自定义字段也不要泛答成“想加什么都行”，应按当前文档能力边界说明。

关联案例：
- [TICKET-1348648104](../../../ticket-documents/cases/TICKET-1348648104%20平台的内置告警规则怎么调整？.md)

### 日志 ES 配了存储容量，为什么实际还能继续把盘打满？
不要先把它理解成“ES 没遵守配额”或“平台限额失效”。

更稳口径是：
- 如果日志 ES 底层用的是 `localpath` / 静态 `no-provisioner` PV
- 那么 PV/PVC 上写的 `storage: 200Gi` 这类容量字段，主要只在 **调度与绑定匹配层** 生效
- **不会自动提供文件系统级 hard quota**

这意味着：
- 写了 200G，不等于进程就一定只能写 200G
- 真正风险控制仍要靠 retention、单日写入量评估、分片分布与底层存储规划
- 即使用 NAS，也不等于自动获得“写满就拦住”的能力，还要额外关注写入性能

更稳的现场动作通常是：
- 先止血恢复 ES
- 调整日志保留天数
- 核算单日索引大小 × 保留天数 × 冗余系数
- 再决定是否扩容或切换存储方案

关联案例：
- [TICKET-1342302954](../../../ticket-documents/cases/TICKET-1342302954%20配了日志数据存储空间配额是200G，但实际超出.md)

### 告警通知里的 summary 能带出 Pod、节点、阈值、当前值这些信息吗？
可以，但不要先把这类需求理解成“告警链路缺字段”或“需要改采集器”。

更稳口径是：
- 这类需求优先落在**通知模板渲染**
- 需要的对象、指标、阈值、当前值等信息，要在模板里显式取字段并拼到 `summary`
- 所以现场先确认模板上下文里有哪些 labels / externalLabels 可用，再决定怎么拼内容

也就是说，用户想让 summary 带出 Pod 名、节点名、指标名、当前值、阈值时，优先动作不是改规则表达式本身，而是改通知模板。

关联案例：
- [TICKET-1313412894](../../../ticket-documents/cases/TICKET-1313412894%20告警描述summary应该可以灵活的使用模板渲染出告警对象和告警指标记忆告警阈值.md)

### 告警能触发，但 Webhook 推不出去，先看什么？
不要先默认是“网络不通”或“接收端挂了”。

更稳的排查顺序是先拆成两层：

1. **告警策略到底有没有绑到正确的通知策略**
2. **即使请求发出去了，对端是否真的能接受这个报文格式**

先看第一层：
- 如果当前告警策略引用的通知策略对象不存在，或者实际绑定错了
- 那么测试告警虽然会触发，但不会按预期命中对应 Webhook
- 这类场景先核对通知策略名称、对象是否存在，以及是否用了约定名（例如现场已有过 `cpaas-admin-notification` 这类案例）

再看第二层：
- 即使平台侧提示“发送成功”，也只代表**请求发出去了**
- 不代表接收端一定按预期消费
- 如果接的是企业微信机器人或其封装地址，这类接口通常要求明确的 `msgtype` 和消息体结构
- 平台通用 JSON 报文不一定直接兼容，对端常见报错就是 `不合法的 msgtype 参数`

所以更稳口径是：
- **先核对通知策略绑定是否正确**
- **再核对接收端协议/格式是否兼容**
- 不要一上来就把问题全压成网络层

关联案例：
- [TICKET-1339754354](../../../ticket-documents/cases/TICKET-1339754354%20关于告警通知配置webhook推送告警问题.md)
- [TICKET-1330628504](../../../ticket-documents/cases/TICKET-1330628504%20通过企业微信机器人发送告警信息.md)
- [TICKET-1343408574](../../../ticket-documents/cases/TICKET-1343408574%20配置了告警通知渠道，收不到告警消息.md)

### 健康检查失败事件明明发生了，为什么对应告警指标一直是 0？
不要先怪规则写错、保留期太短，或者直接理解成“现场其实没发生事件”。

更稳口径是：
- 这类告警依赖平台对 `unhealthy` 事件的计数逻辑
- 已有样本说明，`auth-controller` 会缓存 **2 小时内** 的同类事件
- 如果新事件命中缓存，`count` 会递增，告警能正常触发
- 但如果超过 2 小时，旧缓存已被清掉，而新的 watch 事件又因为 `FirstTimestamp` 太早，不满足“距离当前时间小于 1 分钟才更新 count”的条件
- 那么该事件就可能被直接丢掉，外层看起来就会变成：**明明有 unhealthy 事件，但告警指标始终为 0**

所以更稳的判断顺序是：
1. 先确认用户配置的是不是健康检查失败事件类告警
2. 再确认现场是否真实发生过对应 unhealthy 事件
3. 如果事件存在、规则也基本合理，但指标仍长期为 0，就不要继续让用户反复改规则，优先怀疑是否命中了这类已知产品缺陷

更稳结论是：
- 这不一定是规则问题
- 也不一定是监控保留期问题
- 很可能是 **事件缓存窗口与时间判定逻辑** 把事件丢了

关联案例：
- [TICKET-1295117564](../../../ticket-documents/cases/TICKET-1295117564%20监控数据异常.md)

### 节点都 NotReady 了，为什么对应节点健康告警没有立刻触发？
不要先默认是告警延迟、恢复后补发，或者通知链路堵住了。

更稳口径是：
- 很多“节点健康 / 节点不可用”类告警，底层并不是直接看 Kubernetes 节点状态 `NotReady`
- 而是看 Prometheus 能不能从对应节点上的 `node-exporter` 抓到数据
- 所以如果故障打坏的是 **VIP / F5 / 外部访问链**，但集群内网络还通、Prometheus 仍能抓到 `node-exporter`
- 那么现场就会出现一种很反直觉的现象：
  - 节点状态已经异常
  - 但节点健康告警并没有按用户预期立刻触发

更稳的判断顺序是：
1. 先确认当前规则到底按什么指标判定
2. 再确认故障发生时，Prometheus 对 `node-exporter` 的抓取有没有真的断
3. 如果 exporter 抓取没断，就不要把“节点 NotReady 但没告警”直接定性成告警系统失效

这类场景更像：
- **规则表达式与用户理解的“节点异常”语义不一致**
- 不是简单一句“告警延迟”就能解释完

关联案例：
- [TICKET-1321673744](../../../ticket-documents/cases/TICKET-1321673744%20今天收到大量告警发出后，又立即恢复的问题.md)

### 主机网络丢失了，为什么没有收到节点健康告警？
不要先把问题归因成“钉钉通知没发出去”或“Prometheus 坏了”。

更稳口径是：
- 很多节点健康类告警，底层并不是直接看“用户是否感知到网络异常”
- 而是看 Prometheus 对该节点 `node-exporter` 的抓取是否真实失败
- 如果故障窗口里 `9100` 抓取并没有断，即使现场觉得“网络已经丢了”，节点健康告警也可能不会命中

所以现场先别急着追通知链路，优先按这个顺序确认：
1. 当前节点健康规则到底依赖什么指标
2. 故障窗口里 `node-exporter` 的抓取是否真的失败
3. Prometheus 日志里是否有对 `9100` 抓取失败的直接证据
4. 把 `11250` 未认证、DaemonSet 副本异常、节点状态异常这些旁证和主判据分开看

更稳结论通常是：
- **规则没有命中，不等于通知系统故障**
- 这类问题常常是“规则语义”和用户理解的“主机网络异常”不是一回事

关联案例：
- [TICKET-1264528674](../../../ticket-documents/cases/TICKET-1264528674%20主机网络丢失未报警.md)
- [TICKET-1321673744](../../../ticket-documents/cases/TICKET-1321673744%20今天收到大量告警发出后，又立即恢复的问题.md)

### 对一个集群做告警静默后，页面显示其他集群也被静默了，是不是规则串了？
不要先把它定性成“多集群共享监控后端导致规则串写”。

当前更稳口径是：
- 在多集群共享远程存储 / VMCluster 的场景下
- 告警静默页面可能出现**跨集群作用范围显示异常**
- 页面上看起来像“其他集群也被静默”，但实际对应告警规则**并没有真的被修改或静默**

所以现场不要只看 UI，要继续确认：
- 其他集群对应规则是否真的进入静默
- 其他集群告警是否仍可实际触发

如果只是显示异常：
- 对外先解释成前端展示问题
- 如果其他集群也需要静默，仍要分别更新各自规则

关联案例：
- [TICKET-1266110374](../../../ticket-documents/cases/TICKET-1266110374%20对某个k8s集群的告警策略进行告警静默配置，其他集群也被静默---NC0020.md)

### 告警历史里为什么最新还在告警的记录不一定排在最前面？
不要先把它当成前端偶发排序错乱。

当前更稳的口径是：
- 告警历史列表按 **首次触发时间（start at）** 排序
- 不是按“最近一次变化时间”或“最近一次仍在告警的时间”排序

这会带来一个很常见的现场困惑：
- 某条告警如果持续很久都没恢复
- 它会长期占住前排位置
- 后面新产生的活跃告警，可能反而被挤到更后面

所以如果用户说“最新的告警不在第一行”，不要先按误操作处理；先确认是不是命中了这个展示边界。

如果现场诉求是快速定位“当前具体哪条在告警”，那这更像产品展示能力问题，而不只是解释排序规则就结束。

关联案例：
- [TICKET-1269691084](../../../ticket-documents/cases/TICKET-1269691084%20告警策略-告警历史，最新的告警没有显示在最前一行-NC0020.md)

### apiserver 内存突然涨很高时，先看什么？
不要先把问题定成 `kube-apiserver` 内存泄漏。

更稳的排查起点是先确认：
- 是否存在 webhook / 同步类请求异常增多
- 审计量是否同步放大
- etcd 中是否有某类对象数量异常膨胀

尤其当现场已经看到：
- `apiserver` 请求量高
- webhook 压力大
- `CertificateRequest` 之类 CR 暴涨

更稳核心通常不是组件自己“慢慢泄漏”，而是**控制面对象风暴把 `etcd -> apiserver` 调用成本抬高了**。

处理顺序建议是：
1. 先找出持续生成对象的来源并止血
2. 再判断是否需要清理历史对象
3. 最后再观察 `apiserver` 内存是否真正回落

关联案例：
- [TICKET-1303987354](../../../ticket-documents/cases/TICKET-1303987354%20apiserver%20pod内存使用量达到20G.md)

### 实时告警里点击集群名称报“缺少翻译文件”时，先看哪里？
这类现象不要先怪告警数据或监控组件。

更稳核心是：
- new web console 只是往旧页面插了跳转入口
- 旧页面对应插件没有补齐中文翻译资源
- 所以点击后会直接报缺少 `plugin_console-core-service.json`

如果现场暂时不依赖 new web console，可优先考虑先绕开相关插件，而不是继续在告警规则或数据链路上打转。

关联案例：
- [TICKET-1348995944](../../../ticket-documents/cases/TICKET-1348995944%204.3版本-实时告警中文翻译问题.md)

### Pod CPU 使用率不显示，先看 request/limit 还是监控链路？
不要先只盯 `request/limit`。

更稳口径是：
- 如果所有 Pod 都没有 CPU 数据，先怀疑采集或展示链路
- 但如果只是**部分 Pod 没有 CPU 图**，而且这些 Pod 明显集中在少数节点上
- 要优先核对这些节点的时间是否与集群其他节点有明显偏差

因为很多 CPU 指标查询依赖近 5 分钟窗口：
- 节点时间一旦偏移超过这个窗口
- 即使采集本身还在跑
- 查询结果也会被直接取空

更稳的排查顺序是：
1. 先区分是全局无数据，还是只影响部分 Pod
2. 如果只影响部分 Pod，再看它们是否集中在同一批节点
3. 若集中在特定节点，优先核对节点时间同步状态
4. 时间同步后若页面仍不恢复，再继续检查 `apollo` 这类展示/聚合链是否卡住

关联案例：
- [TICKET-1318386664](../../../ticket-documents/cases/TICKET-1318386664%20cpu使用率不显示.md)

### `vmselect-cluster` 资源高、直接改 StatefulSet 不生效，应该怎么调？
不要先把它理解成“页面改资源失败”或“STS 保存有 bug”。

更稳口径是：
- `vmselect-cluster` 这类 VictoriaMetrics 组件通常是**托管组件**
- 托管组件的资源规格应通过 **VictoriaMetrics 插件 / 托管入口** 修改
- 直接改 StatefulSet 或运行态页面，后续很可能被调谐链回写覆盖

所以如果现场已经出现：
- Pod 资源高、频繁重启
- 直接改 STS 后不生效或又被改回去

更稳动作不是继续热改运行态，而是：
- 转到 `VictoriaMetrics` 的声明层入口调整规格
- 再观察组件是否恢复

关联案例：
- [TICKET-1320294054](../../../ticket-documents/cases/TICKET-1320294054%20pod重启（vmselect-cluster）.md)

### 监控要迁到新节点，能不能直接复制数据目录或改成 PVC 保证不丢数据？
不要先给“应该可以”的承诺。

更稳口径是：
- 当前如果没有经过验证的产品级监控数据迁移方案
- 那么“复制监控目录”“改用存储卷”都只能算**理论思路**
- 不能直接作为正式支持方案对外承诺

也就是说：
- 理论可行 ≠ 产品已验证
- 能在测试环境尝试 ≠ 可以当成生产标准方案

更稳的支持动作是：
1. 明确当前是否存在官方验证过的迁移方案
2. 如果没有，就直接说明这是支持边界
3. 建议先在测试环境自验证
4. 若客户强依赖该能力，再转产研评估是否补产品能力

关联案例：
- [TICKET-1319055004](../../../ticket-documents/cases/TICKET-1319055004%20集群监控需要换个节点重新部署，有没有方案保障数据不丢失。.md)

## Tracing / Trace Logs

### 为什么“刚产生的 trace 查不到”？
先分两类判断：**没采到**，还是**已写入但暂时查不到**。

常见原因：
1. sampling rate 太低
2. Elasticsearch `refresh_interval` 导致写入后暂时不可搜索

补充判断：
- 这类问题不一定是 trace 没采到，也可能只是 **还没变成 searchable**
- 文档里给的默认值是 Elasticsearch 索引 `refresh_interval = 10s`

可调抓手：
- 调高采样率，或使用更丰富的采样方式（如 tail sampling）
- 调 `jaeger-collector` 启动参数：`--es.asm.index-refresh-interval`

注意：
- 如果把这个参数设成 `"null"`，就不会给索引配置 `refresh_interval`
- 但这样会影响 Elasticsearch 性能与查询速度

### 为什么 trace 不完整？
高频根因有两个：
1. 数据刚写入，存在短暂可见性延迟
2. trace 超出 `jaeger-query` 默认查询窗口

更具体地说：
- `jaeger-query` 默认会围绕目标 span 的起始时间，向前和向后各扩 `1` 小时查询
- 如果一条 trace 跨时很长，可能通过某个 span 进去时只能看到局部，表现为“断链”

处理方式：
- 先等一会儿再刷新，排除 Elasticsearch 写入可见性延迟
- 若环境里确实存在超长 trace，可调 `jaeger-query` 参数：`--es.asm.span-trace-query-time-adjustment-hours`

### OTLP 已经打进 collector 了，但 trace 还是缺 span / 看起来断链，先怎么排？
按最短路径排，不要一上来就怀疑 UI：

1. **先确认应用侧真的持续发 span**
   - Java 自动注入场景，先看新 Pod 里有没有 `opentelemetry-auto-instrumentation-java` init container
   - 非 Java 场景，先回应用侧确认是否真的在按 OTel SDK / instrumentation 发 OTLP，而不是只打通了 endpoint
2. **确认平台链路是否通到 Jaeger**
   - 平台默认链路是：`应用 -> otel-collector(4317/4318) -> jaeger-prod-collector-headless:4317 -> Elasticsearch`
   - 所以“OTLP 通”只代表进了 collector，不代表后面一定已成功写入 Jaeger / ES
3. **如果是“刚发生的调用”先等 Elasticsearch 可见性**
   - 默认 `refresh_interval` 会带来短暂不可搜索窗口
4. **如果是超长链路，再查 query 窗口**
   - `jaeger-query` 默认只围绕目标 span 前后各扩 `1h`
   - 长事务、异步跨很久的链路，常见表现就是“trace 查得到，但少一段”
5. **最后再看是不是采样策略导致**
   - 平台默认 Java Instrumentation 近似全采样：`parentbased_traceidratio` + `argument: "1"`
   - 如果业务自己改过 sampler，缺 span 就要把采样一起纳入排查

一句话判断：**collector 收到 OTLP ≠ Jaeger 一定能查全；缺 span 通常要沿着 collector → jaeger → ES 可见性 → query 窗口 这条线继续排。**

### 超长 trace 怎么调？
调整 `jaeger-query` 参数：`--es.asm.span-trace-query-time-adjustment-hours`。

默认值是 `1` 小时；如果环境里确实存在超长 trace，可以按需调大。

### Query Tracing 页面结果太多、太杂，怎么缩小范围？
优先用**组合条件**，不要只堆时间范围。

高频条件包括：
- `TraceID`
- `Service`
- `Label`
- `Span Duration Greater Than`
- `Only Search Error Spans`
- `Span Type`
- `Maximum Query Count`

两个容易忽略的点：
- `Span Type` 里，`Root Span` 更适合从调用发起方查整条链路；`Service Entry Span` 更适合从某服务被调用入口查
- 平台最多显示 `1000` 个 span，默认最大查询数是 `200`；如果结果过多，要缩时间窗或补条件

### 查 trace 时，Label 有什么实际用法？
`Label` 对应 span 的 tag，可用来做二次精确过滤。

一个很实用的用法是：
- 先点开目标 span
- 找到可疑 tag
- 直接点 tag 旁的按钮，把它加入 Query Conditions

这样通常比手敲条件更快，也更不容易写错。

### Trace Logs 里勾选 `Contain Trace ID` 还是查不到，通常缺什么？
通常缺的是**应用侧日志埋点**，不是平台查询能力本身。

前提要求：
- 业务日志里必须已经写入 TraceID
- 然后 Trace Logs 页面里的 `Contain Trace ID` 过滤才有意义

补充：
- Java：通常走 MDC / logging pattern
- Python：可从 `x-b3-traceid` 取值后写入日志
- Python 示例里通常会一起透传 `x-request-id`、`x-b3-spanid`、`x-b3-parentspanid`、`x-b3-sampled`、`x-b3-flags`，方便后续日志与采样决策对齐

### 怎么验证“日志里真的带了 TraceID”？
可以按最短路径验证：
1. 先在 Tracing 页面按 `TraceID` 查到目标链路
2. 进入 **View Log**
3. 勾选 **Contain Trace ID**
4. 看是否还能查到对应业务日志

如果这里一勾选就没数据，通常要先回应用日志格式，而不是先怀疑平台查询。

再补一个判断：
- 平台不会替你“补出”业务日志里的 TraceID
- `Contain Trace ID` 只是过滤已有日志字段
- 所以没结果时，优先排应用日志是否真的把 TraceID 打出来

### trace 查得到，但点 `View Log` 联不到日志，先查哪 3 件事？
1. **业务日志里是否真的写入了 TraceID**
   - 这是第一前提；没写入的话，Tracing 页面也没法帮你自动补日志关联
2. **Trace Logs 里是否误勾了 `Contain Trace ID`**
   - 勾选后只显示显式包含 TraceID 的日志；如果应用其实没打这个字段，会直接看起来“没日志”
3. **日志底座是否完整**
   - trace/log 联查最终还是依赖 logging 能采、能存、能查；至少要回看 `ACP Log Essentails`、`ACP Log Collector`、`ACP Log Storage`

最短判断法：**先用同一条 trace 进 `View Log`，分别试“勾选 / 不勾选 `Contain Trace ID`”**。
- 不勾有、勾了没：大概率是应用没把 TraceID 打进日志
- 两边都没：再回查 logging 底座或时间窗

### Trace Logs 默认查多大时间范围？
默认会查**整条 trace 持续时间**内的日志。

补充规则：
- 如果 trace 持续时间不足 1 分钟，平台会默认查 **trace 开始时间后 1 分钟** 的日志

### Trace Logs 页面除了按 TraceID 看日志，还能做什么？
还支持几类很实用的动作：
- 按 **Pod Name** 过滤
- 用关键字做 **Query Conditions** 过滤
- 导出日志为 **JSON / CSV**
- 自定义展示字段
- 点 **Insight** 查看目标日志前后上下文（默认前后各 5 条，并可继续滚动加载）

### 为什么从 trace 里点“View Log”后还是不好定位问题？
常见不是“没日志”，而是**过滤粒度还不够**。

优先补这几个动作：
- 先按参与 trace 的 **Pod Name** 缩小范围
- 再用 **Query Conditions** 补关键字
- 必要时点 **Insight** 看上下文，而不是只盯单条日志

### Tracing 为什么装完了还是看不到入口？
先查两个前提：
1. `Tracing` 相关 operator 和实例是否真的装成功
2. `acp-tracing-ui` feature switch 是否已经手动开启

高频验收动作：
- `kubectl -n jaeger-operator get csv` 确认 Jaeger Operator `PHASE=Succeeded`
- `kubectl -n opentelemetry-operator get csv` 确认 OpenTelemetry Operator `PHASE=Succeeded`
- 查看安装脚本输出里是否真的创建了 `jaeger`、`opentelemetrycollector`、`instrumentation`、`ingress`、`servicemonitor` 等资源

别漏掉：
- tracing 目前还是 **Alpha**，文档明确要求手动开 `acp-tracing-ui`
- tracing 与 Service Mesh 互斥，已装 mesh 时要先卸载

### OTel collector 默认是怎么接 Jaeger 的？
平台默认 collector 走的是 **OTLP exporter → Jaeger collector** 这条链路。

关键点：
- collector 接收：`4317(gRPC)` / `4318(HTTP)`
- traces pipeline：`otlp receiver -> memory_limiter -> batch -> otlp exporter`
- 默认 exporter endpoint：`dns:///jaeger-prod-collector-headless.cpaas-system:4317`

所以如果后续出现“应用侧已打点但平台没 trace”，除了查应用接入，也要查：
- `otel-collector` 是否正常
- `jaeger-prod-collector-headless` 是否可达
- `cpaas-system` 里相关 Pod / Service 是否正常

再往前推一层，这条链路也给了非 Java 服务一个可复用接入模式：
- 应用侧只要能按 OTel SDK / instrumentation 发 OTLP
- 就可以复用平台现成 `otel-collector -> jaeger -> Elasticsearch` 链路
- 不必把重点放在“有没有 ACP 专属 Python 自动注入”上

### 平台默认 Java 自动注入 tracing 要配什么？
最小集成面很固定：
- Deployment 注解：`instrumentation.opentelemetry.io/inject-java: cpaas-system/acp-common-java`
- 环境变量：`SERVICE_NAME`、`SERVICE_NAMESPACE`

其中：
- `SERVICE_NAME` 常从 `app.kubernetes.io/name` label 取
- `SERVICE_NAMESPACE` 常从 `metadata.namespace` 取

默认 Instrumentation 里已经带了这些关键项：
- `OTEL_TRACES_EXPORTER=otlp`
- `OTEL_METRICS_EXPORTER=otlp`
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.cpaas-system:4317`
- `OTEL_SERVICE_NAME=$(SERVICE_NAME).$(SERVICE_NAMESPACE)`

这也说明一个边界：
- 官方文档当前明确给出的“平台级自动注入主线”是 **Java**
- 对 Python / Go / Node 这类非 Java 服务，不要先假设 ACP 也提供同等成熟的自动注入入口

### 怎么验证 Java 自动注入真的生效了？
最短验证路径：
1. 看新 Pod 里是否出现 `opentelemetry-auto-instrumentation-java` init container
2. 发送几次真实请求
3. 去 **Observability → Tracing** 看是否出现该服务链路

如果第 1 步就没有，优先回看：
- Deployment 注解是否写对
- 是否用了 `cpaas-system/acp-common-java`
- 应用是否是 `Java 8+`

### 平台默认 tracing 采样率是多少？
默认 sampler 是：`parentbased_traceidratio`，参数是：`argument: "1"`。

这意味着默认接近**全采样**。

所以如果后续出现：
- Elasticsearch 压力大
- trace 数据量过多
- 查询成本高

优先要想到采样策略是不是该调整，而不是只盯查询页。

## Monitoring / Alerting / Notification

### Prometheus 和 VictoriaMetrics 怎么选？
可以先按场景粗分：
- **Prometheus**：更适合单集群、小规模、已重度依赖 Prometheus 生态的场景
- **VictoriaMetrics**：更适合高可用、多集群、长时存储、资源效率敏感的场景

补充两点：
- 平台一次只能选其中一种
- 两者切换前要先卸载旧组件，且监控数据不支持跨组件迁移

### 为什么说 VictoriaMetrics 更适合中心化监控？
因为它原生更适合：
- 多集群统一汇聚
- 高可用部署
- 长时数据存储
- 更高压缩率和更低资源占用

### 装监控前最容易漏掉的前提是什么？
三个高频前提：
- 先完成组件选型
- 如果监控装在 workload cluster，`global` 集群必须能访问 workload cluster 的 `11780` 端口
- 如果要用 StorageClass / PV，底层存储资源要提前建好

### 监控存储类型后面还能改吗？
不能。`LocalVolume / StorageClass / PV` 这类存储方式需要在安装时确定，安装后不能再修改。

### 监控组件调度到 infra 节点的最佳实践是什么？
在插件配置层设置 `spec.config.components.nodeSelector/tolerations`，不要把 patch Deployment/StatefulSet 当标准方案。

额外要注意：
- 如果存储用的是 `LocalVolume`，被选中的存储节点也必须匹配这些调度规则
- 如果 PV 带 `nodeAffinity`，也要一起检查，不然会出现“规则写了但仍调度不上”的现象

### 为什么监控工作负载还是跑到了普通节点？
先查三件事：
1. 目标 infra 节点是否真有你写的 label
2. tolerations 是否真匹配这些节点上的 taint
3. 插件是否已经按新配置完成 upgrade / re-apply

这类问题通常不是组件“不认配置”，而是**节点标签、污点或插件重载没有对上**。

### 为什么监控组件调度不上指定 infra 节点？
这通常说明**调度约束**和**存储约束**至少有一个没满足。

高频原因：
- infra 节点没有 `nodeSelector` 引用的 label
- infra 节点 taint 没被 tolerations 覆盖
- `LocalVolume` 节点或 PV `nodeAffinity` 指到了 infra 节点组之外

### Prometheus 监控数据怎么备份最直接？
直接备份 TSDB 目录，或启用 Admin API 做 snapshot。

### Prometheus 直接拷目录备份有什么坑？
不包含备份瞬间仍在 cache 中、未落盘的数据。

### Prometheus 恢复后为什么历史数据看起来不全？
先怀疑备份方式本身：
- 如果你备份的是 TSDB 目录，它天然**不包含内存 cache 中尚未落盘的数据**
- 如果要更稳一点，可以走 Admin API snapshot 方案

恢复后也要确认：
- 数据是否真的放回了 Prometheus 使用的目录
- Prometheus 是否已正常重新加载历史块数据

### VictoriaMetrics 怎么备份恢复？
使用官方工具：`vmbackup` / `vmrestore`。

补充关注点：
- 先确认 `-storageDataPath`，默认是 `/vm-data`
- 备份恢复细节按官方文档走，不建议自己手工拼目录

### 怎么确认平台里都有哪些 metrics 可用？
有两个常用入口：
- 查监控后端已存储的全部 metrics：`/v2/metrics/<cluster>/prometheus/label/__name__/values`
- 查平台内置指标定义：`/v2/metrics/<cluster>/indicators`

第二个接口尤其适合排“这个指标平台能不能直接拿来做告警/看板”。

### 怎么判断一个内置指标能不能直接做告警或 Dashboard？
重点看内置指标返回里的几个字段：
- `alertEnabled`：是否支持用于告警
- `features`：是否支持 Dashboard 等场景
- `multipleEnabled`：是否支持多资源告警
- `query`：底层 PromQL
- `variables`：可用变量

所以很多“平台有没有这个指标”的问题，本质上可以直接用指标定义接口确认。

### 外部应用 metrics 接进来后没被采到，先看哪里？
先看 `ServiceMonitor/PodMonitor` 有没有真的被监控组件接管。

高频检查项：
- `ServiceMonitor` 的 label 是否匹配 Prometheus CR 的 `serviceMonitorSelector`
- `ServiceMonitor` 所在 namespace 是否落在 `serviceMonitorNamespaceSelector` 范围内
- `selector` / `namespaceSelector` / `port` / `path` 是否能准确匹配到目标 Service
- 如果 exporter 需要认证，`basicAuth` / bearer token / tls 配置是否齐

最小验证动作：
- 去 Prometheus targets 或 VictoriaMetrics UI 看对应 job 是否存在

### Blackbox 监控建好了却没有探测结果，为什么？
先别急着判失败，文档明确说：
- 创建成功后，系统大约需要 **5 分钟** 同步配置
- 这段时间内不会开始探测，也看不到结果

如果超过这个时间还没有，再查：
- 监控组件是否安装且正常
- 目标地址格式是否符合所选探测方式（ICMP/TCP/HTTP）

### Blackbox 监控默认支持哪些探测方式？
三类：
- `ICMP`
- `TCP`
- `HTTP`

补充两个容易漏的边界：
- HTTP 默认只支持 `GET`
- 低于等于 `3.10` 内核的节点，不支持用 ICMP 探测 IPv6 地址

### 想用 Blackbox 做 HTTP POST 探测怎么办？
默认不行，要给 Blackbox Exporter 的配置文件额外加自定义 module，例如 `http_post_2xx`。

加完后还要激活配置，常见做法二选一：
- 删除 Blackbox Exporter Pod 让它重启
- 调 reload API：`POST <Pod IP>:9115/-/reload`

### 告警策略创建失败或不生效，最常漏什么前提？
按数据源分开看：
- 用**监控指标**做告警：目标 cluster 必须装好 monitoring 组件
- 用**日志/事件**做告警：目标 cluster 还必须装好 log storage 和 log collection 组件
- 要发通知：还要先配 notification policy

### 告警为什么没发通知？
最常见要倒查三层：
1. 告警本身是否真的触发
2. notification policy 是否真的绑定到了告警策略
3. 通知服务器 / 联系人组 / 联系方式是否完整可用

如果是邮件或企业通信工具，还要继续核对：
- 用户邮箱、WeChat Work ID、DingTalk ID、Feishu ID 是否已填
- webhook URL 或 header secret 是否配置正确

### Notification 联系人组配好了，Webhook 还是调不通，先怀疑什么？
先怀疑两件事：
- 联系人组里是否真的填了对应 webhook URL
- 如果对端要求自定义 HTTP header，是否额外创建了 `NotificationSender` 类型 Secret，并通过 `cpaas.io/notification.webhook.config` 关联到 `NotificationGroup`

### 企业通信工具通知服务器有哪些限制？
有一个很容易被忽略的限制：
- **Corporate Communication Tool Server 只能添加一个**

也就是说，企业微信 / 钉钉 / 飞书这一类企业通信工具服务器，不是想并列加几个就加几个。

### Dashboard 为什么不是直接写监控后端？
因为 ACP 里 dashboard 管理要经过平台控制链路：
- `Browser -> global ALB -> Erebus -> target cluster`

`Warlock` 负责校验和管理 `MonitorDashboard` CR，不是前端直接写底层对象。

补一个实用结论：
- Dashboard 本质上是 **Kubernetes 里的 `MonitorDashboard` CR**
- 所以很多“UI 配不出来/想批量迁移/想精细改字段”的场景，可以回到 CR/YAML 视角理解

### 监控查询链路怎么走？
核心链路是：
- `Browser -> ALB -> Courier API -> Monitoring Backend`

其中：
- 内置指标会先转换成 PromQL 再查
- 自定义指标会直接把 PromQL 转给监控组件

### Monitoring 模块除了存指标，还包括什么？
至少要分三层理解：
- **监控系统**：采集、存储、查询、可视化
- **告警系统**：规则、评估、告警状态
- **通知系统**：模板、联系人组、通知策略、通知服务器

而 Dashboard 这一层还有几个容易忽略的运维边界：
- 目标 cluster 必须已经装 monitoring，且指标已被采集
- 如果 Group 处于折叠状态，里面的 panel 不会发查询
- `Instant` 开关会直接影响是查当前值还是查时间范围序列

### 告警链路怎么理解最顺？
按三段记：
1. `PrometheusRule / VMRule` 定义规则
2. Prometheus / VictoriaMetrics 周期评估
3. 触发后交给 Alertmanager，再经 `ALB -> Courier API` 做通知派发

### 告警历史和实时状态分别看哪里？
- **历史**：落到 `Elasticsearch / ClickHouse`
- **实时状态**：由 `global` 集群 Courier 生成指标（比如 `cpaas_active_alerts`、`cpaas_active_silences`），再被 global Prometheus 抓取

### 监控页看不到自定义命名网卡的流量，怎么处理？
先怀疑**网卡名没匹配到监控默认正则**。

官方做法：
- 在 `global` 集群找到对应 workload cluster 的 `moduleinfo`
- 通过 `spec.valuesOverride.ait/chart-cpaas-monitor.global.indicator.networkDevice` 补充网卡名匹配正则
- 等约 `10` 分钟后，再去 node 监控页看网络图表

### Grafana Dashboard 能直接迁到 ACP 吗？
可以，但有边界。

文档给出的结论：
- 支持导入 **Grafana JSON V8+**
- 低版本 JSON 会被拒绝导入
- 如果导入里包含平台暂不支持的 panel type，可能会显示成 **unsupported panel type**，但通常还能手动改 panel 配置继续使用

### Dashboard 很慢，先看哪些低成本抓手？
先看三个地方：
1. 目标 cluster 的 monitoring 是否真的正常
2. Dashboard 里的 Group 是否可以折叠，减少无关 panel 查询
3. 面板是不是误把“当前值场景”做成了 `query_range`，该开的 `Instant` 没开

这三个点都属于不改采集、不改后端、但很常见的性能/体验抓手。

### Dashboard 看起来像故障，但其实常是配置边界，先排哪几项？
按误判频率，优先看这 4 项：

1. **共享边界**
   - 业务视角即使看的是平台视角公开共享的大盘，数据仍按业务所属 `namespace` 隔离
   - 所以“同一个 Dashboard，不同人看结果不一样”很多时候不是故障，而是租户边界生效
2. **变量限制**
   - 某些内置 workload 指标明确不支持 `namespace` 多选 / `All`
   - `name` 也只支持 `deployment / daemonset / statefulset`
3. **查询模式选错**
   - 看当前值的 stat / gauge 类面板，如果没开 `Instant`，常会因为走 `query_range` 让人误以为值不对或刷新太慢
4. **Group 被折叠**
   - 折叠组内 panel 不会发查询；有些“面板没数据”其实只是组处于折叠状态

如果这 4 项都排除了，再去怀疑指标采集、PromQL 或监控后端。

### 为什么平台视角共享出来的 Dashboard，业务视角看到的数据不一样？
先别急着判数据错。

文档给出的边界是：
- 业务视角可以查看平台视角**公开共享**的 Dashboard
- 但数据仍会按业务所属 **namespace** 做隔离

所以这类现象很多时候不是面板坏了，而是**共享的是同一个大盘，查询到的数据却仍受业务租户边界约束**。

### Dashboard 变量明明配了多选/All，为什么某些 workload 面板还是没结果？
先怀疑踩到了**内置 workload 指标的变量限制**。

文档明确给出了一组边界：
- `namespace` 只支持选**单个** namespace
- `name` 只支持 `deployment / daemonset / statefulset`
- `kind` 也只能对应这三类之一
- 这些场景不支持 **multiple selection** 或 **All**

所以如果某些 workload 内置指标一开多选就空，优先怀疑是产品限制，不是 PromQL 一定写错。

## Inspection / Health / Logging

### Inspection 是谁在执行？
不是前端自己算，而是 **Courier + monitoring backend** 联合执行：
- 平台创建 inspection CR
- Courier 监听 CR
- 去各 cluster 的 monitoring 组件拿指标
- 算完后把结果写回 CR

### Basic Inspection 页面能直接做什么？
高频动作主要有两类：
- **Execute Inspection**：手工触发一次巡检
- **Download Report**：下载 `PDF` / `Excel` 报告

补充两个细节：
- `PDF` 报告不包含 resource risk details 页数据
- `Excel` 报告包含完整巡检数据

### 巡检执行中能看到结果吗？
能。文档明确说：
- 页面默认展示最近一次巡检
- 当前巡检进行中时，也能实时看到**已经完成那部分资源**的数据

所以“还没全跑完就一点数据都不能看”这个理解是不对的。

### Inspection 配置页最值得记的项有哪些？
主要是这几项：
- **Scheduled Inspection**：用 Crontab 配定时巡检，也可直接选平台预置模板
- **Inspection Record Retention**：保留多少条巡检记录
- **Email Notification**：选择通知联系人（联系人必须已配置邮箱）
- **Inspection Report Name**：巡检通知模板里显示的报告名
- **Inspection Configuration Items**：调证书、cluster host、pod 等巡检项阈值，或禁用某项

### 巡检结果主要怎么看？
先看三个总览字段：
- **Inspection Time**：开始/结束时间
- **Total Number of Inspection Resources**：本次覆盖的资源总数
- **Risks**：风险资源数，包含 `Fault` 和 `Warning`

往下再按两个视角看：
- **Resource Risk Inspection**：看 cluster / node / pod / certificate 的风险概览和明细
- **Resource Utilization Inspection**：看 CPU / memory / disk 的总量、用量、使用率，以及平台资源数量

### 风险明细页能看到什么？
点资源卡片上的 **Risk Details** 后，通常能看到：
- 最近一次该资源类型的巡检结果
- fault / warning 资源列表
- 每条风险的判断条件与原因
- 资源详情页跳转入口

### 为什么巡检里一个资源会被判成有风险？
因为每类资源都有一组**命中任一条就算风险**的判断条件，不是必须全部满足。

例如：
- cluster 会看 apiserver、监控组件、日志组件、ETCD、controller-manager、scheduler、CPU/内存请求率等
- node 会看 node-exporter、kubelet、inode、CPU、内存、磁盘、system load、死锁/OOM/TaskHung 事件
- pod 会看 Error、启动超时、CPU/内存、重启次数
- certificate 会看是否过期或剩余有效期是否不足 29 天

### Component Health Status 页面怎么看结果？
入口通常是右上角问号按钮 → **Platform Health Status**。

进去后先看 feature card：
- 卡片会展示该 feature 的健康状态统计
- 只要组件异常，就会显示成 `fault`

再点卡片上的 `health/fault` 数值，就会在右侧展开详情页，可以继续看：
- 哪些 cluster 没安装这个 feature
- 哪些已安装 cluster 处于不健康状态
- cluster 内部组件的检测数据和具体问题

### 组件健康检查依赖什么？
依赖两类数据：
- **Kubernetes**：看组件是否安装、副本是否正常
- **Prometheus / VictoriaMetrics**：看组件 metrics 是否显示服务正常

另外还会用到两个 CRD：
- `ModuleHealth`
- `ModuleHealthRecord`

### Logging 在 ACP 里只是“查日志”吗？
不是。它是 observability 的底座之一，至少承载：
- 日志采集
- 日志存储
- 日志查询
- 故障排查
- 合规留痕
- 运营分析

文档里点名的关键组件包括：`Filebeat`、`Elasticsearch`、`ClickHouse`。

这也是为什么 trace/log/alert history 排障经常要一起看：很多表象在 tracing 或 alerting 页面，根因却在日志/存储底座。

### Events 页面没数据，第一反应该查什么？
第一反应先查两层：
1. **是不是切到了正确 cluster**
2. 事件依赖的 **logging 插件栈** 是否完整

文档明确说 Events 依赖：
- `ACP Log Essentails`
- `ACP Log Collector`
- `ACP Log Storage`

另外页面默认只看最近 **30 分钟**。所以“没数据”常见并不只是采集坏了，也可能是**时间窗不对、cluster 切错、日志底座没装全**。

### Event Overview 卡片上的数量，为什么和下面事件记录条数对不上？
因为它们统计口径不一样。

`Significant Event Overview` 卡片统计的是：
- 在选定时间窗内，发生过该类事件的**资源数**
- 同一资源重复发生同类事件时，**不会累加**

所以卡片更像“有多少资源受影响”，不是“事件总共发生了多少次”。

### Event Level 里 Normal 和 Warning 怎么理解？
可以先按运维优先级理解：
- `Normal`（绿色）通常可忽略
- `Warning`（橙色）表示资源存在异常，更值得持续跟进

也就是说，事件页不是所有彩色点都同等重要，先把 `Warning` 级别和关键 `Reason` 看完，效率更高。

### Kubernetes 事件能直接拿来做告警吗？
可以。

文档明确说：
- 可以基于事件根因创建 **event alert**
- 当关键事件数量达到阈值时，平台可以自动触发告警并通知相关人员

这很适合回答这类问题：
- `BackOff` 太多能不能告警？
- 某类 Pod 异常事件能不能按时间窗统计并通知？

答案是可以，关键是把 **Event Reason / Event Level / Time Range / Trigger Condition** 配清楚。

### 告警规则里为什么不建议把 `$value` 放进 labels？
因为官方文档明确提示：**不要在 labels 里使用 `$value`**，否则可能导致告警异常。

更稳妥的做法是：
- `labels` 放稳定的分类字段
- 需要展示动态值时，优先放到 `annotations` 或通知内容里

### 审计、告警历史、日志检索为什么经常要一起看？
因为这些能力底层是互相咬合的：
- logging 提供采集、存储、检索底座
- audit 依赖日志栈才能看得到审计数据
- 告警历史也会落到 `Elasticsearch / ClickHouse`

所以很多“页面没数据”的问题，不能只查前端入口，要一起回看底层日志/存储组件是否完整。

### 事件页没数据 / 告警历史没数据 / 审计数据为空，第一反应先查什么？
先别分三条线查，先按**同一条 logging 底座**排：

1. **目标 cluster 的日志插件栈是否完整**
   - `ACP Log Essentails`
   - `ACP Log Collector`
   - `ACP Log Storage`
2. **再确认底层存储认知没错**
   - logging / 告警历史主要落在 `Elasticsearch / ClickHouse`
   - 如果这些底座异常，上层事件、审计、历史告警都会一起表现为空
3. **最后再排页面侧低成本误判**
   - 事件页默认只看最近 `30` 分钟
   - cluster 是否切对
   - 告警是否本来就没触发过，或只看实时状态没看历史

最短经验法则：**多个观测页面同时“空”，优先怀疑 logging 底座，而不是分别怀疑 event / audit / alert UI。**
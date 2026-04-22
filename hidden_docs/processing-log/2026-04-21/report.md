# 处理审计 — 2026-04-21

> 生成时间：2026-04-22 01:55 UTC　｜　rules hash：`bfc0a4519e8f0941…`
>
> 本页记录 ocp2acp 针对一批 OCP KB 文章的处理决策，包括决定**不**发布
> 的条目（signal / defer / reject）。欢迎同事在 PR 里就任意条目留言——
> 尤其是被我们 defer / reject 但你觉得 ACP 实际上能覆盖的，或者 classification
> 判断有偏差的。反馈会被 `feedback.py pull` 抓回来进再处理队列。

## 统计

| 分类 | 数量 |
|---|---|
| convert（通用 k8s） | 6 |
| defer（待规则/信息完善后再判） | 3 |
| reject（无适用价值） | 21 |
| **合计** | **30** |

## 逐篇决策

| ID | 分类 | 原因 | 产出 |
|---|---|---|---|
| 3524691 | reject | oc adm prune 是 OCP 专有操作，引用 OCP 3.x | — |
| 4105151 | reject | OCP 安装/部署，Lifecycle domain 不可转 | — |
| 4619431 | convert | kubelet 通用配置 | [Configure_Kubelet_Log_Level_Verbosity.md](../../../docs/en/solutions/Configure_Kubelet_Log_Level_Verbosity.md) |
| 4770281 | convert | etcd 通用排障 | [Backend_Performance_Requirements_for_etcd.md](../../../docs/en/solutions/Backend_Performance_Requirements_for_etcd.md) |
| 5136961 | reject | OCP Router + Authentication Operator 专有 | — |
| 5227051 | reject | oc adm must-gather 是 OCP 专有诊断工具 | — |
| 5254981 | reject | OCP 部署架构 | — |
| 5340011 | convert | 通用 k8s admission webhook + etcd 性能 | [MutatingAdmissionWebhook_Timeout_During_Pod_Creation.md](../../../docs/en/solutions/MutatingAdmissionWebhook_Timeout_During_Pod_Creation.md) |
| 5636241 | reject | OCP Cluster Version Operator 专有 | — |
| 5672521 | reject | OCP Service Mesh 专有 | — |
| 6088531 | reject | OCP Logging Operator 专有 | — |
| 6338121 | reject | OCP Cluster Version Operator 专有 | — |
| 6515171 | reject | OCP 专有 etcd encryption migration | — |
| 6518161 | reject | OCP 专有 | — |
| 6979679 | defer | 概念有用但依赖 MachineConfig | — |
| 6984536 | convert | PrometheusRule CRD + etcd 通用指标 | [Create_PrometheusRule_Alerts_for_etcd_Defragmentation.md](../../../docs/en/solutions/Create_PrometheusRule_Alerts_for_etcd_Defragmentation.md) |
| 7024725 | reject | OCP Compliance Operator 专有 | — |
| 7037820 | reject | Route 是 OCP 专有资源 | — |
| 7046476 | reject | OpenShift Virtualization 专有 | — |
| 7047778 | convert | kubelet cpu manager 通用行为 | [cpuset_Changes_After_Restarting_the_Kubelet_Service.md](../../../docs/en/solutions/cpuset_Changes_After_Restarting_the_Kubelet_Service.md) |
| 7062880 | defer | 初判 convert 但重写阶段发现依赖 OCP 特有 oc debug node + control plane 架构，待确认能否脱离 | — |
| 7072015 | defer | NVMe 配置概念但依赖 MachineConfig | — |
| 7075675 | reject | OCP Logging Console Plugin 专有 | — |
| 7077825 | reject | OCP Console Operator 专有 | — |
| 7083311 | reject | OCP mirror registry 专有 | — |
| 7105585 | reject | OCP revision pruner 专有 | — |
| 7130642 | reject | OpenShift Virtualization 专有 | — |
| 7138358 | convert | 通用 k8s CSR + 证书过期排障 | [Expired_Node_Certificates_Cause_CSR_Backlog_and_CNI_Pod_Crashes.md](../../../docs/en/solutions/Expired_Node_Certificates_Cause_CSR_Backlog_and_CNI_Pod_Crashes.md) |
| 7138727 | reject | OCP Compliance Operator 专有 | — |
| 7138824 | reject | OCP Web Console + NMState Operator 专有 | — |

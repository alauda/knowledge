---
title: ACP Storage Symptom-Based Runbook
type: runbook
status: draft
domain: storage
product: acp
tags: [acp, storage, runbook, nfs, pvc, harbor, troubleshooting, ticket-derived]
updated: 2026-06-21
source: [experience, ticket-cases]
related:
  - ../../ticket-documents/indexes/problem-clusters.md
  - ../knowledge-project-home.md
---

# ACP 存储挂载与容量现象排障手册

> 这份手册围绕历史工单里高频出现的三类现象：
>
> - NFS / PVC 挂载失败
> - 存储容量满 / 配额异常
> - Harbor / 存储服务访问异常

## 1. 首页分诊

先按这条链路判断：

**存储类/参数 → PV/PVC → 节点挂载能力 → Pod 使用方式 → 平台展示/配额**

### 最短判断顺序

1. 是“创建失败”还是“已有卷使用异常”
2. 是 PVC/PV 绑定问题，还是节点实际挂载失败
3. 是协议/参数问题，还是节点能力问题
4. 是真实容量不足，还是展示/配额判断异常
5. 如果涉及 Harbor，是镜像仓库访问问题还是底层存储问题

---

## 2. 现象：NFS 挂载失败 / 升级后挂载失败

### 更像卡在哪一层
优先怀疑：**协议参数层** 和 **节点挂载能力层**。

### 最小验证动作

1. 确认 NFS 版本（v3/v4）
2. 核对 PV / StorageClass / mount 参数
3. 确认客户端节点具备对应挂载能力
4. 如果升级后才出现，重点比较升级前后 PV/NFS 参数差异
5. 必要时直接在节点侧做最小挂载验证

### 常见根因

- 挂载参数不完整或不匹配
- 升级后 PV 参数未同步调整
- 节点本机挂载能力或工具链异常
- NFS 服务端与客户端参数不兼容
- CSI 组件未正常运行、被策略拦截，或节点路径/挂载拓扑变化后注册状态未刷新

### 代表案例

- [TICKET-1322660104](../../ticket-documents/cases/TICKET-1322660104%20金桥平台升级后挂载nfs存储失败.md)：升级后挂载 NFS 失败，后续修改 PV 参数恢复
- [TICKET-1264413594](../../ticket-documents/cases/TICKET-1264413594%20生产有挂载失败问题.md)：NFSv3 挂载失败且持续时间很短时，不要先按偶发抖动收掉；更稳核心是节点 `rpcbind` 前提未满足，或存储类侧缺少 `nolock` 一类兼容参数
- [TICKET-1283919224](../../ticket-documents/cases/TICKET-1283919224%2010.16.4.182节点执行%20df%20-h会卡主.md)：节点上 `df -h` 卡住时，不要先写成系统卡死；更稳核心是 kubelet CSI `globalmount` 残留挂载把 `stat()` 调用拖住，先用 `strace` 定位、再用 `umount -rl` 止血
- `TICKET-1291351174`：部署 NFS 存储类失败
- [TICKET-1346480094](../../ticket-documents/cases/TICKET-1346480094%20备份恢复后%20PV%20变小，不先怪应用，而要先确认%20ACP%20当前只做%20Pod%20文件系统级备份而非块级快照恢复.md)：恢复后卷占用变小不等于备份失败，先确认当前备份模型是 Velero + Restic 的文件系统级恢复
- [TICKET-1348678874](../../ticket-documents/cases/TICKET-1348678874%20应用容器启动失败，提示volume%20attachment%20is%20being%20deleted.md)：`volume attachment is being deleted` 不一定是卷对象残留；先确认 CSI Pod 是否被策略拦截，以及 `/var/lib/kubelet` 变更后注册状态是否失真

---

## 3. 现象：PVC 创建异常 / PVC 相关接口报错

### 更像卡在哪一层
优先怀疑：**PVC/PV 绑定链路**，其次是 **DNS / 服务解析**。

### 最小验证动作

1. 先确认是创建失败、绑定失败，还是接口访问报错
2. 检查 PVC、PV、StorageClass 是否匹配
3. 检查相关控制面服务日志
4. 如果报服务解析异常，回到节点 DNS 配置检查
5. 再看是否存在定制组件或版本关联问题

### 常见根因

- StorageClass / PVC / PV 参数不一致
- 服务解析失败
- 节点 DNS 配置异常
- 相关组件存在版本或定制问题

### 代表案例

- [TICKET-1299176644](../../ticket-documents/cases/TICKET-1299176644%20pvc-service接口报错.md)：`pvc-service` 接口报错，最终定位到主机 DNS `search` 域影响解析
- [TICKET-1340610944](../../ticket-documents/cases/TICKET-1340610944%20PVC创建异常.md)：PVC 创建异常

---

## 4. 现象：存储满了 / 配额不足 / 使用率异常

### 更像卡在哪一层
优先怀疑：**真实容量问题** 与 **平台展示/配额判断** 两条线。

### 最小验证动作

1. 先确认是否真的磁盘/卷满了
2. 区分是节点本地目录、PVC、对象存储还是仓库存储满
3. 核对平台页面配额提示与实际资源状态是否一致
4. 检查是否有日志、临时文件、binlog 等持续增长
5. 必要时回到业务写入模式看是否异常放大

### 常见根因

- 卷真实写满
- 日志/临时文件未清理
- binlog 或中间件数据增长
- 平台展示与实际配额判断不完全一致

### 代表案例

- [TICKET-1343430814](../../ticket-documents/cases/TICKET-1343430814%20容器挂载pvc使用率满，容器内删除日志文件卡住.md)：PVC 使用率满，容器内删除日志文件卡住
- `TICKET-1344038704`：页面提示配额不足，但实际可更新成功
- `TICKET-1343215994`：mysql binlog 磁盘使用量过高

---

## 5. 现象：Harbor / 仓库访问或同步异常

### 更像卡在哪一层
这是**仓库服务访问层**与**底层存储层**混合问题。

### 最小验证动作

1. 先区分是访问异常、同步异常、认证异常还是空间不足
2. 如果涉及 HTTPS / SSO / NodePort，优先确认入口链路配置
3. 如果涉及同步失败，检查上游仓库、凭证、网络与协议
4. 如果涉及空间不足，回到底层存储容量检查

### 常见根因

- NodePort / HTTPS / 域名访问链路不正确
- 同步凭证或上游连接异常
- 仓库存储空间不足
- SSO / 集成配置未真正生效
- Harbor 依赖 PostgreSQL 未正常监听或异常停机后残留运行态锁文件

### 代表案例

- [TICKET-1271719674](../../ticket-documents/cases/TICKET-1271719674%20harbor原始访问地址是nodeport,需更改为https%20nodeport,有方案吗.md)
- [TICKET-1308555444](../../ticket-documents/cases/TICKET-1308555444%20harbor镜像同步不成功，报错412.md)
- `TICKET-1324274734`
- [TICKET-1338487244](../../ticket-documents/cases/TICKET-1338487244%20harbor%20sso配置后无效果.md)
- [TICKET-1352523004](../../ticket-documents/cases/TICKET-1352523004%20harbor仓库无法登录.md)：Harbor 登录失败下钻到 harbor-core 依赖 PG；PG 异常宕机遗留 `postmaster.pid` 导致 5432 未监听，Pod 重建后恢复。

---

## 6. 首页速查：支持现场优先问这 6 个问题

1. 这是挂载失败、创建失败，还是使用中异常？
2. 问题发生在 PVC/PV、节点挂载、还是业务使用阶段？
3. NFS / PVC / Harbor / 本地盘，具体是哪一类存储？
4. 是否是升级后、改参后才出现？
5. 节点侧实际挂载或解析能力是否正常？
6. 页面提示的容量/配额，和底层真实状态是否一致？

---

## 7. 常见误判速查

- **PVC 报错 ≠ 一定是存储后端坏了**
- **挂载失败 ≠ 一定是 NFS 服务端故障**
- **配额不足提示 ≠ 一定真实资源不足**
- **Harbor 异常 ≠ 一定是仓库应用本身问题，也可能是入口、认证或底层存储问题**

---

## 8. 从这类问题里最值得继续沉淀什么

优先建议继续沉淀：

- NFS/PVC 挂载失败 FAQ + 参数对照表
- 存储容量/配额异常分诊表
- Harbor 访问 / 同步 / 空间问题排查模板
- 节点 DNS / 解析异常对存储组件的影响说明

## 5.1 Harbor 登录 / 入口 / 迁移表象的最小拆分（2026-05-31）

来自 [[TICKET-1326727934 harbor部署完成无法登录]] 与 [[TICKET-1316292404 harbor升级-harbor迁移问题]] 的补充：

- Harbor 初装后无法登录时，不要先把“PG Pod 内改密码后可登录”当成根因闭环；这可能只是绕过了 secret 键名/引用链错配。
- 升级后 Harbor 看起来像 migration / DB unknown 时，先拆页面、后台 login/API、域名入口、ALB Pod 四层；入口链异常可伪装成 Harbor 本体迁移问题。
- 最小验证顺序：服务是否可达 → 登录/认证链是否正常 → secret/实例引用/数据库内密码是否一致 → 域名/ALB/Ingress 后台 API 是否可达 → 最后再看 migration/DB 状态。
---

## 6. 现象：数据库 DataService 的 PVC 备份失败

### 先不要直接判断

不要先把它收成 Velero、对象存储或备份仓库故障。数据库类实例的卷数据是否可恢复，首先取决于**数据库一致性备份语义**，不是只取决于 PVC 文件是否能被复制。

### 最小验证动作

1. 先确认备份仓库是否已对接成功；
2. 再确认普通 K8s 资源备份是否成功；
3. 如果失败只集中在 MongoDB / MySQL / PostgreSQL 等 DataService PVC，先回到数据库/operator 备份路径；
4. 对 MongoDB，优先核对 operator 提供的 S3 备份资源，而不是默认用 Velero PVC 级备份承诺一致性恢复；
5. 若客户诉求是“页面可见 / 恢复简单”，单独记录体验诉求，不改变数据库一致性边界。

### 代表案例

- [TICKET-1286473284](../../ticket-documents/cases/TICKET-1286473284%20使用备份velero组件备份pvc失败.md)：DataService MongoDB 仓库可用、K8s 资源可备份，但 PVC 级备份失败；稳定口径是回到 operator / 数据库原生 S3 备份路径。


## 9. 现象：应用启动失败但根因在 Ceph 底层盘被复用（2026-06-06）

来自 [[TICKET-1314509554 测试环境服务无法启动]] 的补充：

- 应用起不来且挂载 Ceph 存储时，不要只停在业务 Pod、镜像或应用配置；先确认 Ceph health、PVC/PV、OSD 与底层盘映射。
- 若原 Ceph 磁盘被清理后拿去做 TopoLVM/LVM，本质是同一批底层盘被跨存储体系复用，先打坏 Ceph，再向上放大成应用启动失败。
- 现场应保留 `lsblk`、Ceph OSD/PV/LV 映射、TopolVM deviceClass、Ceph health 等证据；确认盘已被重新初始化后，再评估旧 Ceph 是否还有恢复价值。

## 10. 现象：本地存储 / PVC 访问模式 / MinIO 扩容 / TopoLVM 误选（2026-06-19）

来自 medium + merged-existing/no-case 工单的稳定补充：这类问题通常不是单点故障，而是存储能力边界、节点规划或错误选择后的处置方案。

### 最小判断链

1. **PVC 动态访问模式**：先回到 StorageClass / CSI 能力与文档字段，确认访问模式是否由存储类能力、PVC 声明和后端驱动共同决定；不要承诺平台能绕过后端能力。
2. **TopoLVM 未加设备前组件异常**：TopolVM 依赖可用本地块设备；设备未加入时组件 Crash/异常可能是前置不足，加盘后自愈不能写成应用故障。
3. **本地盘日志/监控节点规划**：Prometheus、ES 使用本地盘时，要先确认固定节点、节点可调度策略和故障漂移预期；把日志节点设为不可调度会影响调度与恢复模型。
4. **MinIO 扩容**：global 静态 Pod manifest 类 MinIO 扩容应按节点逐台滚动修改/验证，不要一次性改三台。
5. **误选 TopoLVM 后迁 NFS**：TopoLVM 本地 LVM 与 NFS 属异构存储；平台没有标准在线迁移路径，未投产/测试环境优先重建业务并绑定正确 StorageClass。
6. **PV finalizer 卡住**：升级/安装 VM 时 PV 卡 `kubernetes.io/pv-protection`，需先确认删除链和 operator 状态；手工移除 finalizer 是强制恢复动作，应保留证据并在窗口内执行。

### 关联工单

- TICKET-1350209064：PVC 动态模式访问模式需参考存储类/文档能力。
- TICKET-1349234684：TopoLVM 未加设备前组件 Crash，加盘后恢复。
- TICKET-1348962884：Prometheus/ES 使用本地盘时，节点专用和不可调度策略会影响故障漂移。
- TICKET-1349893314：global MinIO 扩容通过逐个 master 修改静态 manifest 并验证。
- TICKET-1350284524：业务 PVC 误选 TopoLVM 后不建议迁移到 NFS，优先重建并选择正确 SC。
- TICKET-1350787394：升级安装 VM 时 PV finalizer 卡住，手工移除后恢复，但需说明 K8s 保护机制与风险。

### Deep-case 信号

- 当前判断：一般不需要。
- 原因：多数是存储能力边界、规划建议或标准 K8s 对象保护机制。
- 还缺什么证据：若 TopoLVM/NFS/MinIO/PV finalizer 处理后仍失败，需要 PVC/PV/SC YAML、CSI/controller 日志、节点 `lsblk`/挂载状态、operator 事件与变更时间线。

## 10.1 TopoLVM 设备前置、磁盘残留与跨命名空间 PVC 边界（2026-06-20）

### 适用场景

- TopoLVM 部署前未挂载/加入可用块设备，组件 Crash 或 TopoLVMCluster 不 Ready；
- TopoLVM 创建失败，现场怀疑磁盘上有历史分区、文件系统签名或 LVM 残留；
- 客户希望跨 namespace 复用同一个 PVC，或询问 `TridentVolumeReference` 这类第三方 CRD 是否可作为平台方案。

### 典型现象

- “加盘后 TopoLVM 自愈”：更像前置设备未满足，不宜写成平台组件自身故障；
- 清理待加入节点磁盘后，重新创建 TopoLVMCluster 成功；
- 客户希望一个 namespace 的 PVC 被另一个 namespace 直接挂载使用。

### 排查路径

1. 部署 TopoLVM 前先确认节点有规划内块设备，且未被 Ceph、系统盘、已有 LVM 或业务数据复用。
2. 对创建失败的节点，收集 `lsblk`、`blkid`、`pvs/vgs/lvs`、TopoLVMCluster 状态与 controller/node 日志，再判断是否为磁盘残留。
3. 如需清理磁盘，必须确认设备名、业务归属和维护窗口；`dd`、`wipefs -af`、`sgdisk --zap-all` 属破坏性动作，只能作为明确确认后的恢复步骤记录。
4. PVC 跨 namespace 共享时，先回到 Kubernetes 资源边界：PVC 是 namespace 级对象，平台默认不提供跨 namespace 直接挂载同一 PVC 的通用方案。
5. 第三方 CRD（例如客户提到的 `TridentVolumeReference`）不能直接等同于 ACP 支持能力；需先确认产品支持矩阵与对应存储插件。

### 处理建议

- TopoLVM 部署规划阶段，先把可用磁盘、节点亲和、故障域和数据保留策略写清楚。
- 若磁盘残留导致创建失败，优先保留清理前证据，再按已确认设备做 wipefs/sgdisk 等清理并重建。
- 跨 namespace 数据共享诉求建议改用对象存储、NFS/RWX 存储类、应用层同步或重新设计数据边界；不要承诺直接复用 PVC。

### 风险边界

- 磁盘清理命令会破坏数据，不能作为无确认的“标准自动步骤”。
- TopoLVM 是本地存储语义，节点故障与卷可迁移能力不同于网络存储。
- PVC namespace 边界是 Kubernetes 基础约束；除非产品明确支持第三方能力，否则不作为平台方案。

### 关联工单

- TICKET-1349234684：TopoLVM 未加设备前组件 Crash，加设备后恢复。
- TICKET-1352580454：清理待加入节点磁盘残留后，重新创建 TopoLVMCluster 成功；现场涉及 `dd`、`wipefs -af`、`sgdisk --zap-all` 等破坏性清理动作。
- TICKET-1352453764：客户咨询跨命名空间共享存储卷，稳定口径为 PVC 是 namespace 级资源，平台暂无通用跨 namespace 共享方案。

### Deep-case 信号

- 当前判断：可选。
- 原因：设备前置和跨 namespace PVC 多数是能力边界 FAQ；磁盘残留清理若一次性恢复，也不需要 deep-case。
- 还缺什么证据：若需 deep-case，需要 TopoLVMCluster/CSI 日志、失败节点磁盘残留证据、清理前后 `lsblk/blkid/pvs` diff、重建事件，以及确认无业务数据误删的变更记录。


## 10.2 NFS 协议版本、Harbor 仓库容量与只读挂载短 FAQ（2026-06-21）

### 适用场景

- PVC 创建或挂载失败，现场发现 NFS 服务端不支持 v4，改为 v3 后恢复；
- global 节点 `/cpaas` 或目录分区使用率高，最终定位到 Harbor registry 占用大量空间；
- 同一 NFS 在 ARM 节点可用、x86 节点挂载后只读，需判断是协议、mount option、节点能力还是后端导出策略差异。

### 排查路径

1. PVC 创建/挂载失败先看 event、StorageClass mountOptions、NFS server 导出版本和节点端 `mount -t nfs` 最小验证。
2. NFS v4 失败时，不要只重建 PVC；先确认服务端是否支持 v4、是否需要显式 `vers=3`/`nolock` 等参数。
3. Harbor 空间高占用先区分 registry blob、chart、日志和数据库；确认是镜像仓库占用后，再评估保留策略和 GC/清理窗口。
4. 不同架构节点挂载行为不同，需收集两侧 kernel/nfs-utils、mount 参数、实际挂载输出和服务端导出策略，不要直接写成平台存储故障。

### 处理建议

- NFS 协议不匹配时，在 StorageClass/PV 中显式写入匹配版本参数，并用新 PVC 验证。
- Harbor registry 空间清理优先走镜像保留/清理策略与受控 GC；不要手工删除 registry 后端文件。
- 只读挂载类问题先做节点侧最小挂载对比，再决定是否调整 mountOptions 或后端导出策略。

### 风险边界

- 修改 StorageClass 可能只影响新 PVC，存量 PV/PVC 是否生效需单独验证。
- Harbor GC/清理可能影响镜像可用性，需确认引用、保留策略和维护窗口。
- 手动删除 NFS/registry 后端文件属于高风险动作，不进入客户草稿。

### 关联工单

- TICKET-1354793894：PVC 创建失败，NFS 不支持 v4，改为 v3 后重新创建 PVC 成功。
- TICKET-1354685834：global 节点目录分区告警，确认 Harbor 仓库占用约 244G，可通过镜像清理策略释放。
- TICKET-1354851814：同一 NFS 在 ARM 上正常、x86 挂载只读，需补协议/参数/节点能力证据后再归因。

### Deep-case 信号

- 当前判断：可选。
- 原因：协议版本与仓库容量通常可按 FAQ 闭环；跨架构只读挂载若稳定复现且证据完整，可转 deep-case。
- 还缺什么证据：若要 deep-case，需要 PVC/PV/SC YAML、Pod event、两类节点 `mount`/`dmesg`/nfs-utils 版本、NFS export 配置、Harbor registry 占用明细、GC 前后对比和业务镜像引用清单。

---

## 13. 现象：本地存储 / TopoLVM 容量满与 `/cpaas` 增长（2026-06-21）

### 更像卡在哪一层

优先区分 **业务 PV/TopoLVM 容量耗尽**、**节点根盘或 `/cpaas` 目录增长**、**日志/ClickHouse 组件数据增长**。这三类处理边界不同，不要统一写成“清理磁盘”。

### 最小验证动作

1. 先确认满的是 TopoLVM 本地卷、宿主机根盘、`/cpaas`，还是某个组件 PV。
2. 列出占用来源：MongoDB/MySQL/PXC/ProxySQL/ClickHouse/日志组件/镜像层/业务目录。
3. TopoLVM 本地存储满时，确认每节点裸盘容量、LV/VG 使用率、卷与 Pod 分布，评估加裸盘/扩 VG/迁移业务。
4. `/cpaas` 增长时，确认是否低版本 ClickHouse/日志组件写入慢查询日志或组件日志，是否有已知清理能力缺口。
5. 任何删除历史数据前，先确认是否业务可接受、是否需停组件、是否有备份与回滚窗口。

### 处理建议

- TopoLVM 容量不足：优先按用量归因与扩容方案处理；常见方案是增加裸盘、扩容本地存储池，或迁移高占用业务。
- `/cpaas` 被日志/ClickHouse 撑满：先按版本已知问题和组件日志策略确认；临时清理只能在明确数据价值、停组件和备份边界后执行。
- 不要直接建议删除 PV 后端目录、ClickHouse 数据目录或 runtime 数据目录；这类动作必须走变更审批和数据确认。

### 代表样本

- TICKET-1353509764：TopoLVM 本地存储空间爆满；3 节点每节点 500G，MongoDB/MySQL-PXC 占用明显，建议分析具体服务用量并通过增加裸盘扩容。
- TICKET-1355002634：节点 `/cpaas` 目录满；低版本 ClickHouse 慢查询日志/组件日志增长导致，临时清理需停组件并确认历史数据是否可丢弃。

### Deep-case 信号

- 当前判断：可选。
- 原因：容量满模式稳定，但当前证据更适合 runbook；如涉及低版本 ClickHouse 日志清理缺陷和生产数据删除，再需要 deep-case。
- 还缺什么证据：`df -h`/`du`、LV/VG 列表、PV/PVC 与 Pod 分布、ClickHouse 版本、日志保留配置、清理前后容量变化、业务确认与变更记录。


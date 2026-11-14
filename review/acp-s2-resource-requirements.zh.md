# ACP 4.5 标准交付：各节点池资源需求（review 用，合并前删除）

本文件只用于 review《ACP 4.5 + Alauda OS 标准交付》的资源规格，不是发布文章，合并前删除。

- CPU、内存按各组件的 limits 求和，并假设部署时 requests = limits。
- 规格按常见机型取值：CPU 只取 4、8、12、16、24、32 核，内存只取 8、16、24、32、48、64 GiB，CPU 与内存的配比只取 1:2、1:3、1:4。
- 数据盘（TopoLVM、Ceph OSD）从 100、200、300、500、1000、2000 GiB 中取不小于需求的最小一档；平台盘按产品推荐值。
- 日志按 5,000 条/秒规划，数据盘保留 7 天。
- 只算平台节点池；业务 worker 由业务决定，不在此列。
- 所有规格都是建议值。怎么算的、依据是什么，见文末「计算方法与依据」。

---

## 1. 总表

「需求」是按组件求和的每台需求（不含系统预留），「取值」是按常见机型取整后的规格。磁盘单位 GiB，每台。

| 集群 | 节点池 | 台数 | 需求 CPU / 内存 | 取值 CPU / 内存 | 配比 | 数据盘 需求 → 取值 | 平台盘 | 主要占用 | 文章原值 |
|---|---|---:|---|---|---|---|---|---|---|
| 单集群 | control-plane | 3 | 14.0 / 22.5 | 16 核 / 32 GiB | 1:2 | — | 系统盘 100 / containerd 150 / kubelet 100 / etcd 20 / `/var/cpaas` 200 | 平台核心、平台 Ingress Gateway、监控 API、日志查询 | 16 核 / 32 GiB |
| 单集群 | infra | 3 | 15.0 / 26.2 | 16 核 / 48 GiB | 1:3 | TopoLVM 729 → **1000** | 系统盘 100 / containerd 150 / kubelet 100 / `/var/cpaas` 100 | 日志、监控、Ingress、镜像仓库 | 12 核 / 48 GiB |
| global | control-plane | 3 | 14.0 / 22.5 | 16 核 / 32 GiB | 1:2 | — | 同单集群 control-plane | 平台核心、平台 Ingress Gateway、监控 API、日志查询 | 16 核 / 32 GiB |
| global | infra | 3 | 10.8 / 22.3 | 16 核 / 32 GiB | 1:2 | TopoLVM 609 → **1000** | 系统盘 100 / containerd 150 / kubelet 100 / `/var/cpaas` 100 | global 自己的日志、监控 | 16 核 / 32 GiB |
| workload (a) | control-plane | 3 | 6.7 / 18.9 | 8 核 / 32 GiB | 1:4 | — | 同单集群 control-plane | 控制面 | 8 核 / 16 GiB |
| workload (a) | infra | 3 | 15.0 / 26.2 | 16 核 / 48 GiB | 1:3 | TopoLVM 729 → **1000** | 同单集群 infra | 日志、监控、Ingress、镜像仓库 | 12 核 / 48 GiB |
| workload (b) | control-plane | 3 | 产品 120 worker 档 | 8 核 / 32 GiB | 1:4 | — | 同单集群 control-plane | 控制面 | 8 核 / 16 GiB |
| workload (b) | ingress | 2 | 5.5 / 4.0 | 8 核 / 16 GiB | 1:2 | — | 系统盘 100 / containerd 150 / kubelet 100 / `/var/cpaas` 100 | Ingress | 4 核 / 8 GiB |
| workload (b) | monitor | 3 | 10.1 / 14.5 | 12 核 / 24 GiB | 1:2 | TopoLVM 63 → **100** | 同 ingress | 监控 | 12 核 / 48 GiB |
| workload (b) | log | 3 | 8.3 / 18.2 | 12 核 / 48 GiB | 1:4 | TopoLVM 577 → **1000** | 同 ingress | 日志 | 12 核 / 48 GiB |
| workload（有存储需求时） | storage | 3 | 8.6 / 14.5 | 12 核 / 24 GiB | 1:2 | OSD ≥ 500 → **500**；`/var/lib/rook` 约 50 → **100** | 同 ingress | Ceph | 待定 |

- 日志按 5,000 条/秒、保留 7 天规划。客户日志量更大时，由客户自行扩容磁盘。
- 磁盘在集群创建后不能再改，创建前要按上表一次定好。
- 表中是每台的最低建议规格。物理机通常远大于此，按不低于本表的规格选型即可。

---

## 2. 每个节点池

### 单集群 control-plane：16 核 / 32 GiB

- 跑平台核心组件，外加只在 global 上的监控 API（Observability Essentials）和日志查询（Log Essentials），以及每个节点都有的日志采集器等 DaemonSet。
- 产品对单集群控制面推荐 16 核 / 32 GB。核心组件的最低要求 8 核 / 16 GB，加上扩展插件、DaemonSet 和平台自用的 Ingress Gateway，每台约 14.0 核 / 22.5 GiB，16 核 / 32 GiB 是装得下的最小一档。
- `/var/cpaas` 200 GiB 是产品推荐值，用于存放 etcd 本地备份、日志采集缓冲和审计数据。etcd 盘 20 GiB 按产品推荐值，建议用高 IO 的独立盘。

### 单集群 infra：16 核 / 48 GiB（workload (a) 的 infra 与此相同）

- 跑日志（ClickHouse、Kafka 和日志管线）、监控（VictoriaMetrics，Medium 档）、Ingress NGINX 和镜像仓库。
- 产品日志容量页只有「三节点，≤ 20,000 条/秒」一档。我们按 5,000 条/秒规划，直接按这一档的 limits 求和会高估 CPU。
- 日志栈的 CPU 看起来多，主要是因为 Pod 多：ClickHouse、Keeper、Kafka、KRaft、aggregate-vector、Razor 和各个 operator 各有 limits。单个组件的配比大约是 1 核 : 2 GiB，内存才是要留余量的地方，所以内存保留 48 GiB。
- 按产品参考值，每台约需 17.7 核；按 5,000 条/秒下调日志组件后，约 15.0 核，取 16 核。这是估算，产品没有 5,000 条/秒的档位数据，估算方法见 §6.3。
- TopoLVM 数据盘：需求约 729 GiB，即 ClickHouse 305 GiB（5,000 条/秒 × 7 天，1 分片 3 副本，每台存一份全量）+ Kafka 161 GiB（保留 48 小时，zstd 压缩）+ 镜像仓库 100 GiB + 监控 26 GiB + Keeper 与 KRaft 15 GiB，再留 20% 余量；取 1000 GiB。

### global control-plane：16 核 / 32 GiB

- 与单集群控制面相同的组件，但不跑业务。
- 对应产品 global 资源评估的 Medium 档（纳管不超过 50 个集群）。纳管更多集群时，按产品的 Large 档（24 核 / 48 GB）重新评估。
- 平台自用的 Ingress Gateway 在控制面上，仍按 Medium 档取 16 核 / 32 GiB。产品档位是否已包含这个 Gateway，文档没有写明；即使不包含，按 3 × 1 核 / 1 GiB 叠加后每台约 14.0 核 / 22.5 GiB，16 核 / 32 GiB 仍够用。

### global infra：16 核 / 32 GiB

- 只跑 global 自己的日志和监控。比单集群 infra 少了业务 Ingress 和镜像仓库；监控只管 global 自己的 6 个节点，用 Small 档；日志量也远小于单集群。平台自用的 Ingress Gateway 在控制面上，不计入 infra。
- 估算每台约 10.8 核 / 22.3 GiB。12 核 / 32 GiB 不是常见配比（1:2.7）；12 核的常见机型是 24 或 48 GiB，24 GiB 不够（占用会超过 85%），48 GiB 又多出一倍。所以取 16 核 / 32 GiB，与 global control-plane 用同一机型，CPU 占用约 68%，内存约 81%。
- 备选：12 核 / 48 GiB（1:4），CPU 占用约 91%。
- 前提：workload 集群的日志不汇聚到 global。客户要把日志集中到 global 时，需要重新评估。
- TopoLVM 数据盘：需求约 609 GiB（日志与单集群相同：ClickHouse 305 + Kafka 161 + Keeper、KRaft 15，加监控 26，再留 20% 余量；没有镜像仓库），取 1000 GiB。

### workload (a) control-plane：8 核 / 32 GiB

- 产品给 24 个 worker 的控制面是 4 核 / 16 GB，而且只算了 Core 组件。加上扩展插件和 DaemonSet，每台约 6.7 核 / 18.9 GiB，超出 16 GB，所以取产品下一档 8 核 / 32 GB。

### workload (b) control-plane：8 核 / 32 GiB

- 直接套用产品 120 个 worker 的控制面档位（8 核 / 32 GB）。产品没有 150 个 worker 的档位，安装后按控制面负载评估，需要时扩容。

### workload (b) ingress：8 核 / 16 GiB

- 2 台，每台 1 个 Ingress NGINX controller。按每个 controller 约 4,000 请求/秒的标准载荷，每台约需 5.5 核 / 4.0 GiB。8 GiB 内存已经够用，但 8 核 / 8 GiB（1:1）不是常见机型，取 8 核 / 16 GiB。
- 业务请求量在 1,000 请求/秒以下时，4 核 / 8 GiB 也够。
- 没有数据盘。

### workload (b) monitor：12 核 / 24 GiB

- 只跑监控（VictoriaMetrics，3 副本）。按 150 个 worker 外推，每台约需 10.1 核 / 14.5 GiB，取 12 核 / 24 GiB。
- 产品监控容量页里，Large 档（500 个 worker）的数据面三个组件合计只要 9 核 / 9.2 GB，所以 48 GiB 内存远多于需要。
- TopoLVM 数据盘：监控默认保留 7 天，产品建议的容量至少 30 GiB；按 150 个 worker 取容量 60（vmstorage 45 + Alertmanager 7.5），需求约 63 GiB，取 100 GiB。

### workload (b) log：12 核 / 48 GiB

- 只跑日志栈，组件和估算方法与单集群 infra 的日志部分相同。每台约需 8.3 核 / 18.2 GiB：CPU 超过 8 核，取 12 核。
- 12 核 / 24 GiB 时内存占用会超过 85%；12 核 / 32 GiB 不是常见配比。日志组件吃内存，所以取 12 核 / 48 GiB（1:4），CPU 占用约 70%，内存约 47%。
- 备选：16 核 / 32 GiB（1:2），与 global infra 同一机型。
- TopoLVM 数据盘：需求约 577 GiB（ClickHouse 305 + Kafka 161 + Keeper、KRaft 15，再留 20% 余量），取 1000 GiB。
- 日志超过约 20,000 条/秒时，产品的下一档是 6 个 ClickHouse 节点，这个池要扩到 6 台。

---

## 3. workload (b) 拆成 3 个池为什么多了

日志栈在两档里用的是同一组取值，并不是 (b) 取了更大的档位。多出来的部分来自监控、DaemonSet 和取整。

| 档位 | 日志 | 监控 | Ingress | 镜像仓库 | TopoLVM | DaemonSet | 合计需求 | 取整余量（含系统预留） | 配置合计 |
|---|---|---|---|---|---|---|---|---|---|
| (a) 约 20 worker，infra 3 台 | 16.6 / 45.6 | 11.9 / 17.8 | 6.5 / 3.5 | 1.7 / 2.5 | 1.4 / 2.1 | 6.9 / 7.0 | 45.0 / 78.5 | 3.0 / 65.5 | **48 / 144** |
| (b) 约 150 worker，ingress 2 + monitor 3 + log 3 | 16.6 / 45.6 | 22.1 / 34.5 | 6.5 / 3.5 | — | 2.8 / 4.3 | 18.3 / 18.5 | 66.3 / 106.4 | 33.7 / 93.6 | **100 / 200** |
| 差 | 0 | +10.2 / +16.7 | 0 | −1.7 / −2.5 | +1.4 / +2.1 | +11.4 / +11.6 | +21.3 / +27.9 | +30.7 / +28.1 | **+52 / +56** |

单位：核 / GiB，按集群合计。

- **日志**：两档相同，都按 5,000 条/秒估算。
- **监控**：(b) 按 150 个 worker、3 副本外推，从约 12 核增到约 22 核。
- **DaemonSet**：日志采集器、node-exporter 等每台常驻约 2.3 核。(b) 多 5 台，约多 11.4 核。
- **取整余量**：每个池单独按常见机型取整，3 个池的余量加起来比 1 个池大，约多 30.7 核。其中 ingress、log 两个池为了落在常见配比上，又多取了一些。
- **镜像仓库**：(b) 档放在哪个池还没定，没有计入。
- (a) 约 20 个 worker，(b) 约 150 个 worker，两者不是同一规模的两种拆法。

---

## 4. PR 上规格问题的回答

| 问题 | 结论 | 详见 |
|---|---|---|
| 单集群 infra 12 核不对吧？应该是 16 核？ | 12 核不够。按 5,000 条/秒估算，每台约 15.0 核，取 16 核。 | §2 单集群 infra；§6.3 |
| 20 核太多；日志组件是高内存而不是高 CPU？16 核 / 48 GiB 是否更合理？ | 同意 16 核 / 48 GiB。产品日志容量页只有 20,000 条/秒一档，按 5,000 条/秒下调日志组件后每台约 15.0 核。日志栈 CPU 多是因为 Pod 多，单组件约 1 核 : 2 GiB，余量留在内存上。 | §2 单集群 infra；§6.3 |
| global infra 少了 Ingress，为什么 CPU 反而更高、内存少这么多？ | 已改为 global infra 16 核 / 32 GiB（需求 10.8 核 / 22.3 GiB），单集群和 workload (a) 的 infra 16 核 / 48 GiB，不再倒挂。 | §2 global infra |
| global infra 能否要求低一点，16 核 / 32 GiB 还是 12 核 / 32 GiB？取值要考虑实际机型 | 每台需求约 10.8 核 / 22.3 GiB（平台 Ingress Gateway 在控制面上）。12 核 / 32 GiB 不是常见配比，取 16 核 / 32 GiB，与 global control-plane 同一机型；备选 12 核 / 48 GiB。前提是 workload 的日志不汇聚到 global。所有规格已按常见机型和 1:2、1:3、1:4 的配比取值。 | §2 global infra；§6.1 |
| workload (a) 的 infra 理论上应该和单集群一样？ | 是。两者装的组件相同，都取 16 核 / 48 GiB。 | §2 单集群 infra |
| monitor 真需要 12 核 / 48 GiB？ | 不需要这么多内存。每台约 10.1 核 / 14.5 GiB，取 12 核 / 24 GiB。 | §2 workload (b) monitor |
| ingress、monitor、log 的资源对不对？ | ingress 8 核 / 16 GiB（轻载 4 核 / 8 GiB），monitor 12 核 / 24 GiB，log 12 核 / 48 GiB。 | §2 workload (b) 各池 |
| 拆成 3 个池后，资源总计为什么多了不少？ | 日志两档取值相同。多出的部分来自监控（+10.2 核）、5 台多出的 DaemonSet（+11.4 核）和每个池单独按常见机型取整（+30.7 核），合计多 52 核 / 56 GiB。(b) 的规模也是 (a) 的 7 倍多。 | §3 |
| 磁盘要多大、为什么？ | 各池逐块列在总表里。平台盘按产品推荐值，各池几乎相同；差别全部来自 TopoLVM 数据盘，日志占大头。 | §1；§6.5 |

---

## 5. workload 集群内的中小规模 Ceph

workload 集群有存储需求时，在该集群内部署：

| 项 | 建议 |
|---|---|
| 节点 | 3 台，分属 3 个故障域 |
| 每台数据盘 | 1 块 SSD，≥ 500 GiB；3 副本，可用容量约为裸容量的 1/3 |
| Ceph 组件资源合计（RBD + RGW） | 18.7 核 / 36.7 GiB，每台约 6.3 核 / 12.2 GiB |
| 节点池 | 专用的 storage 节点池，不与 infra、worker 共用 |
| 每台规格 | 12 核 / 24 GiB（Ceph 6.3 核 / 12.2 GiB + DaemonSet 2.3 / 2.3，需求约 8.6 核 / 14.5 GiB） |
| 每台磁盘 | OSD 裸盘 500 GiB；`/var/lib/rook` 持久盘 100 GiB（MON 和 Rook 数据，产品要求放在持久盘上）；平台盘同 ingress |

和 OpenShift Data Foundation 比：ODF 的最小部署要 24 CPU / 72 GiB，标准部署要 30 CPU / 72 GiB（都是 3 个节点的合计）。这里的 18.7 核 / 36.7 GiB 低于这两档。

---

## 6. 计算方法与依据

### 6.1 口径

| 项 | 取值 | 说明 |
|---|---|---|
| CPU、内存 | 各组件 limits 求和，假设 requests = limits | 产品容量页给的都是 limits |
| 机型取值 | CPU：4 / 8 / 12 / 16 / 24 / 32 核；内存：8 / 16 / 24 / 32 / 48 / 64 GiB；配比 1:2、1:3、1:4 | 按常见虚拟机规格取值，不用 20 核或 1:1 这类少见机型 |
| 机型选择 | 同时满足 CPU、内存规则的机型中选成本相近、最贴近需求的一种；成本相近时，日志为主的池优先多给内存，其他池优先与同集群已有机型一致 | |
| 数据盘 | 100 / 200 / 300 / 500 / 1000 / 2000 GiB 中不小于需求的最小一档 | 平台盘按产品推荐值，不取整 |
| CPU 取档 | 取「每台需求 + 0.1 核系统预留」之上最小的一档 | CPU 可压缩 |
| 内存取档 | 取「每台需求 + 系统预留」不超过该档 85% 的最小一档 | 内存不可压缩，超限会 OOM |
| 系统预留（内存） | 前 4 GiB 取 25%、再 4 GiB 取 20%、再 8 GiB 取 10%、其余取 6% | 通用的 kubelet 预留公式，不是 ACP 的配置值 |
| 多副本 | 副本数 ≥ 2 的组件每台放 1 个，每台需求 = 合计 ÷ 台数 | |
| DaemonSet | 每台 2.25 核 / 2.28 GiB；有 TopoLVM 盘的节点另加 0.05 / 0.05。global 没有 MetalLB 和业务镜像仓库，每台 2.10 核 / 2.12 GiB | 日志采集器 1.6 核 / 1.6 GiB（需按此覆盖默认值）、node-exporter、Kube-OVN、MetalLB speaker、镜像仓库 node-ca。参考值（无公开文档） |
| 日志组件 | 内存取产品参考值；CPU 按 5,000 条/秒下调，见 §6.3 | 产品日志容量页写明 *Provision more resources than the reference numbers* |
| 监控档位 | 单集群、workload (a) 取 Medium（50 worker），global 取 Small，workload (b) 按 150 worker 外推 | 产品档位：Small 10、Medium 50、Large 500 worker |
| 一台节点故障 | 不按「剩余节点接管全部」放大 | 有状态组件绑本地卷，靠 3 副本多数派降级运行 |
| 日志数据盘 | 5,000 条/秒、保留 7 天 | |

### 6.2 逐组件表（单集群 infra，3 台合计）

| 组件 | 副本 | 产品参考值（每副本） | 本方案（每副本） | 合计 | 依据 |
|---|---:|---|---|---|---|
| ClickHouse server | 3 | 2 核 / 4 GiB | 1 核 / 4 GiB | 3 / 12 | 日志容量页参考值；CPU 按 §6.3 下调 |
| Kafka broker | 3 | 2 核 / 4 GiB | 1 核 / 4 GiB | 3 / 12 | 同上 |
| aggregate-vector | 2 | 2 核 / 4 GiB | 1 核 / 4 GiB | 2 / 8 | 同上 |
| Razor | 2 | 1 核 / 1 GiB | 1 核 / 1 GiB | 2 / 2 | 日志容量页参考值 |
| ClickHouse Keeper | 3 | — | 1 核 / 1.5 GiB | 3 / 4.5 | 参考值（无公开文档） |
| Kafka KRaft controller | 3 | — | 0.5 核 / 1.5 GiB | 1.5 / 4.5 | 参考值（无公开文档） |
| ClickHouse operator、Kafka entity operator、Strimzi operator、日志存储 operator ×2 | — | — | — | 2.1 / 2.6 | 参考值（无公开文档） |
| **日志小计** | | | | **16.6 / 45.6**（按参考值为 24.6 / 45.6） | |
| VictoriaMetrics（Medium，3 副本，含 vmstorage、vmselect、vminsert、vmagent、vmalert、Alertmanager、operator 和辅助组件） | | | | **11.9 / 17.8** | 参考值（无公开文档）；产品监控容量页只给单副本值 |
| Ingress NGINX controller | 2 | — | 3 核 / 1.5 GiB | 6 / 3 | 参考值（无公开文档），按每个约 4,000 请求/秒；产品只给 200m / 256Mi 示例 |
| Ingress operator | 1 | — | 0.5 核 / 0.5 GiB | 0.5 / 0.5 | 参考值（无公开文档） |
| 镜像仓库（operator、image-registry、image-api-server ×2） | | | | 1.7 / 2.5 | image-registry 按产品示例 500m / 500Mi 加倍；其余为参考值（无公开文档） |
| TopoLVM（operator、controller ×2、node ×3） | | | | 1.4 / 2.1 | 参考值（无公开文档） |
| DaemonSet × 3 台 | | | | 6.9 / 7.0 | 见 §6.1 |
| **3 台合计** | | | | **45.0 / 78.5** | |

### 6.3 日志组件 CPU 的估算方法（5,000 条/秒）

产品日志容量页（ClickHouse 后端）的档位：

| 档位 | 吞吐 | ClickHouse | Kafka broker | Razor | aggregate-vector |
|---|---|---|---|---|---|
| 单节点（仅评估） | ~18,000 条/秒 | 1 × 2 核 / 4 GB | 1 × 2 核 / 4 GB | 1 × 1 核 / 1 GB | 1 × 2 核 / 4 GB |
| 三节点 | ~20,000 条/秒 | 3 × 2 核 / 4 GB | 3 × 2 核 / 4 GB | 2 × 1 核 / 1 GB | 2 × 2 核 / 4 GB |

- **观察**：单节点档里，每个组件 1 个 2 核的 Pod 就能承载约 18,000 条/秒；三节点档每个 Pod 还是 2 核，多出的是高可用副本，而 1 分片 3 副本下每个副本都要写入全量。所以每个 Pod 的 CPU 主要由吞吐决定，2 核大约对应 18,000 条/秒。
- **方法**：数据通路上的 Pod（ClickHouse、Kafka broker、aggregate-vector、Razor，共 10 个）按吞吐比例折算：5,000 ÷ 18,000 ≈ 28%，即每个 2 核的 Pod 预计用约 0.56 核。留约 2 倍余量，limit 取 1 核，并且不高于产品参考值（Razor 本来就是 1 核，不变）。
- **不下调的部分**：Keeper、KRaft controller 和各 operator 与吞吐无关，保持原值；所有日志组件的内存都保持产品参考值。
- **结果**：日志栈 CPU 从 24.6 核降到 16.6 核（3 台合计），内存不变，仍是 45.6 GiB。
- **假设**：CPU 与吞吐近似成正比；单节点档的吞吐可以代表单个 Pod 的能力。产品没有 5,000 条/秒的档位，这是估算，上线后应按实际用量校准。

### 6.4 推导

```
单集群 infra / workload (a) infra
  合计 45.0 核 / 78.5 GiB ÷ 3 = 每台 15.0 核 / 26.2 GiB
  CPU 15.0 + 0.1 → 16 核（94%）
  内存 26.2 + 预留 3.6（32 GiB 档）= 29.7，占 93% > 85% → 48 GiB（26.2 + 4.5 = 30.7，占 64%）
  对照：日志按产品参考值时每台 17.7 核，按机型取值会到 24 核

global infra
  日志 16.6 / 45.6 + 监控 Small 7.9 / 12.6
  + TopoLVM 1.4 / 2.1 + DaemonSet 3 × (2.10 + 0.05) / 3 × (2.12 + 0.05) = 32.4 核 / 66.9 GiB
  ÷ 3 = 每台 10.8 核 / 22.3 GiB
  CPU 10.8 + 0.1 → 12 核（91%）；内存 22.3 + 3.6 = 25.8 → 32 GiB（81%）
  12 核 / 32 GiB 配比 1:2.7 不常见 → 16 核 / 32 GiB（68% / 81%），备选 12 核 / 48 GiB（91% / 56%）
  平台 Ingress Gateway（3 × 1 核 / 1 GiB）在 control-plane 上，不计入

workload (b) log
  日志 16.6 / 45.6 + TopoLVM 1.4 / 2.1 + DaemonSet 3 × 2.30 / 3 × 2.33 = 24.9 核 / 54.7 GiB
  ÷ 3 = 每台 8.3 核 / 18.2 GiB
  CPU 8.3 + 0.1 > 8 → 12 核（70%）
  内存 18.2 + 3.1（24 GiB 档）= 21.3，占 89% > 85%；12 核 / 32 GiB 配比 1:2.7 不常见
  → 12 核 / 48 GiB（70% / 47%），备选 16 核 / 32 GiB（52% / 68%）

workload (b) monitor（推断）
  监控按 150 worker 外推 22.1 / 34.5 + TopoLVM、DaemonSet 8.3 / 9.1
  ÷ 3 = 每台 10.1 核 / 14.5 GiB → 12 核（85%）；14.5 + 3.1 = 17.6，占 73% → 24 GiB
  上限校验：产品 Large 档（500 worker）数据面 vmselect 5 核 / 3 GB + proxy 2 核 / 0.2 GB + vmstorage 2 核 / 6 GB = 9 核 / 9.2 GB（单副本）

workload (b) ingress
  controller 2 × 3 核 / 1.5 GiB + operator 0.5 / 0.5 = 6.5 / 3.5，2 台各 3.25 / 1.75
  + DaemonSet 2.25 / 2.28 = 每台 5.5 核 / 4.0 GiB → 8 核（70%）；4.0 + 1.8 = 5.8 → 8 GiB 够用
  8 核 / 8 GiB 配比 1:1 不常见 → 8 核 / 16 GiB（70% / 41%）
  轻载（每个 controller 1 核）：3.5 核 / 3.5 GiB → 4 核 / 8 GiB

control-plane
  单集群 / global：核心最低 8 核 / 16 GB + 扩展（监控 API、日志查询、存储 operator、MetalLB controller、
    keepalived、日志采集 operator）8.35 核 / 9.8 GiB ÷ 3 + DaemonSet 2.25 / 2.28
    = 每台约 13.0 核 / 21.5 GiB → 产品推荐 16 核 / 32 GB
    平台 Ingress Gateway 若不在产品档位内，再加每台 1 核 / 1 GiB：14.0 核 / 22.5 GiB，16 核（88%）/ 32 GiB（81%）仍够用
    总表按含 Gateway 的 14.0 核 / 22.5 GiB 列需求
  workload (a)：产品 24 worker 档 4 核 / 16 GB + 扩展 0.45 / 0.6 + DaemonSet 2.25 / 2.28
    = 6.7 核 / 18.9 GiB；内存在 24 GiB 档占 92% → 产品下一档 8 核 / 32 GB
  workload (b)：直接取产品 120 worker 档 8 核 / 32 GB
```

括号里是 CPU 或内存在该档的占用比例。扩展插件和 DaemonSet 的数值为参考值（无公开文档）。

### 6.5 数据盘

**公式**

- ClickHouse 每台 = 条/秒 × 每条字节 × 86,400 × 保留天数 ÷ 压缩比 × 1.3（合并余量）。1 分片 3 副本，每个副本存全量。
- Kafka 每台 = 条/秒 × 每条字节 × 86,400 × 保留小时 ÷ 24 ÷ 压缩比 × 1.2。3 副本，每个 broker 存全量。
- 卷组 = 各 PVC 之和 × 1.2，再取 100 / 200 / 300 / 500 / 1000 / 2000 GiB 中不小于它的最小一档。

**取值**

| 项 | 取值 | 依据 |
|---|---|---|
| 条/秒 | 5,000 | 口径 |
| 每条日志 | 500 B | 参考值（无公开文档） |
| ClickHouse 保留 | 7 天 | 口径 |
| ClickHouse 压缩比 | 6 | 参考值（无公开文档）；上线 48 小时后用 `system.parts` 实测 |
| Kafka 保留 | 48 小时 | 产品日志安装示例 `retention.ms: 172800000` |
| Kafka 压缩比 | 3，要求 topic 设 `compression.type: zstd` | 参考值（无公开文档）；不压缩时 Kafka 盘约为 3 倍 |
| Keeper / KRaft | 每台 10 / 5 GiB | ClickHouse Keeper 部署页：10 GiB 足够；日志安装示例中 KRaft 为 5 GiB |
| 监控 | 单集群、global、workload (a)：26 GiB；workload (b)：容量 60，卷组 100 GiB | 产品：默认保留 7 天，容量至少 30 GiB |
| 镜像仓库 | 100 GiB，单副本 | 产品 Registry 示例 100 GiB |

**算例**

```
ClickHouse = 5000 × 500 × 86400 × 7 ÷ 6 × 1.3 ÷ 2^30 = 305 GiB
Kafka      = 5000 × 500 × 86400 × 2 ÷ 3 × 1.2 ÷ 2^30 = 161 GiB
单集群 / workload (a) infra = (305 + 161 + 10 + 5 + 26 + 100) × 1.2 = 729 → 1000 GiB
global infra                = (305 + 161 + 10 + 5 + 26) × 1.2       = 609 → 1000 GiB
workload (b) log            = (305 + 161 + 10 + 5) × 1.2            = 577 → 1000 GiB
workload (b) monitor        = (45 + 7.5) × 1.2                      =  63 → 100 GiB
```

每增加 1,000 条/秒，ClickHouse 每台约多 61 GiB，Kafka 约多 32 GiB（7 天、48 小时口径）。

**平台盘**

| 盘 | 取值 | 依据 |
|---|---|---|
| 系统盘 | 100 GiB | 产品推荐 100 GB，利用率保持在 80% 以下 |
| containerd | 150 GiB | 产品推荐值 |
| kubelet | 100 GiB | 产品最低值（未给推荐值） |
| etcd（只 control-plane） | 20 GiB，高 IO 独立盘 | 产品推荐值 |
| `/var/cpaas` | control-plane 200 GiB；其他池 100 GiB | control-plane 取产品推荐值，用于 etcd 本地备份、日志采集缓冲、审计。其他池的有状态数据在 TopoLVM 数据盘上，100 GiB 足够容纳日志采集缓冲（参考值 ≤ 60 GiB）；产品最低要求 40 GB |

### 6.6 Ceph

- 组件资源按插件默认 balanced 档逐个求和：OSD 3 × 3 核 / 5 GiB、MON 3 × 1 核 / 2 GiB、MGR、RGW、CSI 等，合计 RBD + RGW 18.7 核 / 36.7 GiB。参考值（无公开文档）。只用 RBD 时为 14.7 核 / 30.7 GiB。
- OSD 盘取 500 GiB：ODF 要求每块至少 0.5 TiB；可用容量约为裸容量的 1/3，按存储需求增加 OSD 盘。
- `/var/lib/rook` 取 100 GiB：产品要求 MON 和 Rook 数据放在持久文件系统上，但没有给大小；按每个 MON 约 50 GiB 取整。参考值（无公开文档）。
- 产品 Ceph 规划页给出的 4 节点聚合预算（最低 32 CPU / 96 GiB）高于 ODF 的最小部署，这里不采用。

### 6.7 出处

| 内容 | 页面 |
|---|---|
| 单集群控制面推荐 16 核 / 32 GB；ARM 规则 | acp-docs `docs/en/install/prepare/planning.mdx` → https://docs.alauda.io/container_platform/4.5/install/prepare/planning.html#machines |
| global 档位 Small / Medium / Large | `docs/en/configure/scalability/evaluating_global.mdx` → https://docs.alauda.io/container_platform/4.5/configure/scalability/evaluating_global.html |
| workload 控制面 24 / 120 / 254 worker 档，「仅 Core」 | `docs/en/configure/scalability/evaluating_workload.mdx` → https://docs.alauda.io/container_platform/4.5/configure/scalability/evaluating_workload.html |
| 磁盘分区推荐值 | `docs/en/configure/scalability/disk_configuration.mdx` → https://docs.alauda.io/container_platform/4.5/configure/scalability/disk_configuration.html |
| 磁盘创建后不能改 | `docs/en/workload_clusters/alauda_os/index.mdx` → https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/#fixed-at-creation |
| 监控各档组件 limits、磁盘 | `docs/en/observability/monitor/architecture/capacity_planning.mdx` → https://docs.alauda.io/container_platform/4.5/observability/monitor/architecture/capacity_planning.html |
| 监控默认保留 7 天、容量至少 30 Gi | `docs/en/observability/monitor/install_monitor.mdx` → https://docs.alauda.io/container_platform/4.5/observability/monitor/install_monitor.html#acp-monitoring-with-victoriametrics |
| Ingress NGINX 资源示例 | `docs/en/networking/operators/ingress_nginx_operator.mdx` → https://docs.alauda.io/container_platform/4.5/networking/operators/ingress_nginx_operator.html |
| 镜像仓库资源与存储示例 | `docs/en/configure/registry/setting_up_and_configuring_the_registry.mdx` → https://docs.alauda.io/container_platform/4.5/configure/registry/setting_up_and_configuring_the_registry.html |
| etcd 本地备份 | `docs/en/configure/backup/etcd.mdx` → https://docs.alauda.io/container_platform/4.5/configure/backup/etcd.html |
| Ceph 规划 | `docs/en/storage/storagesystem_ceph/planning.mdx` → https://docs.alauda.io/container_platform/4.5/storage/storagesystem_ceph/planning.html |
| Ceph 在 Alauda OS 上的持久盘要求（`/var/lib/rook`、OSD 裸盘） | `docs/en/storage/storagesystem_ceph/installation/immutable_infrastructure_prerequisites.mdx` → https://docs.alauda.io/container_platform/4.5/storage/storagesystem_ceph/installation/immutable_infrastructure_prerequisites.html |
| 日志各档位（单节点、三节点）、*Provision more resources than the reference numbers* | https://docs.alauda.io/logging-service/4.4/architecture/capacity_planning.html |
| Kafka 保留 48 小时、KRaft 5 GiB 示例 | https://docs.alauda.io/logging-service/4.4/install/ |
| ClickHouse 日志配方（1 分片 3 副本） | https://docs.alauda.io/clickhouse/4.4/how_to/deploy_as_logging_storage.html |
| ClickHouse Keeper（每成员 10 GiB） | https://docs.alauda.io/clickhouse/4.4/how_to/deploy_keeper_quorum.html |
| OpenShift Data Foundation 资源要求 | https://docs.redhat.com/en/documentation/red_hat_openshift_data_foundation/4.20/html-single/planning_your_deployment/index |

acp-docs 路径以 `release-4.5` 分支为准。

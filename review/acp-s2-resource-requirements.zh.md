# ACP 4.5 标准交付：各节点池资源需求（review 用，合并前删除）

本文件只用于 review《ACP 4.5 + Alauda OS 标准交付》的资源规格，不是发布文章，合并前删除。

- CPU、内存按各组件的 limits 求和，并假设部署时 requests = limits。
- 日志数据盘按 5,000 条/秒、保留 7 天计算。
- 只算平台节点池；业务 worker 由业务决定，不在此列。
- 所有规格都是建议值。怎么算的、依据是什么，见文末「计算方法与依据」。

---

## 1. 总表

磁盘单位 GiB，每台。

| 集群 | 节点池 | 台数 | CPU | 内存 | 磁盘（每台） | 主要占用 | 文章现值 |
|---|---|---:|---:|---:|---|---|---|
| 单集群 | control-plane | 3 | 16 核 | 32 GiB | 系统盘 100 / containerd 150 / kubelet 100 / etcd 20 / `/var/cpaas` 200 | 平台核心、监控 API、日志查询 | 16 核 / 32 GiB |
| 单集群 | infra | 3 | **20 核** | 48 GiB | 系统盘 100 / containerd 150 / kubelet 100 / `/var/cpaas` 100 / **TopoLVM 数据盘 750** | 日志、监控、Ingress、镜像仓库 | 12 核 / 48 GiB |
| global | control-plane | 3 | 16 核 | 32 GiB | 系统盘 100 / containerd 150 / kubelet 100 / etcd 20 / `/var/cpaas` 200 | 平台核心、监控 API、日志查询 | 16 核 / 32 GiB |
| global | infra | 3 | 16 核 | **48 GiB** | 系统盘 100 / containerd 150 / kubelet 100 / `/var/cpaas` 100 / **TopoLVM 数据盘 650** | global 自己的日志、监控 | 16 核 / 32 GiB |
| workload (a) | control-plane | 3 | 8 核 | **32 GiB** | 系统盘 100 / containerd 150 / kubelet 100 / etcd 20 / `/var/cpaas` 200 | 控制面 | 8 核 / 16 GiB |
| workload (a) | infra | 3 | **20 核** | 48 GiB | 系统盘 100 / containerd 150 / kubelet 100 / `/var/cpaas` 100 / **TopoLVM 数据盘 750** | 日志、监控、Ingress、镜像仓库 | 12 核 / 48 GiB |
| workload (b) | control-plane | 3 | 8 核 | **32 GiB** | 系统盘 100 / containerd 150 / kubelet 100 / etcd 20 / `/var/cpaas` 200 | 控制面 | 8 核 / 16 GiB |
| workload (b) | ingress | 2 | **8 核** | 8 GiB | 系统盘 100 / containerd 150 / kubelet 100 / `/var/cpaas` 100 | Ingress | 4 核 / 8 GiB |
| workload (b) | monitor | 3 | 12 核 | **24 GiB** | 系统盘 100 / containerd 150 / kubelet 100 / `/var/cpaas` 100 / **TopoLVM 数据盘 100** | 监控 | 12 核 / 48 GiB |
| workload (b) | log | 3 | 12 核 | **32 GiB** | 系统盘 100 / containerd 150 / kubelet 100 / `/var/cpaas` 100 / **TopoLVM 数据盘 600** | 日志 | 12 核 / 48 GiB |

- 加粗的是与文章现值不同的地方。
- 日志数据盘按 5,000 条/秒、保留 7 天计算。客户日志量更大时，由客户自行扩容磁盘。
- 磁盘在集群创建后不能再改，创建前要按上表一次定好。

---

## 2. 每个节点池

### 单集群 control-plane：16 核 / 32 GiB

- 跑平台核心组件，外加只在 global 上的监控 API（Observability Essentials）和日志查询（Log Essentials），以及每个节点都有的日志采集器等 DaemonSet。
- 产品对单集群控制面推荐 16 核 / 32 GB。核心组件的最低要求 8 核 / 16 GB，加上扩展插件和 DaemonSet，每台约 13 核 / 21.5 GiB，16 核 / 32 GiB 是装得下的最小一档。
- `/var/cpaas` 200 GiB 是产品推荐值，用于存放 etcd 本地备份、日志采集缓冲和审计数据。etcd 盘 20 GiB 按产品推荐值，建议用高 IO 的独立盘。

### 单集群 infra：20 核 / 48 GiB（workload (a) 的 infra 与此相同）

- 跑日志（ClickHouse、Kafka 和日志管线）、监控（VictoriaMetrics，Medium 档）、Ingress NGINX 和镜像仓库。
- CPU 每台约需 17.7 核，其中日志栈约占一半（3 台合计 24.6 核），其次是监控 11.9 核、DaemonSet 6.9 核、Ingress 6.5 核。12 核放不下，16 核没有余量，所以取 20 核。
- 内存每台约需 26 GiB，加上系统预留后，32 GiB 正好贴着下限。日志组件取的是产品容量页的参考值，而产品要求实际配置要高于参考值，所以取上一档 48 GiB。
- TopoLVM 数据盘 750 GiB：ClickHouse 305 GiB（5,000 条/秒 × 7 天，1 分片 3 副本，每台存一份全量）+ Kafka 161 GiB（保留 48 小时，zstd 压缩）+ 镜像仓库 100 GiB + 监控 26 GiB + Keeper 与 KRaft 15 GiB，再留 20% 余量。

### global control-plane：16 核 / 32 GiB

- 与单集群控制面相同的组件，但不跑业务。
- 对应产品 global 资源评估的 Medium 档（纳管不超过 50 个集群）。纳管更多集群时，按产品的 Large 档（24 核 / 48 GB）重新评估。

### global infra：16 核 / 48 GiB

- 只跑 global 自己的日志和监控；监控用 Small 档，因为 global 只监控自身的 6 个节点。没有业务 Ingress，但平台自用的 Ingress Gateway 按落在 infra 上计算。
- CPU 每台约需 14.6 核，取 16 核。内存每台约需 23.4 GiB，按和单集群 infra 相同的原则（日志参考值是下限）取 48 GiB。
- TopoLVM 数据盘 650 GiB：日志与单集群相同（ClickHouse 305 + Kafka 161 + Keeper、KRaft 15）+ 监控 26 GiB，再留 20% 余量；没有镜像仓库。

### workload (a) control-plane：8 核 / 32 GiB

- 产品给 24 个 worker 的控制面是 4 核 / 16 GB，而且只算了 Core 组件。加上扩展插件和 DaemonSet，每台约 6.7 核 / 18.9 GiB，超出 16 GB，所以取产品下一档 8 核 / 32 GB。

### workload (b) control-plane：8 核 / 32 GiB

- 直接套用产品 120 个 worker 的控制面档位（8 核 / 32 GB）。产品没有 150 个 worker 的档位，安装后按控制面负载评估，需要时扩容。

### workload (b) ingress：8 核 / 8 GiB

- 2 台，每台 1 个 Ingress NGINX controller。按每个 controller 约 4,000 请求/秒的标准载荷，每台约需 5.5 核 / 4 GiB，取 8 核 / 8 GiB。
- 业务请求量在 1,000 请求/秒以下时，4 核 / 8 GiB 也够。
- 没有数据盘。

### workload (b) monitor：12 核 / 24 GiB

- 只跑监控（VictoriaMetrics，3 副本）。按 150 个 worker 外推，每台约需 10.1 核 / 14.5 GiB，取 12 核 / 24 GiB。
- 产品监控容量页里，Large 档（500 个 worker）的数据面三个组件合计只要 9 核 / 9.2 GB，所以 48 GiB 内存远多于需要。
- TopoLVM 数据盘 100 GiB：监控默认保留 7 天，产品建议的容量至少 30 GiB，这里按 150 个 worker 放大并留余量。

### workload (b) log：12 核 / 32 GiB

- 只跑日志栈，组件与单集群 infra 里的日志部分相同。每台约需 11.0 核 / 18.2 GiB，CPU 取 12 核；内存按日志参考值是下限的原则取上一档 32 GiB。
- TopoLVM 数据盘 600 GiB：ClickHouse 305 + Kafka 161 + Keeper、KRaft 15，再留 20% 余量。
- 日志超过约 20,000 条/秒时，产品的下一档是 6 个 ClickHouse 节点，这个池要扩到 6 台。

---

## 3. PR 上规格问题的回答

| 问题 | 结论 | 详见 |
|---|---|---|
| 单集群 infra 12 核不对吧？应该是 16 核？ | 12 核和 16 核都不够。每台约需 17.7 核，日志栈占一半，取 20 核。 | §2 单集群 infra；§5.3 |
| global infra 少了 Ingress，为什么 CPU 反而更高、内存少这么多？ | 文章原值这一对本身有矛盾。按组件求和，global infra 每台 14.6 核 / 23.4 GiB，workload infra 每台 17.7 核 / 26.2 GiB，workload 两项都更高。现在 global infra 取 16 核 / 48 GiB，workload infra 取 20 核 / 48 GiB。 | §2 global infra；§5.3 |
| workload (a) 的 infra 理论上应该和单集群一样？ | 是。两者装的组件相同，都取 20 核 / 48 GiB。 | §2 单集群 infra |
| monitor 真需要 12 核 / 48 GiB？ | 不需要这么多内存。每台约 10.1 核 / 14.5 GiB，取 12 核 / 24 GiB。 | §2 workload (b) monitor |
| ingress、monitor、log 的资源对不对？ | ingress 8 核 / 8 GiB（轻载 4 核 / 8 GiB），monitor 12 核 / 24 GiB，log 12 核 / 32 GiB。 | §2 workload (b) 各池 |
| 磁盘要多大、为什么？ | 各池逐块列在总表里。平台盘按产品推荐值，各池几乎相同；差别全部来自 TopoLVM 数据盘，日志占大头。 | §1；§5.4 |

---

## 4. workload 集群内的中小规模 Ceph

workload 集群有存储需求时，在该集群内部署：

| 项 | 建议 |
|---|---|
| 节点 | 3 台，分属 3 个故障域 |
| 每台数据盘 | 1 块 SSD，≥ 500 GiB；3 副本，可用容量约为裸容量的 1/3 |
| Ceph 组件资源合计（RBD + RGW） | 18.7 核 / 36.7 GiB，每台约 6.3 核 / 12.2 GiB |
| 用专用节点时每台 | 12 核 / 24 GiB（含 DaemonSet 和系统预留） |

和 OpenShift Data Foundation 比：ODF 的最小部署要 24 CPU / 72 GiB，标准部署要 30 CPU / 72 GiB（都是 3 个节点的合计）。这里的 18.7 核 / 36.7 GiB 低于这两档。

---

## 5. 计算方法与依据

### 5.1 口径

| 项 | 取值 | 说明 |
|---|---|---|
| CPU、内存 | 各组件 limits 求和，假设 requests = limits | 产品容量页给的都是 limits |
| 多副本 | 副本数 ≥ 2 的组件每台放 1 个，每台需求 = 合计 ÷ 台数 | |
| DaemonSet | 每台 2.25 核 / 2.28 GiB；有 TopoLVM 盘的节点另加 0.05 核 / 0.05 GiB | 日志采集器 1.6 核 / 1.6 GiB（需按此覆盖默认值）、node-exporter、Kube-OVN、MetalLB speaker、镜像仓库 node-ca。参考值（无公开文档） |
| 系统预留 | 内存按「前 4 GiB 取 25%、再 4 GiB 取 20%、再 8 GiB 取 10%、其余取 6%」，CPU 约 0.1 核 | 通用的 kubelet 预留公式，不是 ACP 的配置值 |
| 取整 | CPU 取 4 / 8 / 12 / 16 / 20 / 24 / 32，内存取 8 / 16 / 24 / 32 / 48 / 64 中最小的够用档 | |
| 日志组件 | 产品日志容量页「三节点（≤ 20,000 条/秒）」档的参考值 | 该页写明 *Provision more resources than the reference numbers*，参考值是下限。所以含日志栈的池，内存在够用档之上再取一档 |
| 监控档位 | 单集群、workload (a) 取 Medium（50 worker），global 取 Small，workload (b) 按 150 worker 外推 | 产品档位：Small 10、Medium 50、Large 500 worker |
| 一台节点故障 | 不按「剩余节点接管全部」放大 | 有状态组件绑本地卷，靠 3 副本多数派降级运行 |
| 日志数据盘 | 5,000 条/秒、保留 7 天 | |

### 5.2 逐组件表（单集群 infra，3 台合计）

| 组件 | 副本 | 每副本 CPU / 内存 | 合计 | 依据 |
|---|---:|---|---|---|
| ClickHouse server | 3 | 2 核 / 4 GiB | 6 / 12 | 日志容量页参考值 |
| Kafka broker | 3 | 2 核 / 4 GiB | 6 / 12 | 日志容量页参考值 |
| aggregate-vector | 2 | 2 核 / 4 GiB | 4 / 8 | 日志容量页参考值 |
| Razor | 2 | 1 核 / 1 GiB | 2 / 2 | 日志容量页参考值 |
| ClickHouse Keeper | 3 | 1 核 / 1.5 GiB | 3 / 4.5 | 参考值（无公开文档） |
| Kafka KRaft controller | 3 | 0.5 核 / 1.5 GiB | 1.5 / 4.5 | 参考值（无公开文档） |
| ClickHouse operator、Kafka entity operator、Strimzi operator、日志存储 operator ×2 | — | — | 2.1 / 2.6 | 参考值（无公开文档） |
| **日志小计** | | | **24.6 / 45.6** | |
| VictoriaMetrics（Medium，3 副本，含 vmstorage、vmselect、vminsert、vmagent、vmalert、Alertmanager、operator 和辅助组件） | | | **11.9 / 17.8** | 参考值（无公开文档）；产品监控容量页只给单副本值 |
| Ingress NGINX controller | 2 | 3 核 / 1.5 GiB | 6 / 3 | 参考值（无公开文档），按每个约 4,000 请求/秒；产品只给 200m / 256Mi 示例 |
| Ingress operator | 1 | 0.5 核 / 0.5 GiB | 0.5 / 0.5 | 参考值（无公开文档） |
| 镜像仓库（operator、image-registry、image-api-server ×2） | | | 1.7 / 2.5 | image-registry 按产品示例 500m / 500Mi 加倍；其余为参考值（无公开文档） |
| TopoLVM（operator、controller ×2、node ×3） | | | 1.4 / 2.1 | 参考值（无公开文档） |
| DaemonSet × 3 台 | | | 6.9 / 7.0 | 见 §5.1 |
| **3 台合计** | | | **53.0 / 78.5** | |

### 5.3 推导

```
单集群 infra / workload (a) infra
  合计 53.0 核 / 78.5 GiB ÷ 3 = 每台 17.7 核 / 26.2 GiB
  + 预留 0.1 核 / 4.5 GiB（48 GiB 档）
  → CPU 17.8 → 20 核；内存 30.7 → 32 GiB 够用但贴线，按日志口径取上一档 → 48 GiB

global infra
  日志 24.6 / 45.6 + 监控 Small 7.9 / 12.6 + 平台 Ingress Gateway 3.0 / 3.0
  + TopoLVM 1.4 / 2.1 + DaemonSet 6.9 / 7.0 = 43.8 核 / 70.3 GiB
  ÷ 3 = 每台 14.6 核 / 23.4 GiB → 16 核；内存够用档 32 GiB，按日志口径取上一档 → 48 GiB

workload infra − global infra（3 台合计）
  + Ingress NGINX 6.5 / 3.5  + 镜像仓库 1.7 / 2.5  + 监控 Medium 比 Small 多 4.0 / 5.2
  − 平台 Ingress Gateway 3.0 / 3.0  = +9.2 核 / +8.2 GiB → 每台 +3.1 核 / +2.7 GiB

workload (b) log
  日志 24.6 / 45.6 + TopoLVM 1.4 / 2.1 + DaemonSet 6.9 / 7.0 = 32.9 核 / 54.7 GiB
  ÷ 3 = 每台 11.0 核 / 18.2 GiB → 12 核；内存够用档 24 GiB，按日志口径取上一档 → 32 GiB

workload (b) monitor（推断）
  监控按 150 worker 外推 22.1 / 34.5 + TopoLVM、DaemonSet 8.3 / 9.1
  ÷ 3 = 每台 10.1 核 / 14.5 GiB；加预留后超过 16 GiB → 12 核 / 24 GiB
  上限校验：产品 Large 档（500 worker）数据面 vmselect 5 核 / 3 GB + proxy 2 核 / 0.2 GB + vmstorage 2 核 / 6 GB = 9 核 / 9.2 GB（单副本）

workload (b) ingress
  controller 2 × 3 核 / 1.5 GiB + operator 0.5 / 0.5 = 6.5 / 3.5，2 台各 3.25 / 1.75
  + DaemonSet 2.25 / 2.28 = 每台 5.5 核 / 4.0 GiB → 8 核 / 8 GiB
  轻载（每个 controller 1 核）：3.5 核 / 3.5 GiB → 4 核 / 8 GiB

control-plane
  单集群 / global：核心最低 8 核 / 16 GB + 扩展（监控 API、日志查询、存储 operator、MetalLB controller、
    keepalived、日志采集 operator）8.35 核 / 9.8 GiB ÷ 3 + DaemonSet 2.25 / 2.28
    = 每台约 13.0 核 / 21.5 GiB → 产品推荐 16 核 / 32 GB
  workload (a)：产品 24 worker 档 4 核 / 16 GB + 扩展 0.45 / 0.6 + DaemonSet 2.25 / 2.28
    = 6.7 核 / 18.9 GiB > 16 GiB → 产品下一档 8 核 / 32 GB
  workload (b)：直接取产品 120 worker 档 8 核 / 32 GB
```

扩展插件和 DaemonSet 的数值为参考值（无公开文档）。

### 5.4 数据盘

**公式**

- ClickHouse 每台 = 条/秒 × 每条字节 × 86,400 × 保留天数 ÷ 压缩比 × 1.3（合并余量）。1 分片 3 副本，每个副本存全量。
- Kafka 每台 = 条/秒 × 每条字节 × 86,400 × 保留小时 ÷ 24 ÷ 压缩比 × 1.2。3 副本，每个 broker 存全量。
- 卷组 = 各 PVC 之和 × 1.2，向上取整到 50 GiB。

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
单集群 / workload (a) infra = (305 + 161 + 10 + 5 + 26 + 100) × 1.2 = 729 → 750 GiB
global infra                = (305 + 161 + 10 + 5 + 26) × 1.2       = 609 → 650 GiB
workload (b) log            = (305 + 161 + 10 + 5) × 1.2            = 577 → 600 GiB
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

### 5.5 Ceph

- 组件资源按插件默认 balanced 档逐个求和：OSD 3 × 3 核 / 5 GiB、MON 3 × 1 核 / 2 GiB、MGR、RGW、CSI 等，合计 RBD + RGW 18.7 核 / 36.7 GiB。参考值（无公开文档）。只用 RBD 时为 14.7 核 / 30.7 GiB。
- 产品 Ceph 规划页给出的 4 节点聚合预算（最低 32 CPU / 96 GiB）高于 ODF 的最小部署，这里不采用。

### 5.6 出处

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
| 日志组件参考值、*Provision more resources than the reference numbers* | https://docs.alauda.io/logging-service/4.4/architecture/capacity_planning.html |
| Kafka 保留 48 小时示例 | https://docs.alauda.io/logging-service/4.4/install/ |
| ClickHouse 日志配方（1 分片 3 副本） | https://docs.alauda.io/clickhouse/4.4/how_to/deploy_as_logging_storage.html |
| ClickHouse Keeper（每成员 10 GiB） | https://docs.alauda.io/clickhouse/4.4/how_to/deploy_keeper_quorum.html |
| OpenShift Data Foundation 资源要求 | https://docs.redhat.com/en/documentation/red_hat_openshift_data_foundation/4.20/html-single/planning_your_deployment/index |

acp-docs 路径以 `release-4.5` 分支为准。

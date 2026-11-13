---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.5.x
---

# ACP 4.5 + Alauda OS 标准交付：单集群与多集群

本文给出 ACP 4.5 在 Alauda OS 上的两种标准交付方式：**单集群**和**多集群**。每种方式都按三部分组织：要准备哪些机器，在这些机器上怎么安装，以及按什么顺序操作。

- 适用的 provider：Bare Metal、Huawei DCS、VMware vSphere、Huawei Cloud Stack。
- 存储按客户**没有商业存储**的情况写。客户有商业存储时，除节点本地的平台盘外，全部改用商业存储。
- 具体操作、命令和配置字段都在产品文档里，本文只给链接。

---

## 一、单集群

global 集群同时承载业务，约 20 个业务 worker，不做容灾。

### 1. 准备机器

| 节点池 | 台数 | CPU | 内存 | 用途 |
|---|---:|---|---|---|
| bootstrap | 1 | 见 [Bootstrap Node][bootstrap-hw] | 见 [Bootstrap Node][bootstrap-hw] | 只在安装时使用，装完即可回收 |
| control-plane | 3 | 16 核 | 32 GiB | 控制面和平台组件 |
| infra | 3 | 12 核 | 48 GiB | 监控、日志、Ingress、MetalLB |
| worker | 约 20 | 按业务定 | 按业务定 | 业务负载 |

使用 ARM 节点时，按 [Machines][plan-machines] 中的规则放大规格。

### 2. 安装规划

**节点池**

| 节点池 | 在 `install-config.yaml` 中 | 说明 |
|---|---|---|
| control-plane | `controlPlane` | `deployMode` 保持默认值 `normal`，不要设成 `base` |
| infra | `computes[]` 中的一个节点组 | 集群建好后，按 [Create Infra Nodes on Alauda OS Nodes][infra-aos] 在节点池上声明 infra 标签和污点 |
| worker | `computes[]` 中的一个节点组 | — |

控制面端点用 Self-built VIP；Huawei Cloud Stack 例外，用 provider 创建的 ELB。各 provider 支持的端点模式见 [Endpoint Modes][endpoint-modes]，字段见 [Installation Reference][install-config]。

**插件、位置与存储**

| 功能 | 插件 | 装在 | 存储 |
|---|---|---|---|
| 应用入口 | Alauda Container Platform Ingress Controller | infra | — |
| 应用入口 VIP | Alauda Container Platform Load Balancer（MetalLB） | infra | — |
| 监控 | Alauda Container Platform Advanced Monitoring（VictoriaMetrics） | infra | TopoLVM |
| 日志存储 | Alauda Container Platform Log Storage Management、Alauda Data Services Analytical Database E1（ClickHouse）、Alauda Data Services Streaming E1（Kafka） | infra | TopoLVM |
| 日志采集 | Alauda Container Platform Log Collector | 所有节点 | — |
| 监控 API、日志查询 | Alauda Container Platform Observability Essentials、Alauda Container Platform Log Essentials | control-plane | — |
| 本地块存储 | Alauda Container Platform Storage Essentials、Alauda Container Platform LVM Volume Provisioner（TopoLVM） | 有 TopoLVM 盘的节点 | — |
| 镜像仓库（业务镜像） | Alauda Container Platform Registry | 待定 | TopoLVM，单副本 |
| 应用备份 | Alauda Container Platform Data Backup Essentials、Alauda Container Platform Data Backup（Velero） | control-plane | 客户提供的集群外对象存储 |

- 单集群不部署 Ceph，所有需要持久卷的组件都用 TopoLVM。镜像仓库因此只有一个副本，所在节点故障时不可用。
- 客户提供不了集群外对象存储时，不交付应用备份。etcd 备份只保存在本地 `/var/cpaas/backup`，见 [etcd 备份][etcd-backup]。
- 不安装：Alauda Container Platform Basic Monitoring、Alauda Container Platform Gateway API Controller、Alauda Storage（Ceph）、DevOps 工具。需要 DevOps 工具时，改用多集群方式交付。

### 3. 操作步骤

| # | 做什么 | 文档 |
|---:|---|---|
| 1 | 规划，准备资源，确认哪些网络流量适用 | [Plan][plan]、[Communication Matrix][comm-app] |
| 2 | 满足公共前提，准备 bootstrap 和控制面端点 | [Prerequisites][aos-prereq] |
| 3 | 满足 provider 自己的前提 | [Bare Metal][bm-prereq] / [Huawei DCS][dcs-prereq] / [VMware vSphere][vs-prereq] / [Huawei Cloud Stack][hcs-prereq] |
| 4 | 规划每个节点池的磁盘，包括给 TopoLVM 用的裸盘。集群建好后磁盘布局不能再改 | [Fixed at Creation][fixed]、[Disk Configuration][disk]；TopoLVM 裸盘：[Huawei DCS][dcs-raw] / [Huawei Cloud Stack][hcs-raw] / [VMware vSphere][vs-raw] |
| 5 | 安装 global，包含 control-plane、infra、worker 三个节点组 | [Bare Metal][bm-create] / [Huawei DCS][dcs-create] / [VMware vSphere][vs-create] / [Huawei Cloud Stack][hcs-create] |
| 6 | 验证安装 | [Validation][validation] |
| 7 | 在 infra 节点池上声明标签和污点。之后的插件都要放到 infra 上，所以这一步先做 | [Create Infra Nodes on Alauda OS Nodes][infra-aos] |
| 8 | 安装 TopoLVM。监控、日志、镜像仓库都要用它的 StorageClass，所以先装 | [Install TopoLVM][topolvm] |
| 9 | 安装监控：存储类型选 StorageClass（TopoLVM），放到 infra | [Advanced Monitoring][mon-vm]、[Planning Infra Nodes for Monitoring][mon-infra-howto] |
| 10 | 安装日志：存储用 TopoLVM，放到 infra | [日志快速安装][log-fast] |
| 11 | 安装 Ingress 和 MetalLB，两者都放到 infra，再配置地址池 | [Ingress Controller][ingress]、[MetalLB 组件位置][metallb-place]、[地址池][metallb-pool] |
| 12 | 安装镜像仓库 | [Install Registry][registry-install]、[Configure Registry][registry-config] |
| 13 | 客户提供了集群外对象存储时，安装应用备份并配置备份仓库 | [Application Installation][backup-install]、[Backup Repository][backup-repo] |
| 14 | 完成其余安装后任务 | [Next Steps][next-steps] |
| — | 以后升级 | [Upgrade Overview][upgrade] |

---

## 二、多集群

global 只承载平台，不跑业务；业务都在 workload 集群上。global 做主备容灾。

### 1. 准备机器

**global**：下表是每一套的规格，主、备各一套。不做容灾时只建一套，机器减半。

| 节点池 | 台数（每套） | CPU | 内存 | 用途 |
|---|---:|---|---|---|
| bootstrap | 1 | 见 [Bootstrap Node][bootstrap-hw] | 见 [Bootstrap Node][bootstrap-hw] | 只在安装时使用；主、备各需要一台 |
| control-plane | 3 | 16 核 | 32 GiB | 控制面和平台组件 |
| infra | 3 | 16 核 | 32 GiB | global 自己的监控和日志 |

这个规格适用于纳管不超过 50 个集群。超过时，按 [Evaluating Resources for Global Cluster][eval-global] 重新评估。

**workload 集群**：按业务规模选一档。

(a) 约 20 个 worker：

| 节点池 | 台数 | CPU | 内存 | 用途 |
|---|---:|---|---|---|
| control-plane | 3 | 8 核 | 16 GiB | 控制面和平台组件 |
| infra | 3 | 12 核 | 48 GiB | 监控、日志、Ingress、MetalLB |
| worker | 约 20 | 按业务定 | 按业务定 | 业务负载 |

(b) 约 150 个 worker，非业务节点分池：

| 节点池 | 台数 | CPU | 内存 | 用途 |
|---|---:|---|---|---|
| control-plane | 3 | 8 核 | 16 GiB | 控制面和平台组件 |
| ingress | 2 | 4 核 | 8 GiB | Ingress、MetalLB |
| monitor | 3 | 12 核 | 48 GiB | 监控 |
| log | 3 | 12 核 | 48 GiB | 日志 |
| worker | 约 150 | 按业务定 | 按业务定 | 业务负载 |

(b) 档的规格是起步值，要结合实际的对象数量、监控数据量和日志保留期核实；控制面的评估方法见 [Evaluating Resources for Workload Cluster][eval-workload]。

**客户没有商业存储时，还需要两个集群**

| 集群 | 用途 | 节点池 | 规格 |
|---|---|---|---|
| 存储集群 | 运行 Ceph，给其他集群提供块存储（RBD）和对象存储（RGW）；备份写在这里才算写到了集群外 | control-plane、infra、storage | 待定。Ceph 的最低要求见 [Ceph Planning][ceph-plan] |
| DevOps 集群 | 运行 Harbor、GitLab、Tekton、SonarQube、Nexus | control-plane、infra、devops | 待定 |

客户在意机器数量时，可以把这两个集群合成一个，包含控制面、infra、devops、存储四类节点。客户有商业存储时不需要存储集群；如果客户也没有对象存储，仍需部署 Ceph 提供对象存储。

### 2. 安装规划

**节点池**

- 所有集群的 `deployMode` 都保持默认值 `normal`。字段说明见 [Installation Reference][install-config]。
- workload (a) 档只有一个 infra 池。(b) 档的 ingress、monitor、log 各建一个节点池，每个池使用自己的角色标签和污点，见 [Custom Role Nodes][custom-role]。

**插件、位置与存储**

| 集群 | 功能 | 插件 | 装在 | 存储 |
|---|---|---|---|---|
| global（主、备都装） | 容灾同步 | Alauda Container Platform Global Cluster Disaster Recovery | 备集群 | — |
| global | 监控 | Advanced Monitoring | infra | TopoLVM |
| global | 日志存储 | Log Storage Management、Analytical Database E1、Streaming E1 | infra | TopoLVM |
| global | 日志采集 | Log Collector | 所有节点 | — |
| global | 监控 API、日志查询 | Observability Essentials、Log Essentials | control-plane | — |
| global | 本地块存储 | Storage Essentials、LVM Volume Provisioner | infra | — |
| global | 应用备份界面 | Data Backup Essentials | control-plane | — |
| workload | 应用入口 | Ingress Controller | (a) infra / (b) ingress | — |
| workload | 应用入口 VIP | Load Balancer（MetalLB） | 与 Ingress 同池 | — |
| workload | 监控 | Advanced Monitoring（完整安装） | (a) infra / (b) monitor | TopoLVM |
| workload | 日志存储 | Log Storage Management、Analytical Database E1、Streaming E1 | (a) infra / (b) log | TopoLVM |
| workload | 日志采集 | Log Collector | 所有节点 | — |
| workload | 本地块存储 | Storage Essentials、LVM Volume Provisioner | (a) infra / (b) monitor、log | — |
| workload | 其他需要持久卷的组件 | Alauda Storage（External Mode，接入存储集群） | — | Ceph RBD |
| workload | 镜像仓库（业务镜像） | Alauda Container Platform Registry | 待定 | 存储集群的 Ceph RGW |
| workload | 应用备份 | Data Backup（Velero） | control-plane | 存储集群的 Ceph RGW |
| 存储集群 | 分布式存储 | Storage Essentials、Alauda Storage（Internal Mode）、Alauda Container Platform COSI、Alauda Container Platform COSI Driver | storage | 节点上的独立数据盘 |
| DevOps 集群 | DevOps 工具 | Alauda Toolchain Enterprise Registry E1（Harbor）、Alauda Toolchain Code Repository E1（GitLab）、Alauda Container Platform Pipelines（Tekton）、Alauda Toolchain Code Quality E1（SonarQube）、Alauda Toolchain Artifact Repository E1（Nexus） | devops | 数据库和数据目录用 Ceph RBD；Harbor 镜像层用 Ceph RGW |
| 存储集群、DevOps 集群 | 自己的监控、日志 | 与 workload 相同 | infra | TopoLVM |

- 每个集群的监控和日志都只存自己的数据，不送往 global。容灾只同步 global 的 etcd，监控和日志不会复制到备集群，见 [Observability Placement][dr-observability]。
- global 不跑业务，所以不安装 Ingress Controller 和 Load Balancer。
- etcd 备份除了本地 `/var/cpaas/backup`，还要另存一份到存储集群的 Ceph RGW。
- workload 集群需要交付虚拟机时，虚拟机的盘用 Ceph RBD。

### 3. 操作步骤

| # | 做什么 | 文档 |
|---:|---|---|
| 1 | 规划，准备资源，确认哪些网络流量适用 | [Plan][plan]、[Communication Matrix][comm-app] |
| 2 | 在写第一份 `install-config.yaml` 之前决定是否做容灾；做容灾时生成主备共用的密钥，并放通容灾所需的网络 | [Create a Global Cluster Disaster Recovery Pair][dr]、[Decide Before You Install][dr-decide] |
| 3 | 满足公共前提和 provider 前提，主、备各准备一台 bootstrap | [Prerequisites][aos-prereq]；provider 前提见单集群第 3 步 |
| 4 | 规划每个节点池的磁盘。集群建好后磁盘布局不能再改 | [Fixed at Creation][fixed]、[Disk Configuration][disk] |
| 5 | 先安装主 global，再安装备 global | [Install the Primary and the Standby][dr-install] |
| 6 | 启动同步 | [Start Synchronization][dr-sync] |
| 7 | 在两套 global 上都声明 infra 标签和污点，并安装 TopoLVM、监控、日志。这些插件要等两套都装好、同步运行后再装 | [Install the Cluster Plugins][dr-plugins]、[Infra Nodes][infra-aos]、[Install TopoLVM][topolvm]、[Advanced Monitoring][mon-vm]、[日志快速安装][log-fast] |
| 8 | 在 global 上安装要用到的 provider | [Install the Providers][wl-providers] |
| 9 | 客户没有商业存储时，先建存储集群，部署 Ceph 和 COSI。workload 集群上用到 RBD 或 RGW 的插件都依赖它 | [Cluster Creation Workflow][wl-workflow]、[Ceph on Alauda OS][ceph-aos]、[Install Ceph][ceph-install]、[COSI][cosi] |
| 10 | 需要 DevOps 工具时，建 DevOps 集群 | [Cluster Creation Workflow][wl-workflow] |
| 11 | 建 workload 集群：选定镜像仓库，按 (a) 或 (b) 档建节点池，再在节点池上声明角色标签和污点 | [Cluster Creation Workflow][wl-workflow]、[Choose the Image Registry][wl-registry]、[Custom Role Nodes][custom-role] |
| 12 | 在 workload 集群上依次安装：TopoLVM → 接入 Ceph → 监控 → 日志 → Ingress 和 MetalLB → 镜像仓库 → 应用备份 | [Install TopoLVM][topolvm]、[External Mode][ceph-ext]、[Advanced Monitoring][mon-vm]、[日志快速安装][log-fast]、[Ingress Controller][ingress]、[MetalLB 组件位置][metallb-place]、[Install Registry][registry-install]、[Configure Registry][registry-config]、[Application Installation][backup-install] |
| — | 故障切换 | [Fail Over][failover] |
| — | 以后升级 | [Upgrade Overview][upgrade]、[容灾环境的升级][upgrade-dr] |

[bootstrap-hw]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/prerequisites.html#bootstrap-host-requirements
[plan]: https://docs.alauda.io/container_platform/4.5/install/prepare/planning.html
[plan-machines]: https://docs.alauda.io/container_platform/4.5/install/prepare/planning.html#machines
[comm-app]: https://docs.alauda.io/container_platform/4.5/install/prepare/communication_matrix.html#applicability
[aos-prereq]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/prerequisites.html
[endpoint-modes]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/prerequisites.html#endpoint-modes-by-provider
[install-config]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/reference.html#install-config
[bm-prereq]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/bare-metal/prerequisites.html
[dcs-prereq]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/huawei-dcs/prerequisites.html
[vs-prereq]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/vmware-vsphere/prerequisites.html
[hcs-prereq]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/huawei-cloud-stack/prerequisites.html
[bm-create]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/bare-metal/create_cluster.html
[dcs-create]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/huawei-dcs/create_cluster.html
[vs-create]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/vmware-vsphere/create_cluster.html
[hcs-create]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/huawei-cloud-stack/create_cluster.html
[fixed]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/index.html#fixed-at-creation
[disk]: https://docs.alauda.io/container_platform/4.5/configure/scalability/disk_configuration.html
[dcs-raw]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/huawei-dcs/reference/install-config-parameters.html#raw-disks
[hcs-raw]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/huawei-cloud-stack/reference/install-config-parameters.html#add-raw-disks
[vs-raw]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/vmware-vsphere/reference/install-config-parameters.html#add-data-disks
[validation]: https://docs.alauda.io/container_platform/4.5/install/validation.html
[infra-aos]: https://docs.alauda.io/container_platform/4.5/configure/nodes/node_planning.html#create-infra-nodes-alauda-os
[custom-role]: https://docs.alauda.io/container_platform/4.5/configure/nodes/node_planning.html#custom-role-nodes
[topolvm]: https://docs.alauda.io/container_platform/4.5/storage/storagesystem_topolvm/installation.html
[mon-vm]: https://docs.alauda.io/container_platform/4.5/observability/monitor/install_monitor.html#acp-monitoring-with-victoriametrics
[mon-infra-howto]: https://docs.alauda.io/container_platform/4.5/observability/monitor/how_to/infra_nodes.html
[log-fast]: https://docs.alauda.io/logging-service/4.4/install/fast-install.html
[ingress]: https://docs.alauda.io/container_platform/4.5/networking/operators/ingress_nginx_operator.html
[metallb-place]: https://docs.alauda.io/container_platform/4.5/networking/operators/metallb_operator.html#configure-component-placement
[metallb-pool]: https://docs.alauda.io/container_platform/4.5/networking/functions/configure_metallb.html#configure_ip_pool
[registry-install]: https://docs.alauda.io/container_platform/4.5/configure/registry/image_registry_operator.html
[registry-config]: https://docs.alauda.io/container_platform/4.5/configure/registry/setting_up_and_configuring_the_registry.html
[backup-install]: https://docs.alauda.io/container_platform/4.5/configure/backup/overview.html#application-installation
[backup-repo]: https://docs.alauda.io/container_platform/4.5/configure/backup/application/repository.html
[etcd-backup]: https://docs.alauda.io/container_platform/4.5/configure/backup/etcd.html
[next-steps]: https://docs.alauda.io/container_platform/4.5/install/next_steps.html
[upgrade]: https://docs.alauda.io/container_platform/4.5/upgrade/overview.html
[upgrade-dr]: https://docs.alauda.io/container_platform/4.5/upgrade/global/upgrade_global_dr.html
[eval-global]: https://docs.alauda.io/container_platform/4.5/configure/scalability/evaluating_global.html
[eval-workload]: https://docs.alauda.io/container_platform/4.5/configure/scalability/evaluating_workload.html
[dr]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/global_dr.html
[dr-decide]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/global_dr.html#decide-before-you-install
[dr-install]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/global_dr.html#install-primary-and-standby-clusters
[dr-sync]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/global_dr.html#start-synchronization
[dr-plugins]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/global_dr.html#restart-the-dependent-pods
[failover]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/disaster_recovery_failover.html
[wl-providers]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/index.html#install-providers
[wl-workflow]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/index.html#workflow
[wl-registry]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/prepare/index.html#image-registry
[ceph-plan]: https://docs.alauda.io/container_platform/4.5/storage/storagesystem_ceph/planning.html
[ceph-aos]: https://docs.alauda.io/container_platform/4.5/storage/storagesystem_ceph/installation/immutable_infrastructure_prerequisites.html
[ceph-install]: https://docs.alauda.io/container_platform/4.5/storage/storagesystem_ceph/installation/index.html
[ceph-ext]: https://docs.alauda.io/container_platform/4.5/storage/storagesystem_ceph/installation/access_storage_service.html
[cosi]: https://docs.alauda.io/container_platform/4.5/configure/storage/cosi/install.html
[dr-observability]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/global_dr.html#observability-placement

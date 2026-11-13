---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.5.x
---

# ACP 4.5 + Alauda OS 标准交付：单集群与多集群

本文给出 ACP 4.5 在 Alauda OS 上的两种标准交付方式：**单集群**和**多集群**。每种方式分三部分：资源需求、方案选型、操作步骤。

- 适用的 provider：Bare Metal、Huawei DCS、VMware vSphere、Huawei Cloud Stack。
- 存储按客户**没有商业存储**的情况写。客户有商业存储时，除节点本地的平台盘外，全部改用商业存储。
- 具体操作、命令和配置字段都在产品文档里，本文只给链接。

---

## 一、单集群

global 集群同时用作 workload 集群，不做容灾。

### 1. 资源需求

**机器**

| 节点池 | 台数 | CPU | 内存 | 用途 |
|---|---:|---|---|---|
| bootstrap | 1 | 见 [Bootstrap Node][bootstrap-hw] | 见 [Bootstrap Node][bootstrap-hw] | 运行安装程序；也可兼作平台镜像仓库 |
| control-plane | 3 | 16 核 | 32 GiB | 控制面和平台组件 |
| infra | 3 | 12 核 | 48 GiB | 监控、日志、Ingress、镜像仓库 |

- 以上规格是建议值，不是强制要求。使用 ARM 节点时，按 [Machines][plan-machines] 中的规则放大。
- 规格按约 20 个业务 worker 估算，仅供参考。业务 worker 的数量和规格由业务决定，不在本文范围内。安装后按控制面节点的负载评估，需要时扩容，见 [Evaluating Resources for Workload Cluster][eval-workload]。单集群的 global 同时是 workload 集群，所以按 workload 集群评估。
- 客户提供不了镜像仓库、机器资源又有限时，可以在 bootstrap 上部署 mirror-registry，作为平台镜像仓库。这样 bootstrap 装完后不能回收，并且要满足 mirror-registry 的要求，见 [Create an Image Registry with mirror-registry][mirror-registry]。

**节点池**

| 节点池 | 在 `install-config.yaml` 中 | 说明 |
|---|---|---|
| control-plane | `controlPlane` | `deployMode` 保持默认值 `normal`，不要设成 `base` |
| infra | `computes[]` 中的一个节点组 | 集群建好后，按 [Create Infra Nodes on Alauda OS Nodes][infra-aos] 在节点池上声明 infra 标签和污点 |

字段说明见 [Installation Reference][install-config]。

**控制面端点**

控制面端点承载 Kubernetes API 和平台访问地址，有两种方式，由客户决定：

- **Self-built VIP**：不需要外部设备。
- **客户的商业负载均衡**：客户已有时也可以用。

Huawei Cloud Stack 例外，只能用 provider 创建的 ELB。各 provider 支持哪些方式、要准备什么，见 [Plan the Control Plane Endpoint][endpoint]。

> 提示：平台流量一般不大，为它使用商业负载均衡，性能可能过剩。

### 2. 方案选型

**功能与存储选型**

| 功能 | 选型 | 存储 |
|---|---|---|
| 监控 | VictoriaMetrics | TopoLVM |
| 日志 | ClickHouse + Kafka | TopoLVM |
| 应用入口 | Ingress NGINX | — |
| 应用入口 VIP | 客户有商业负载均衡时用商业负载均衡；没有时用 MetalLB | — |
| 镜像仓库（业务镜像） | ACP Registry，单副本 | TopoLVM |

**装在 infra 上的插件**

| 插件 | 用途 |
|---|---|
| Alauda Container Platform Advanced Monitoring | 监控 |
| Alauda Container Platform Log Storage Management | 日志存储管理 |
| Alauda Data Services Analytical Database E1 | 日志存储（ClickHouse） |
| Alauda Data Services Streaming E1 | 日志消息队列（Kafka） |
| Alauda Container Platform Ingress Controller | 应用入口 |
| Alauda Container Platform Registry | 镜像仓库（业务镜像） |

### 3. 操作步骤

| # | 做什么 | 文档 |
|---:|---|---|
| 1 | 规划，确认哪些网络流量适用 | [Plan][plan]、[Communication Matrix][comm-app] |
| 2 | 下载安装包 | [Download][download] |
| 3 | 准备平台镜像仓库并上传镜像：用客户的镜像仓库，或在 bootstrap 上部署 mirror-registry | [Prepare an External Platform Image Registry][ext-registry]、[mirror-registry][mirror-registry] |
| 4 | 满足公共前提，准备 bootstrap 和控制面端点 | [Prerequisites][aos-prereq] |
| 5 | 满足 provider 自己的前提 | [Bare Metal][bm-prereq] / [Huawei DCS][dcs-prereq] / [VMware vSphere][vs-prereq] / [Huawei Cloud Stack][hcs-prereq] |
| 6 | 规划每个节点池的磁盘，包括给 TopoLVM 用的裸盘。集群建好后磁盘布局不能再改 | [Fixed at Creation][fixed]、[Disk Configuration][disk]；TopoLVM 裸盘：[Huawei DCS][dcs-raw] / [Huawei Cloud Stack][hcs-raw] / [VMware vSphere][vs-raw] |
| 7 | 安装 global | [Bare Metal][bm-create] / [Huawei DCS][dcs-create] / [VMware vSphere][vs-create] / [Huawei Cloud Stack][hcs-create] |
| 8 | 验证安装 | [Validation][validation] |
| 9 | 发布 Common Extensions。发布后才能安装下面的插件 | [Publish the Common Extensions][publish] |
| 10 | 在 infra 节点池上声明标签和污点 | [Create Infra Nodes on Alauda OS Nodes][infra-aos] |
| 11 | 安装 TopoLVM，在 infra 节点的数据盘上创建存储。监控、日志、镜像仓库都要用它，所以先装 | [Install TopoLVM][topolvm] |
| 12 | 安装监控，存储用 TopoLVM，放到 infra | [Advanced Monitoring][mon-vm]、[Planning Infra Nodes for Monitoring][mon-infra-howto] |
| 13 | 安装日志，存储用 TopoLVM，放到 infra | [日志快速安装][log-fast] |
| 14 | 安装 Ingress，放到 infra。没有商业负载均衡时，再安装 MetalLB 并配置地址池 | [Ingress Controller][ingress]、[MetalLB 组件位置][metallb-place]、[地址池][metallb-pool] |
| 15 | 安装镜像仓库，存储用 TopoLVM，放到 infra | [Install Registry][registry-install]、[Configure Registry][registry-config] |
| 16 | 安装 etcd 备份插件 | [etcd Backup and Restore][etcd-backup] |
| 17 | 完成其余安装后任务 | [Next Steps][next-steps] |
| — | 以后升级 | [Upgrade Overview][upgrade] |

---

## 二、多集群

global 只承载平台，不跑业务；业务都在 workload 集群上。global 做主备容灾。

### 1. 资源需求

**global**：下表是每一套的规格，主、备各一套。不做容灾时只建一套，机器减半。

| 节点池 | 台数（每套） | CPU | 内存 | 用途 |
|---|---:|---|---|---|
| bootstrap | 1 | 见 [Bootstrap Node][bootstrap-hw] | 见 [Bootstrap Node][bootstrap-hw] | 运行安装程序；也可兼作平台镜像仓库 |
| control-plane | 3 | 16 核 | 32 GiB | 控制面和平台组件 |
| infra | 3 | 16 核 | 32 GiB | global 自己的监控和日志 |

**workload 集群**：按业务规模选一档。

(a) 约 20 个业务 worker：

| 节点池 | 台数 | CPU | 内存 | 用途 |
|---|---:|---|---|---|
| control-plane | 3 | 8 核 | 16 GiB | 控制面和平台组件 |
| infra | 3 | 12 核 | 48 GiB | 监控、日志、Ingress、镜像仓库 |

(b) 约 150 个业务 worker，非业务节点分池：

| 节点池 | 台数 | CPU | 内存 | 用途 |
|---|---:|---|---|---|
| control-plane | 3 | 8 核 | 16 GiB | 控制面和平台组件 |
| ingress | 2 | 4 核 | 8 GiB | Ingress |
| monitor | 3 | 12 核 | 48 GiB | 监控 |
| log | 3 | 12 核 | 48 GiB | 日志 |

**客户没有商业存储时，还需要两个集群**

| 集群 | 用途 | 节点池 | 规格 |
|---|---|---|---|
| 存储集群 | 运行 Ceph，给其他集群提供块存储（RBD）和对象存储（RGW） | control-plane、infra、storage | 待定。Ceph 的最低要求见 [Ceph Planning][ceph-plan] |
| DevOps 集群 | 运行 Harbor、GitLab、Tekton、SonarQube、Nexus | control-plane、infra、devops | 待定 |

- 以上规格是建议值，不是强制要求。使用 ARM 节点时，按 [Machines][plan-machines] 中的规则放大。
- global 的规格适用于纳管不超过 50 个集群。超过时，按 [Evaluating Resources for Global Cluster][eval-global] 重新评估。
- workload 的两档按业务 worker 数量估算，仅供参考。业务 worker 的数量和规格由业务决定，不在本文范围内。安装后按控制面节点的负载评估，需要时扩容，见 [Evaluating Resources for Workload Cluster][eval-workload]。(b) 档还要结合监控数据量和日志保留期核实。
- 客户提供不了镜像仓库时，可以在 bootstrap 上部署 mirror-registry 作为平台镜像仓库；做容灾时主、备两侧各部署一套。多个集群共用一个 mirror-registry 会形成单点，workload 集群较多时建议用客户的高可用镜像仓库。见 [mirror-registry][mirror-registry]。
- 客户在意机器数量时，可以把存储集群和 DevOps 集群合成一个，包含控制面、infra、devops、存储四类节点。客户有商业存储时不需要存储集群；如果客户也没有对象存储，仍需部署 Ceph 提供对象存储。

**节点池**

- 所有集群的 `deployMode` 都保持默认值 `normal`。字段说明见 [Installation Reference][install-config]。
- global 和 workload (a) 档的 infra 池：集群建好后，按 [Create Infra Nodes on Alauda OS Nodes][infra-aos] 在节点池上声明标签和污点。
- workload (b) 档的 ingress、monitor、log 各建一个节点池，每个池使用自己的角色标签和污点，见 [Custom Role Nodes][custom-role]。

**控制面端点**

global 和每个 workload 集群都需要控制面端点，方式和单集群相同：Self-built VIP 或客户的商业负载均衡，由客户决定；Huawei Cloud Stack 用 provider 创建的 ELB。见 [Plan the Control Plane Endpoint][endpoint]。

> 提示：平台流量一般不大，为它使用商业负载均衡，性能可能过剩。

### 2. 方案选型

**功能与存储选型**

| 功能 | 选型 | 存储 |
|---|---|---|
| 监控 | VictoriaMetrics，每个集群各装一套 | TopoLVM |
| 日志 | ClickHouse + Kafka，每个集群各装一套 | TopoLVM |
| 应用入口（workload） | Ingress NGINX | — |
| 应用入口 VIP（workload） | 客户有商业负载均衡时用商业负载均衡；没有时用 MetalLB | — |
| 镜像仓库（业务镜像，workload） | ACP Registry | 存储集群的 Ceph RGW |
| workload 上其他需要持久卷的组件 | 以 External Mode 接入存储集群 | Ceph RBD |
| 虚拟机（如交付） | — | Ceph RBD |
| 存储集群 | Ceph，用 COSI 分配对象存储桶 | 节点上的独立数据盘 |
| DevOps 工具 | Harbor、GitLab、Tekton、SonarQube、Nexus | 数据库和数据目录用 Ceph RBD；Harbor 镜像层用 Ceph RGW |

每个集群的监控和日志只存自己的数据，不要送往 global。容灾只同步 global 的 etcd，监控和日志不会复制到备集群，见 [Observability Placement][dr-observability]。

**装在 infra 上的插件**

| 集群 | 节点池 | 插件 |
|---|---|---|
| global | infra | Alauda Container Platform Advanced Monitoring、Alauda Container Platform Log Storage Management、Alauda Data Services Analytical Database E1、Alauda Data Services Streaming E1 |
| workload (a) | infra | Advanced Monitoring、Log Storage Management、Analytical Database E1、Streaming E1、Alauda Container Platform Ingress Controller、Alauda Container Platform Registry |
| workload (b) | ingress | Ingress Controller |
| | monitor | Advanced Monitoring |
| | log | Log Storage Management、Analytical Database E1、Streaming E1 |
| | 待定 | Registry |
| 存储集群 | infra | Advanced Monitoring、Log Storage Management、Analytical Database E1、Streaming E1 |
| | storage | Alauda Storage（Ceph） |
| DevOps 集群 | infra | Advanced Monitoring、Log Storage Management、Analytical Database E1、Streaming E1 |

### 3. 操作步骤

| # | 做什么 | 文档 |
|---:|---|---|
| 1 | 规划，确认哪些网络流量适用 | [Plan][plan]、[Communication Matrix][comm-app] |
| 2 | 在写第一份 `install-config.yaml` 之前决定是否做容灾；做容灾时生成主备共用的密钥，并放通容灾所需的网络 | [Create a Global Cluster Disaster Recovery Pair][dr]、[Decide Before You Install][dr-decide] |
| 3 | 下载安装包 | [Download][download] |
| 4 | 准备平台镜像仓库并上传镜像；做容灾时主、备两侧都要上传 | [Prepare an External Platform Image Registry][ext-registry]、[mirror-registry][mirror-registry] |
| 5 | 满足公共前提和 provider 前提，主、备各准备一台 bootstrap | [Prerequisites][aos-prereq]；provider 前提见单集群第 5 步 |
| 6 | 规划每个节点池的磁盘。集群建好后磁盘布局不能再改 | [Fixed at Creation][fixed]、[Disk Configuration][disk] |
| 7 | 先安装主 global，再安装备 global | [Install the Primary and the Standby][dr-install] |
| 8 | 启动同步 | [Start Synchronization][dr-sync] |
| 9 | 向主、备 global 发布 Common Extensions | [Publish the Common Extensions][publish] |
| 10 | 在两套 global 上都声明 infra 标签和污点，并安装 TopoLVM、监控、日志、etcd 备份插件。这些插件要等两套都装好、同步运行后再装 | [Install the Cluster Plugins][dr-plugins]、[Infra Nodes][infra-aos]、[Install TopoLVM][topolvm]、[Advanced Monitoring][mon-vm]、[日志快速安装][log-fast]、[etcd Backup and Restore][etcd-backup] |
| 11 | 在 global 上安装要用到的 provider | [Install the Providers][wl-providers] |
| 12 | 客户没有商业存储时，先建存储集群，部署 Ceph 和 COSI。workload 集群上用到 RBD 或 RGW 的插件都依赖它 | [Cluster Creation Workflow][wl-workflow]、[Ceph on Alauda OS][ceph-aos]、[Install Ceph][ceph-install]、[COSI][cosi] |
| 13 | 需要 DevOps 工具时，建 DevOps 集群 | [Cluster Creation Workflow][wl-workflow] |
| 14 | 建 workload 集群：选定镜像仓库，按 (a) 或 (b) 档建节点池，再在节点池上声明角色标签和污点 | [Cluster Creation Workflow][wl-workflow]、[Choose the Image Registry][wl-registry]、[Custom Role Nodes][custom-role] |
| 15 | 在 workload 集群上依次安装：TopoLVM → 接入 Ceph → 监控 → 日志 → Ingress（没有商业负载均衡时加 MetalLB）→ 镜像仓库 → etcd 备份插件 | [Install TopoLVM][topolvm]、[External Mode][ceph-ext]、[Advanced Monitoring][mon-vm]、[日志快速安装][log-fast]、[Ingress Controller][ingress]、[MetalLB 组件位置][metallb-place]、[Install Registry][registry-install]、[Configure Registry][registry-config]、[etcd Backup and Restore][etcd-backup] |
| — | 故障切换 | [Fail Over][failover] |
| — | 以后升级 | [Upgrade Overview][upgrade]、[容灾环境的升级][upgrade-dr] |

[bootstrap-hw]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/prerequisites.html#bootstrap-host-requirements
[plan]: https://docs.alauda.io/container_platform/4.5/install/prepare/planning.html
[plan-machines]: https://docs.alauda.io/container_platform/4.5/install/prepare/planning.html#machines
[comm-app]: https://docs.alauda.io/container_platform/4.5/install/prepare/communication_matrix.html#applicability
[download]: https://docs.alauda.io/container_platform/4.5/install/prepare/download.html
[ext-registry]: https://docs.alauda.io/container_platform/4.5/install/prepare/external-platform-image-registry.html#prepare-the-target-version-payload
[mirror-registry]: https://docs.alauda.io/container_platform/4.5/install/prepare/mirror-registry.html
[aos-prereq]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/prerequisites.html
[endpoint]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/prerequisites.html#control-plane-endpoint
[install-config]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/reference.html#install-config
[bm-prereq]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/bare-metal/prerequisites.html
[dcs-prereq]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/huawei-dcs/prerequisites.html
[vs-prereq]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/vmware-vsphere/prerequisites.html
[hcs-prereq]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/huawei-cloud-stack/prerequisites.html
[bm-create]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/bare-metal/create_cluster.html
[dcs-create]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/huawei-dcs/create_cluster.html
[vs-create]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/vmware-vsphere/create_cluster.html
[hcs-create]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/huawei-cloud-stack/create_cluster.html
[fixed]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/#fixed-at-creation
[disk]: https://docs.alauda.io/container_platform/4.5/configure/scalability/disk_configuration.html
[dcs-raw]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/huawei-dcs/reference/install-config-parameters.html#raw-disks
[hcs-raw]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/huawei-cloud-stack/reference/install-config-parameters.html#add-raw-disks
[vs-raw]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/vmware-vsphere/reference/install-config-parameters.html#add-data-disks
[validation]: https://docs.alauda.io/container_platform/4.5/install/validation.html
[publish]: https://docs.alauda.io/container_platform/4.5/install/next_steps.html#publish_common_extensions
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
[dr-observability]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/global_dr.html#observability-placement
[failover]: https://docs.alauda.io/container_platform/4.5/install/alauda_os/disaster_recovery_failover.html
[wl-providers]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/#install-providers
[wl-workflow]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/#workflow
[wl-registry]: https://docs.alauda.io/container_platform/4.5/workload_clusters/alauda_os/prepare/#image-registry
[ceph-plan]: https://docs.alauda.io/container_platform/4.5/storage/storagesystem_ceph/planning.html
[ceph-aos]: https://docs.alauda.io/container_platform/4.5/storage/storagesystem_ceph/installation/immutable_infrastructure_prerequisites.html
[ceph-install]: https://docs.alauda.io/container_platform/4.5/storage/storagesystem_ceph/installation/
[ceph-ext]: https://docs.alauda.io/container_platform/4.5/storage/storagesystem_ceph/installation/access_storage_service.html
[cosi]: https://docs.alauda.io/container_platform/4.5/configure/storage/cosi/install.html

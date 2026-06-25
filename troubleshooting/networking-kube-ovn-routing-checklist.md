---
title: ACP Kube-OVN / Calico / Routing / Underlay Checklist
type: checklist
status: draft
domain: networking
product: acp
tags: [acp, networking, checklist, kube-ovn, calico, cni, routing, underlay, metallb, ticket-derived]
updated: 2026-06-20
source: [experience, ticket-cases]
related:
  - ../../product-catalog/office_docs/notes/networking-symptom-runbook.md
  - ../../product-catalog/office_docs/faqs/networking-faq.md
  - ../../product-catalog/office_docs/notes/networking.md
  - ./networking-underlay-node-add-bridge-nic-faq.md
  - ../knowledge-project-home.md
---

# ACP Kube-OVN / Calico / 路由 / Underlay 排查 Checklist

> 适合这类场景：
>
> - Pod 间网络不通
> - 节点换网段 / 双网卡 / bond 网卡后网络异常
> - 新建 Pod 提示 IP 冲突 / CNI 分配失败
> - Calico `node/controller/BGP/XDP` 相关异常
> - 外部可访问 VIP，但集群内或 underlay 容器访问异常

## 1. 先判断：更像哪一层

- [ ] Pod 间互访异常，更像 overlay / 路由 / CNI 状态问题
- [ ] 新建 Pod 报 IP 冲突，更像 IPAM / Subnet / 残留分配状态问题
- [ ] 节点换网段后异常，更像 OVN chassis / 路由残留问题
- [ ] Calico `node/controller/BGP` 异常，更像网卡探测 / 主机环境 / 路由传播 / 组件自身状态问题
- [ ] 只有 underlay / VIP / MetalLB 路径异常，更像 north-south 回流或二层/路由边界问题
- [ ] 看到 `kube-ovn-cni` 或 `calico-node` 关键字，但未必根因就在 CNI 本身

## 2. 现场必须先确认的 8 件事

- [ ] 问题是单 Pod、单节点、单子网还是全局异常
- [ ] 最近是否换过节点网段、双网卡、bond、默认路由
- [ ] 是否刚做过节点替换、节点重装、重新加集群
- [ ] 是否使用 Kube-OVN、Calico、underlay、MetalLB、ALB、Multus 等组合方案
- [ ] 新 Pod 失败时，报错是 IP 冲突、CNI add 失败、sandbox 创建失败还是路由不通
- [ ] 访问异常是东西向 Pod 通信，还是南北向 VIP / NodePort / underlay 回流
- [ ] 是否只有特定节点或特定网卡路径异常
- [ ] 是否重启过 CNI / kube-ovn / calico 组件但问题仍在

## 3. 如果是“节点换网段 / 双网卡 / Underlay 加节点后异常”

- [ ] 核对节点当前管理 IP 与历史 IP 是否一致
- [ ] 检查 `ovn-sbctl show` 是否仍残留旧 chassis / chassis_private 记录
- [ ] 核对节点重新加入后，控制面看到的地址是否已更新
- [ ] Underlay 新增节点前，确认桥接网络是否需要按节点指定物理网卡/bond/VLAN；不要默认自动识别结果适用于所有节点，参见 [[networking-underlay-node-add-bridge-nic-faq]]
- [ ] 不要把“节点已 Ready”直接等同于“Pod 网络链路已恢复”

## 4. 如果是“新 Pod 提示 IP 冲突 / CNI 分配失败”

- [ ] 确认冲突 IP 属于哪个 Subnet / IPPool
- [ ] 核对异常前是否存在节点异常、Pod 残留、IP 未回收
- [ ] 看问题是否集中在单节点或单子网
- [ ] 如果是 sandbox 创建失败，分清是镜像、secret、CNI 还是 kubelet 层
- [ ] 不要只因为事件里带 `FailedCreatePodSandBox` 就立刻把问题固化成镜像问题或纯 CNI 问题

## 5. 如果是“Calico BGP / controller / 网卡探测异常”

- [ ] 是否涉及 `calico-node`、`calico-controller`、`bird`、`felix`、`GlobalNetworkPolicy`
- [ ] 是否是升级、改 `podCIDR`、改网卡、改内核参数、改主机目录权限后出现
- [ ] 是否与 `IP_AUTODETECTION_METHOD`、`localhost` 解析、`/etc/hosts` 被脚本覆盖、`/var/log/calico` 权限、XDP 有关
- [ ] 不同网段节点不通时，是否把安全组 / `179/BGP` / 路由一起核对
- [ ] Calico 升级卡 `WaitReady` 时，是否已拆开 operator/CR/DaemonSet/节点就绪，而不是直接写成 Calico bug
- [ ] Calico controller 资源异常增长时，是否核对过节点剔除后的 `IPBlock` / `BlockAffinity` 残留
- [ ] 如果是 IPv6 / 双栈问题，是否区分清楚：`Service ipFamily/ipFamilyPolicy`、Pod/EP 是否真正具备 IPv6 地址、节点 IPv6 路由与 179 端口是否可达
- [ ] 如果是策略“看起来没生效”，是否先区分新连接与已建立连接，避免把连接跟踪行为误判成策略失效
- [ ] 不要把“删除探针后临时恢复”误当最终根因，通常只是绕过症状；若日志显示 lookup `localhost`，先核对节点 `/etc/hosts` 是否仍有 `127.0.0.1 localhost` / `::1 localhost`

## 6. 如果是“外部能通、集群内或 underlay 容器访问 VIP 不通”

- [ ] 访问的是 ClusterIP、NodePort 还是 VIP
- [ ] 是否混用了 MetalLB + ALB + underlay
- [ ] 是否涉及 `externalTrafficPolicy: Local`
- [ ] 回流路径是否经过不同节点、不同网卡、不同 VLAN
- [ ] 这类问题往往不是单纯应用故障，而是回程路由 / 二层可达 / 引流节点分布问题

## 6.1 如果是“Egress Gateway 已配置，但现场说流量没走 gateway”

- [ ] 先不要只盯 namespace 命中，继续核对 `podSelector` 与 `policies.subnets/ipBlocks`
- [ ] 如果 `trace` 已出现 `nat(src)`、`lr_in_policy`、`$VEG.xxx_ip4` 或逻辑路由阶段 `drop`，优先按“**已进入 VEG / OVN 处理链，但被策略误伤或落进异常成员路径**”理解
- [ ] 如果重启 egress gateway Pod 后恢复，不要急着下结论说业务 Pod 自愈；优先回看 gateway 创建/收敛瞬间、节点间网络抖动、BFD/ECMP 成员状态与 OVN address set/lr-policy 一致性
- [ ] 如果环境本身设计了 BFD，确认 BFD down 时是否会及时摘除对应节点上的 gateway Pod，避免异常成员继续留在路径里形成黑洞
- [ ] 看 `ovn-controller` 日志里是否存在 **BFD 对端 IP / next-hop 切换频繁**；如果有，这更支持“节点间网络不稳定 / BFD flap”，而不是单纯 selector/policy 写错
- [ ] 不要把“BFD down 就删 Pod”当成根因修复；它更像止血动作，根因仍要回到节点间网络稳定性和 OVN 收敛一致性
- [ ] 需要细看时，直接跳转：[ACP Kube-OVN Egress Gateway / BFD / 黑洞误判速记卡](./networking-kube-ovn-egress-gateway-bfd-blackhole-quick-card.md)


## 6.2 如果是“想限制业务使用 ovn-default / 子网绑定命名空间”

- [ ] 先确认目标是“业务专属网段”还是“禁止其它命名空间继续使用默认子网”。
- [ ] 不要把 Kube-OVN subnet 的 namespace 绑定当成 RBAC 权限开关；它本质影响 IP 分配范围。
- [ ] 不建议直接修改 `ovn-default` 的 namespace 绑定来做业务隔离，可能导致其它命名空间 Pod 无法继续从默认子网分配 IP。
- [ ] 推荐新建业务专属子网并绑定目标项目/命名空间，再用测试 Pod 验证 IP 来源。
- [ ] 变更前记录 `spec.namespaces`、exclude/reserved IP 和当前 Pod IP 分布；变更后用非绑定命名空间做最小分配验证。

代表案例：

- [TICKET-1351384014](../../ticket-documents/cases/TICKET-1351384014%20ovn-default网段，如果设置了命名空间，其他命名空间的权限问题.md)：`ovn-default` namespace 绑定是 IP 分配范围控制，不是 RBAC；业务隔离应新建专属子网。

## 6.3 Kube-OVN monitor 副本、VPC Egress Gateway selector 与 worker 重启影响边界

这类咨询多为配置/变更影响边界，先按短 FAQ 处理。

- `kube-ovn-monitor` 副本数要结合 Kube-OVN/OVN 版本确认；若对应版本现场与测试均只需单副本，不要把多副本探针失败直接扩展成网络故障。
- VPC Egress Gateway 的 `namespaceSelector.matchExpressions` 遵循 Kubernetes LabelSelector 语义，`NotIn` 可作为 selector operator；同时要注意字段应使用 `values`，不是单数 `value`。
- 单个 worker 节点正常重启通常不应直接影响其它节点上的 Pod 网络；若其它节点出现瞬时超时，要回到副本分布、业务连接、底层网络抖动和同窗日志证据，不要在无复现证据时冻结为 CNI 缺陷。

### 关联工单

- TICKET-1349910274：OVN 1.12.35 场景 kube-ovn-monitor 单副本即可，测试环境同口径。
- TICKET-1350182734：VPC Egress Gateway `namespaceSelector.matchExpressions` 支持 `NotIn`，字段名需使用 `values`。
- TICKET-1349835924：单 worker 重启通常不影响其它节点容器网络；历史超时缺日志复现，按变更影响边界处理。

### Deep-case 信号

- 当前判断：不需要。
- 原因：副本数、selector 字段和单节点重启影响均属于配置/变更边界 FAQ。
- 还缺什么证据：若要 deep-case，需要 Kube-OVN 版本、monitor Pod 事件/探针日志、EgressGateway YAML 与 OVN trace、worker 重启时间线、异常 Pod 所在节点、抓包和业务连接日志。

## 7. 最小证据清单

- [ ] 异常节点 / Pod / 子网 / VIP 列表
- [ ] 问题发生前后的网络变更点
- [ ] 关键报错（IP 冲突、sandbox、route、chassis）
- [ ] 是否为双网卡 / bond / underlay / Multus 场景
- [ ] 是否已有 `ovn-sbctl show`、相关组件日志、关键抓包或路由证据

## 7.1 Pod Sandbox 创建超时、`ovs-vsctl command took too long` 与 OVN 组件资源边界（2026-06-25）

适用场景：应用部分 Pod 报 `Failed to create pod sandbox: context deadline exceeded`，同时 `ovn-cni` 日志出现 `ovs-vsctl command took too long`；重启异常 Pod 后仍失败或变为 Init；进一步发现 `ovn-controller` OOM。

排查路径：

1. 先把 `FailedCreatePodSandBox` 拆成 kubelet/containerd/CNI/OVN 四层，不要只看 Pod 事件。
2. 在异常节点上确认 containerd/kubelet 日志中是否也有网络插件调用超时或 CNI add 失败。
3. 查看同节点 `kube-ovn-cni`、`ovn-controller`、`ovs-vswitchd/ovsdb-server` 的重启、OOM、资源限制和最近日志。
4. 如果 `ovs-vsctl command took too long` 与 `ovn-controller` OOM 同窗，优先按 OVN/OVS 控制面响应慢或资源不足处理；重启 CNI Pod 只是止血信号。
5. 调大资源或重启组件后，要验证新建 Pod、原异常 Pod、同节点其它 Pod 网络是否恢复，并保留恢复前后资源曲线。

处理建议：

- 短期可在确认控制器归属和影响面后重启异常 CNI/OVN 组件或上调 `ovn-controller` 资源；
- 中期需要回看该节点 Pod 密度、OVS 流表/端口数量、OVN Southbound 连接状态、组件 OOM 前资源趋势；
- 若只重启节点/CNI 后恢复但缺日志，记录为 evidence-boundary，不要固化成“重启即可”。

风险边界：

- `ovs-vsctl took too long` 是症状，不自动等于 OVS bug；可能来自资源、OVN 收敛、节点压力或底层 IO。
- 批量重启 CNI/OVN 组件可能影响同节点 Pod 网络，需维护窗口和回滚计划。

关联工单：

- TICKET-1355917414：部分 Pod Sandbox 创建超时，`ovn-cni` 日志提示 `ovs-vsctl command took too long`；后续发现 `ovn-controller` OOM，扩容资源后大部分 Pod 启动成功。

Deep-case 信号：

- 当前判断：建议 deep-case（若复发或生产影响扩大）。
- 原因：该模式涉及 Pod 创建、CNI 调用、OVN/OVS 响应和组件 OOM，短 FAQ 可用于定界，但完整根因需要时间线。
- 还缺什么证据：kubelet/containerd/CNI 日志、`ovn-controller` OOM 事件、资源曲线、OVS/OVN DB 状态、异常节点 Pod 密度、恢复动作前后对照和是否复发。

## 8. 支持现场一句话口径

- 这类问题先不要只盯某个 CNI Pod 或某条报错，更值得优先确认：**是不是节点地址、OVN chassis、Calico BGP / 网卡探测、IPAM 分配状态、回流路径或 underlay 约束发生了变化。**
- Kube-OVN 健康告警若同窗存在节点 `NotReady`、node lease 更新失败或 node→apiserver VIP `no route to host`，优先按节点到 VIP/底层路由/丢包排查；OVN Pod 重启可能只是下游表象。
- Underlay attach 跨网段不通时，ACP 子网额外路由和交换机直连路由都不能替代 Pod netns 内 `ip route`；必须核对 NAD、Pod annotation、Pod 路由和双点抓包。
- Kube-OVN 告警叠加 Node NotReady 时，先把 node→apiserver VIP `no route to host`、VIP 承载/ARP/MAC、OVS 历史日志和告警刷新链拆开；代表样本：[TICKET-1352084174](../../ticket-documents/cases/TICKET-1352084174%20kube%20ovn组件实时告警，组件健康状态不健康.md)。
- Underlay 重新部署后恢复但缺前后 diff 时，只能作为 NAD/Pod 路由一致性边界样本；代表样本：[TICKET-1352119154](../../ticket-documents/cases/TICKET-1352119154%20underlay子网网络不通.md)。

## 9. 参考案例

- [TICKET-1339132964](../../ticket-documents/cases/TICKET-1339132964%20节点切换网段发现Pod间网络不通.md)：节点换网段后，需清理 `ovn-central` 中旧 chassis 记录
- [TICKET-1272576524](../../ticket-documents/cases/TICKET-1272576524%20生产环境k8s有个节点网络通信有问题，重启了kube-ovn-cni也无效.md)：提醒“看到 Kube-OVN 关键字，不等于根因一定在 Kube-OVN”
- [TICKET-1319676714](../../ticket-documents/cases/TICKET-1319676714%20Kube‑OVN%20CNI%20FailedCreatePodSandBox.md)：sandbox 创建失败，需要拆分镜像 / secret / CNI / kubelet 层
- [TICKET-1346662234](../../ticket-documents/cases/TICKET-1346662234%20使用metallb+alb+underlay网络方案，容器内无法访问vip.md)：外部可访问 VIP，但同 underlay 容器访问异常
- [TICKET-1284996104](../../ticket-documents/cases/TICKET-1284996104%20宝信-节点异常后新建pod提示分配的ip冲突.md)：节点异常后新建 Pod 提示 IP 冲突
- [TICKET-1312282404](../../ticket-documents/cases/TICKET-1312282404%20添加节点不成功，只能添加eth0网口的节点.md)：双网卡 / bond 网卡场景下新增节点异常
- [TICKET-1279868854](../../ticket-documents/cases/TICKET-1279868854%20calico-node%20启动失败，%20临时删除探针暂时运行.md)：`localhost` 解析缺失导致 `calico-node` 启动失败；删除探针只是绕过症状，根因在节点 `/etc/hosts` 被脚本注入破坏
- [TICKET-1282049024](../../ticket-documents/cases/TICKET-1282049024%20集群calico-node的0%201，新启动的pod无法分配IP.md)：`calico-node 0/1` 但存量业务未断、新 Pod 无法分 IP 时，要拆 Calico 控制面与 apiserver loopback 证书链路
- [TICKET-1329001544](../../ticket-documents/cases/TICKET-1329001544%20升级之后calico-controller无法和kubernetes通信.md)：升级后 `calico-controller` 与 Kubernetes 通信异常
- [TICKET-1323419274](../../ticket-documents/cases/TICKET-1323419274%20calico集群不同网段节点pod无法连通.md)：Calico 集群不同网段节点间 Pod 不通
- [TICKET-1339138194](../../ticket-documents/cases/TICKET-1339138194%20systemd-udevd%20正在反复尝试配置%20Calico%20临时网卡导致虚拟机负载高.md)：Calico 临时网卡与 `systemd-udevd` / XDP 交互问题
- [TICKET-1304429934](../../ticket-documents/cases/TICKET-1304429934%20calico更改podcidr后calico-node启动异常.md)：更改 `podCIDR` 后 `calico-node` 启动异常，最终落到主机目录权限
- [TICKET-1341876714](../../ticket-documents/cases/TICKET-1341876714%20新建calicoBGP集群更新bgpconfiguration失败.md)：Calico BGP 集群配置下发异常
- [TICKET-1267493544](../../ticket-documents/cases/TICKET-1267493544%20ipv4、ipv6双栈场景下，ipv6加nodeport访问不通。.md)：双栈下 IPv4 通、IPv6 + NodePort 不通，最终落到 Service 双栈配置与监听边界
- [TICKET-1294487924](../../ticket-documents/cases/TICKET-1294487924%20华为云上安装ipv6双栈灵雀云，nodeport%20服务分发，有个节点上的节点分发不成功.md)：双栈 Calico + NodePort，部分节点分发失败，现场曾用关闭网卡 checksum 临时规避
- [TICKET-1315947044](../../ticket-documents/cases/TICKET-1315947044%20calico网络，访问ipv6地址没找到路由.md)：Calico 双栈 / IPIP 下 IPv6 路由、Pod CIDR 与 179 端口边界
- [TICKET-1264432704](../../ticket-documents/cases/TICKET-1264432704%20k8s配置真实ip.md)：Calico IPIP 模式下真实 IP / DMZ 节点诉求
- [TICKET-1343171494](../../ticket-documents/cases/TICKET-1343171494%20calico%20网络策略显示限制还是隐式限制.md)：Calico 策略对已建立连接的连接跟踪边界
- [TICKET-1280584344](../../ticket-documents/cases/TICKET-1280584344%20咨询下，同一个k8s集群，用的calico%20ipip网络，不同命名空间的pod能ping通吗？.md)：Calico IPIP 默认互通，异常时优先回看 NetworkPolicy

## 10. checksum/offload 与封装网络误判补充（2026-05-30）

来自 [TICKET-1310159644](../../ticket-documents/cases/TICKET-1310159644%20overlay+underlay升级后导致checksum%20offload根因排查.md) 的补充：

- [ ] overlay + underlay / Geneve 场景升级后新节点网络异常时，确认是否有 `encap-checksum=false`、关闭 TX/RX checksum 后恢复的强信号。
- [ ] 记录 OS、内核、网卡型号、驱动版本、`ethtool -k` offload 参数，区分平台规避动作与底层 OS/驱动归因。
- [ ] 抓包看到 checksum 异常时，先标注抓包点位；TSO/GSO/GRO/LRO 可能制造 apparent checksum error，不能只凭单点抓包下结论。
- [ ] 关闭 offload 前后要做同路径连通性和性能对比，并记录是否需要持久化配置、升级或重启后是否回退。

## 10.1 麒麟 / bond / kubernetes Service 443 超时补充（2026-06-04）

来自 [[../../ticket-documents/cases/TICKET-1352202734 新建集群报连接kubernetes 443报错|TICKET-1352202734]] 的补充：

- [ ] 如果 Pod 访问 `kubernetes` Service IP/443 超时，但节点访问同一地址正常，先拆 Pod 数据面/CNI/bond/offload，不要直接判 apiserver 异常。
- [ ] 麒麟 + bond 场景优先查看 `ethtool -k bond0 | grep tx-checksum`，关闭 `tx-checksum-ip-generic` 做同路径 A/B。
- [ ] 抓包 checksum 异常可能是 offload 观测假象；结论要以关闭前后功能验证、内核/驱动/网卡基线和重启后复测为准。
- [ ] 如果 A/B 成立，必须把 ethtool 参数固化到 OS/网卡初始化基线，避免重启或 bond 重建后回退。

## 11. 根盘满后的 OVN 控制面恢复边界（2026-05-31）

来自 [[TICKET-1317806614 ovn-central启动失败]]、[[../../ticket-documents/cases/TICKET-1352117714 腾讯TI补单-陕西农信 磁盘清理后 kube-system 下的 ovn-central启动失败|TICKET-1352117714]] 的补充：

- `ovn-central` 起不来前若发生过根盘满 / inode 满 / 写入失败，不要把它视作独立 OVN 故障。
- 清理磁盘空间只是止血；还要确认 OVN NB/SB、`ovn-central` Pod 与单节点恢复链是否已收敛。
- 若日志指向 Raft WAL / commit index / log index 不一致，先确认其它 OVN central 成员健康；仅在 HA 健康且单成员本地 DB 损坏时，备份移走该节点 `/etc/origin/ovn/ovnnb_db.db` 与 `ovnsb_db.db` 后重建对应 Pod。
- 不要把移走 NB/SB DB 当成通用命令，更不能在未确认 HA 状态时批量清多个成员。
- 复盘时保留“容量事故 → OVN 控制面状态受损 → 单节点恢复”的顺序，避免把清空间后仍异常误判成新的网络故障。

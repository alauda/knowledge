---
title: ACP Networking FAQ
type: faq
status: active
domain: networking
product: acp
tags: [acp, networking, faq, gateway-api, envoy-gateway]
updated: 2026-05-13
source: [official-docs, experience]
related:
  - ../notes/networking.md
  - ../../../knowledge_base/troubleshooting/gateway-cross-namespace-tls-runbook.md
  - ../../../knowledge_base/README.md
---

# ACP Networking FAQ

## Envoy Gateway / Gateway API

### 怎么允许其他 namespace 的 Route 绑定到这个 Gateway？
看 `Gateway.spec.listeners[].allowedRoutes.namespaces.from`：
- `All`
- `Same`
- `Selector`

### Gateway 想用别的 namespace 里的 TLS Secret，直接引用可以吗？
不行。需要在证书所在 namespace 创建 `ReferenceGrant`。

### Envoy Gateway / Ingress NGINX / ALB 这几层里，VIP、L4、L7 分别是谁在负责？
可按这条链路理解：**客户端 → DNS → VIP/LoadBalancer Service(L4) → Envoy/NGINX/ALB 代理(L7) → Service → Pod**。
- **VIP / LoadBalancer / MetalLB**：解决“流量先打到哪里”
- **Envoy / Ingress NGINX / ALB**：解决“按 host/path/header/TLS 怎么转”
- **Service**：把已选中的后端流量再分发到 Pod

所以排障时，先判断是 **L4 入口没通**，还是 **L7 路由没命中**。如果需要按现象快速分诊，直接翻 `notes/networking-symptom-runbook.md`，里面已按 **404 / 503 / TLS / 源 IP / 集群内外差异 / 非 HTTP 流量** 组织成支持手册。

### 怎么把 Envoy Gateway 的最小 TLS 版本改成 1.3？
给目标 `Gateway` 绑定 `ClientTrafficPolicy`，在 `.spec.tls.minVersion` 里设成 `1.3`。

### NodePort 模式下，为什么访问不能用 listener 原始端口？
因为真正暴露的是 Kubernetes 分配的 NodePort。若想固定值，可在 `EnvoyProxy` 对应 Service 里显式指定。

### 怎么给 Envoy Gateway 固定一个 MetalLB VIP？
在 `EnvoyProxy.spec.provider.kubernetes.envoyService.annotations` 中设置 MetalLB 的 address pool 和 `loadBalancerIPs`。

### Envoy Gateway 能直接做灰度分流或权重切流吗？
可以。`HTTPRoute.rules[].backendRefs` 支持 `weight`，适合做简单按比例分流；如果还要求会话保持，再配 `BackendTrafficPolicy.sessionAffinity`。

### Envoy Gateway 开 `hostNetwork` 后，为什么 80/443 实际变成 10080/10443？
这是默认推荐的端口偏移方案。若要直接监听 80/443，需要启 `useListenerPortAsContainerPort` 并给 envoy `NET_BIND_SERVICE`。

### 为什么集群内访问 LoadBalancer VIP 有时失败？
常见原因是 `externalTrafficPolicy: Local`，流量落到无 Envoy Pod 的节点时不会再转发。集群内优先使用 ClusterIP。

**参考案例：**
- [TICKET-1346662234 使用metallb+alb+underlay网络方案，容器内无法访问vip](../../../ticket-documents/cases/TICKET-1346662234%20使用metallb+alb+underlay网络方案，容器内无法访问vip.md)

## OCP Route → Gateway API

### 最核心的字段映射是什么？
- `spec.host` → `HTTPRoute.spec.hostnames`
- `spec.to + spec.port.targetPort` → `rules[].backendRefs`
- 注解类高级能力 → `filters` / `timeouts` / `sessionPersistence`

### 迁移时最容易忽略的差异是什么？
- Gateway API 没有 tunnel 专属 timeout
- Gateway API 没有全局 HSTS 强制策略

## Network Policy

### ACP 里这三类策略优先级怎么排？
`AdminNetworkPolicy > NetworkPolicy > BaselineAdminNetworkPolicy`

### AdminNetworkPolicy 的 `Pass` 是什么意思？
跳过更低优先级的 admin policy，继续交给普通 `NetworkPolicy` 或 `BaselineAdminNetworkPolicy` 处理。

### BaselineAdminNetworkPolicy 有什么硬限制？
整个集群只能有一个，名字必须是 `default`。

### AdminNetworkPolicy 是所有集群都能用吗？
不是。文档明确写的是**当前只有 Kube-OVN 支持**，而且成熟度还是 **Alpha**。

### AdminNetworkPolicy 的 priority 怎么理解？
**数字越小优先级越高**。这是很容易答反的点。

### 普通 NetworkPolicy 有什么常见盲区？
不作用于 `hostNetwork` Pod。

**参考案例：**
- [TICKET-1297918764 创建networkpolicy之后，通过ALB的访问无法访问](../../../ticket-documents/cases/TICKET-1297918764%20创建networkpolicy之后，通过ALB的访问无法访问.md)
- [TICKET-1265018734 工单99001，判断集群网络策略会把NodePort端口影响，如何解决？](../../../ticket-documents/cases/TICKET-1265018734%20工单99001，判断集群网络策略会把NodePort端口影响，如何解决？.md)

### Calico / iptables 策略已经改了，为什么流量还在通？
先区分 **新连接** 还是 **已建立连接**。Calico / iptables 常见现象是：
- **新连接** 已被拦截
- **已建立连接** 因连接跟踪（conntrack）仍可继续通过

所以“策略改了但老流量没立刻断”不一定是策略失效，更可能是连接跟踪的正常表现。

**参考案例：**
- [TICKET-1343171494 calico 网络策略显示限制还是隐式限制](../../../ticket-documents/cases/TICKET-1343171494%20calico%20网络策略显示限制还是隐式限制.md)
- [TICKET-1280584344 咨询下，同一个k8s集群，用的calico ipip网络，不同命名空间的pod能ping通吗？](../../../ticket-documents/cases/TICKET-1280584344%20咨询下，同一个k8s集群，用的calico%20ipip网络，不同命名空间的pod能ping通吗？.md)

### 想按项目统一做“不能随便出网 / 只能走特定出口”，Calico 能做吗？
可以，常见思路是结合标签做 `GlobalNetworkPolicy`，把“是否允许访问外网”收敛成平台级规则，而不是让每个项目都逐节点开防火墙。

**参考案例：**
- [TICKET-1268295804 gateway api出入口网关控制需求](../../../ticket-documents/cases/TICKET-1268295804%20gateway%20api出入口网关控制需求.md)

### 用户说“我看不到新的网络策略界面”，先查什么？
先查 feature gate：
- 普通 NetworkPolicy 新界面：`network-policy-next`
- 集群级策略新界面：`cluster-network-policy`、`cluster-network-policy-next`

## ALB / Ingress NGINX / Endpoint Health Checker

### 现在还推荐继续用 ALB 吗？
不推荐。文档已明确标注 **ALB 已废弃**，优先使用 `ingress-nginx-operator` 或 `envoy-gateway`。

### ALB 里最核心的对象关系是什么？
`ALB2 -> Frontend(端口/协议) -> Rule(路由)`；leader 负责把 Ingress 翻译成 Rule，并按证书自动补 80/443 的 FT。

### ALB 的 host/container 网络模式有什么区别？
- `host`：直接用 hostNetwork，通过节点 IP 访问
- `container`：operator 自动创建 LoadBalancer Service，并用其地址作为 ALB 地址

**参考案例：**
- [TICKET-1297918764 创建networkpolicy之后，通过ALB的访问无法访问](../../../ticket-documents/cases/TICKET-1297918764%20创建networkpolicy之后，通过ALB的访问无法访问.md)

### ALB 怎么选共享方式？
- **单项目按实例分配**：最推荐，隔离最好
- **多个项目共享实例**：运维简单，但互相影响风险更高
- **按端口共享**：隔离更强，但管理复杂度最高

### ALB 多大规模时更稳妥？
- 小规模：单 ALB，至少 2 副本
- 中规模：单 ALB，至少 3 副本
- 大规模：多个 ALB，每个至少 3 副本

### ALB 支持哪些认证方式？
主要两类：
- `forward auth`：把认证请求转发给外部认证服务
- `basic auth`：基于用户名密码的简单保护

补充一个容易踩坑点：basic auth 只支持 `apr1`，**不支持 digest**。

### ALB 想让某个路径绕过认证，怎么做？
可在 Ingress 上显式加：`alb.ingress.cpaas.io/auth-enable: "false"`。

### ALB 的 `proxy-read-timeout` 是整个请求最长时间吗？
不是。它表示**两次连续读之间允许空闲多久**；`proxy-send-timeout` 也是同理，表示两次连续写之间的空闲超时，不是总耗时上限。

### ALB 的 keepalive 是不是也管后端连接？
不是。文档明确说 Frontend keepalive 只作用于**客户端到 ALB**，不作用于 **ALB 到后端**。

### ALB 配了 `ssl-redirect` 为什么没生效？
先看这个域名是否已经有证书。`ssl-redirect` 只有在 Ingress 上已有对应证书时才会生效；如果无证书也要强跳 HTTPS，用 `force-ssl-redirect`。

### 外部 LB 挂在 ALB 前面时，健康检查该探哪个端口？
- **global 集群**：`11782`
- **业务集群**：`1936`

这点很适合先做最小验证，不然外部 LB 可能一直把 ALB 判死。

### ALB 为什么绑了指定网卡后还报 IPv6 监听问题？
因为 ALB 默认仍会尝试监听 `::`。如果指定 NIC 没 IPv6 地址，通常要一起考虑关闭 IPv6。

### ALB 除了轮询，还支持哪些会话保持/负载算法？
支持：
- `rr`
- `sip-hash`
- `cookie`
- `header`
- `ewma`

其中：
- `cookie` 默认 cookie 名是 `JSESSIONID`
- `ewma` 更适合后端响应时延差异明显的场景

### Ingress NGINX Operator 怎么限制它只处理某些 namespace 的 Ingress？
在 `IngressNginx.spec.controller.scope.namespaceSelector` 配 label selector，例如 `cpaas.io/project=demo`。

### Ingress NGINX 默认会不会接管没写 IngressClass 的 Ingress？
会。文档默认值是 `.spec.controller.watchIngressWithoutClass=true`。

**参考案例：**
- [TICKET-1288114874 alb 转发规则不匹配](../../../ticket-documents/cases/TICKET-1288114874%20alb%20转发规则不匹配.md)

### Ingress NGINX 想暴露成 LoadBalancer 并固定 VIP，怎么做？
把 `IngressNginx.spec.controller.service.type` 设为 `LoadBalancer`；若配合 MetalLB，可加：
- `metallb.universe.tf/loadBalancerIPs`
- `metallb.universe.tf/address-pool`

### Ingress NGINX 把 Service 改成 LoadBalancer 后，为什么还没有外部 IP？
因为 `type=LoadBalancer` 只是向 Kubernetes 声明“我要一个北向入口”。真正分配外部 IP 的还得是**云厂商 LB**或 **MetalLB**。如果底层没人实现这层能力，Service 只会一直 Pending，没有可用 VIP。

### Ingress NGINX 开 SSL passthrough 后，为什么 rewrite / WAF / redirect / 部分鉴权像失效了？
因为这时 TLS 没在 Ingress NGINX 终止，而是直接透传到后端。代理层只能按 TCP/SNI 转发，看不到完整 HTTP 明文，请求头改写、URL rewrite、WAF、HTTP→HTTPS redirect 这类典型 L7 能力自然无法作用。

### Ingress NGINX 怎么保留真实源 IP？
两种常见方式：
- 上游 LB 开 PROXY protocol，Ingress NGINX 配 `use-proxy-protocol=true`
- LoadBalancer Service 配 `externalTrafficPolicy: Local`，但要确保 pod 调度节点与可引流节点一致

**参考案例：**
- [TICKET-1316507134 web应用部署到灵雀云，应用获取不到客户端真实ip，获取到的是负载IP，如何获取真实ip](../../../ticket-documents/cases/TICKET-1316507134%20web应用部署到灵雀云，应用获取不到客户端真实ip，获取到的是负载IP，如何获取真实ip.md)
- [TICKET-1296857274 alb客户端真实IP透传](../../../ticket-documents/cases/TICKET-1296857274%20alb客户端真实IP透传.md)

### Ingress NGINX 常见高阶能力通常配在哪里？
大多靠 upstream 的 configmap / annotation：比如 max connections、timeout、sticky session、header rewrite、HSTS、rate limit、WAF、TLS passthrough、后端 HTTPS 校验。

### Endpoint Health Checker 是干什么的？
它会主动探测 endpoint 健康状态，把不健康 endpoint 从 Service 流量面摘掉，目标是把节点掉电时的切换时间从约 40 秒缩短到约 10 秒。

### Endpoint Health Checker 新部署推荐怎么启用？
优先用 pod annotation：`endpoint-health-checker.io/enabled: 'true'`。旧的 `readinessGates` 方式属于 legacy。

## Calico

### 双栈 / IPv6 下，为什么 IPv4 通、IPv6 + NodePort 不通？
优先别先怀疑“Calico 整体坏了”，先拆 3 层：
1. `Service.ipFamilies / ipFamilyPolicy` 是否真的按双栈声明
2. Pod / Endpoint 是否真的拿到了 IPv6 地址
3. 节点间 IPv6 路由、`179/BGP`、底层网卡能力是否具备

很多现场问题不是“IPv6 完全不支持”，而是 **Service 仍只暴露 IPv4**、业务监听没覆盖 IPv6，或者节点侧 IPv6 / BGP / checksum 存在边界问题。

**参考案例：**
- [TICKET-1267493544 ipv4、ipv6双栈场景下，ipv6加nodeport访问不通。](../../../ticket-documents/cases/TICKET-1267493544%20ipv4、ipv6双栈场景下，ipv6加nodeport访问不通。.md)
- [TICKET-1282742764 业务定义的nodeport类型的服务，使用ipv6 地址+端口访问无法访问，帮忙定位如何解决](../../../ticket-documents/cases/TICKET-1282742764%20业务定义的nodeport类型的服务，使用ipv6%20地址+端口访问无法访问，帮忙定位如何解决.md)
- [TICKET-1294487924 华为云上安装ipv6双栈灵雀云，nodeport 服务分发，有个节点上的节点分发不成功](../../../ticket-documents/cases/TICKET-1294487924%20华为云上安装ipv6双栈灵雀云，nodeport%20服务分发，有个节点上的节点分发不成功.md)
- [TICKET-1315947044 calico网络，访问ipv6地址没找到路由](../../../ticket-documents/cases/TICKET-1315947044%20calico网络，访问ipv6地址没找到路由.md)

### Calico 识别不了 IPv6 地址时，先查什么？
先看 `IP_AUTODETECTION_METHOD` 与现场 IPv6 地址获取方式是否匹配。某些 DHCP / can-reach 场景下，默认探测方式可能识别不到，需要 hotfix 或调整探测策略。

**参考案例：**
- [TICKET-1286334904 calico识别不了IPV6](../../../ticket-documents/cases/TICKET-1286334904%20calico识别不了IPV6.md)

### Calico BGP / RR 场景下，为什么节点间学不到路由？
先别只看“BGP Peer 配了没有”，要一起看：
- RR / client 角色是不是符合方案
- `nat outgoing` 开关是否改变了你的现象
- 现场到底是“路由没学到”，还是“学到了但实际出流量仍走 NAT / 默认路由”

**参考案例：**
- [TICKET-1327861174 calico集群使用bgp网络咨询1](../../../ticket-documents/cases/TICKET-1327861174%20calico集群使用bgp网络咨询1.md)
- [TICKET-1341876714 新建calicoBGP集群更新bgpconfiguration失败](../../../ticket-documents/cases/TICKET-1341876714%20新建calicoBGP集群更新bgpconfiguration失败.md)

### 新增节点时，为什么总报网卡名不对 / 只能识别某张卡？
这类问题通常不是“节点不能加”这么简单，而是平台侧网卡校验 + Calico autodetection 口径没对齐。要一起看：
- 平台组件是否在做固定网卡名校验
- `IP_AUTODETECTION_METHOD` 是否和现场 `ens* / bond* / eth*` 一致
- 是“平台阻止加节点”，还是“节点加进来后 Calico 识别错卡”

**参考案例：**
- [TICKET-1312282404 添加节点不成功，只能添加eth0网口的节点](../../../ticket-documents/cases/TICKET-1312282404%20添加节点不成功，只能添加eth0网口的节点.md)
- [TICKET-1305916434 集群添加节点网卡名称报错](../../../ticket-documents/cases/TICKET-1305916434%20集群添加节点网卡名称报错.md)

### calico-node 不 Ready，会不会立刻影响现有业务流量？
不一定。更典型的边界是：
- **已在跑的业务** 可能暂时不受影响
- **新启动 Pod** 可能无法继续分配 IP / 建立新网络状态

所以现场要分清“存量转发是否还在工作”与“增量调度 / 新建 Pod 是否已失效”。

**参考案例：**
- [TICKET-1282049024 集群calico-node的0 1，新启动的pod无法分配IP](../../../ticket-documents/cases/TICKET-1282049024%20集群calico-node的0%201，新启动的pod无法分配IP.md)
- [TICKET-1279868854 calico-node 启动失败， 临时删除探针暂时运行](../../../ticket-documents/cases/TICKET-1279868854%20calico-node%20启动失败，%20临时删除探针暂时运行.md)

### /etc/cni/net.d/calico-kubeconfig 里的 token 变了，是不是异常？
不一定。它可能是认证过程中的动态变化，先别把“token 变了”直接等同于故障。要结合 Pod 创建失败、认证报错、apiserver / 证书状态一起判断。

**参考案例：**
- [TICKET-1295352924 操作系统迁移，提示 etc cni net.d calico-kubeconfig的token变化了](../../../ticket-documents/cases/TICKET-1295352924%20操作系统迁移，提示%20etc%20cni%20net.d%20calico-kubeconfig的token变化了.md)
- [TICKET-1308517524 管理后台对所有业务集群Calico token到期时间统一查询方法咨询](../../../ticket-documents/cases/TICKET-1308517524%20管理后台对所有业务集群Calico%20token到期时间统一查询方法咨询.md)

## Kube-OVN

### Centralized Gateway 和 Egress Gateway 怎么选？
- **Centralized Gateway**：子网级固定出口，适合审计、源 IP 白名单、简单运维
- **Egress Gateway**：工作负载级控制，支持更细粒度 selector/policy、水平扩展和更快故障切换

### Centralized Gateway 有什么容易忽略的限制？
该子网下的 Pod 不能通过 `hostPort` 或 `externalTrafficPolicy: Local` 的 NodePort Service 被访问。

### Centralized Gateway 里的 gatewayNode 和 gatewayNodeSelectors 怎么排？
`gatewayNode` 优先；如果它不为空，`gatewayNodeSelectors` 会被忽略。

### Egress Gateway 的前置条件里最关键的是什么？
必须先装 **Multus CNI**，并提前规划好外部 underlay 网络、VLAN、bridge、NAD 和 external subnet。

### Egress Gateway 怎么看是否工作正常？
先看 `kubectl get veg` 的 `PHASE/READY/INTERNAL IPS/EXTERNAL IPS/WORKING NODES`，再进 gateway Pod 检查 `ip address/ip rule/ip route/iptables`，必要时抓包。

**参考案例：**
- [TICKET-1339132964 节点切换网段发现Pod间网络不通](../../../ticket-documents/cases/TICKET-1339132964%20节点切换网段发现Pod间网络不通.md)
- [TICKET-1319676714 Kube‑OVN CNI FailedCreatePodSandBox](../../../ticket-documents/cases/TICKET-1319676714%20Kube‑OVN%20CNI%20FailedCreatePodSandBox.md)

### Egress Gateway 开了多副本后会怎么分流？
OVN 会按源地址哈希把流量 ECMP 分散到多个 gateway 实例；配 BFD 后还能更快切走故障实例。

### 为什么 Kube-OVN 调大 MTU 后还可能丢包？
因为 `ovn0` 会取 `br-int` 上最小 MTU；如果旧 Pod 还是小 MTU、新 Pod 已是大 MTU，流量可能被丢弃。所以 **增大 MTU 后必须重建所有 Pod**。

### IPPool 和 Subnet 的关系是什么？
IPPool 是比 Subnet 更细粒度的 IPAM 单元，可以把一个 Subnet 拆成多个 IP 池，并按 namespace 或 Pod 注解分配。

### 做 cluster interconnection 时最硬的前提是什么？
至少要满足：
- 不同集群的 subnet CIDR 不能重叠
- 只能用于 **default VPC**
- 各集群都要有可达的 gateway nodes / interconnect controller 节点

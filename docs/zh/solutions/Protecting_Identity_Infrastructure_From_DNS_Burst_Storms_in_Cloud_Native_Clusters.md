---
kind:
  - BestPractices
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500006
sourceSHA: e86422feb3c07a73ab958f111d143155bbe7575391f296da3c7923d5556eb400
---

# 保护云原生集群中的身份基础设施免受 DNS 突发风暴的影响

## 概述

将工作负载从少量虚拟机迁移到高密度的 Kubernetes 集群，会改变上游身份/DNS 服务需要吸收的 DNS 流量形态。稳定的低速递归查询流被并行突发所取代：单个 Deployment 扩展出几百个 pods，或者一个节点排空并重新调度其工作负载，可以在毫秒内发出数千个解析请求。

当上游解析器是一个基于 BIND 的身份管理 (IdM) 服务，并针对通用用途进行了调优时，递归客户端的限制通常是第一个遇到的瓶颈。超出限制并不会产生明显的错误：BIND 会默默丢弃最旧的等待查询以保护其内存，应用程序会看到超时，IdM 主机显示 CPU 和 RAM 使用率低，而运维团队则被留在追逐一个虚幻的网络问题。

本文描述了一种深度防御策略，包含两个互补的变化：

- 提高上游 BIND 的递归客户端上限，以便突发不会触发硬限制；
- 在集群内的 CoreDNS 上启用缓存，以便突发根本不会到达上游。

## 根本原因

每个到达递归解析器的查询占用一个 *递归客户端插槽* — 这是一个在 DNS 层次结构中完整往返期间持续存在的内存保留。在虚拟机工作负载下，插槽数量很少会成为问题；在 Kubernetes 并行性下，它成为一个硬限制。

使集群情况更糟的放大器是 **搜索域扩展**。当一个 pod 解析短名称时，集群解析器会在返回正面答案之前遍历搜索路径：

```text
# Pod 请求:  myapi
# 解析器通过搜索域扩展：
1.  myapi.<namespace>.svc.cluster.local   -> NXDOMAIN  (上游命中)
2.  myapi.svc.cluster.local                -> NXDOMAIN  (上游命中)
3.  myapi.cluster.local                    -> NXDOMAIN  (上游命中)
4.  myapi.example.com                      -> resolved (正面答案)
```

如果集群侧缓存被禁用，每次 pod 重启、扩展或批处理作业都会重新运行该 NXDOMAIN 序列，并将上游推向其限制：

```text
# negativeTTL = 0:    100 pods x 3 NXDOMAIN x 5 services = 1,500 上游查询
# negativeTTL = 10s:                              3 x 5  =    15 上游查询
```

通过单一的缓存侧更改，可以实现高达 99% 的上游压力减少。

## 解决方案

### 步骤 1：提升 BIND 递归客户端上限

在上游 IdM / BIND 服务器上，将 `recursive-clients` 从保守的默认值提高到与集群并行性相匹配的值：

```text
# /etc/named.conf  (或 /etc/named/options.conf 在 IdM 上)
options {
    recursive-clients 10000;
};
```

从 900 跃升至 10,000 个并发递归客户端大约需要额外 50 MB 的 RAM — 低于 6 GB 主机的 1%。更改后重新加载 `named`，并通过检查服务器的运行时统计信息确认新限制已生效。

此步骤保护上游免受冲击，同时集群侧缓存正在推出。这并不是缓存的替代方案。

### 步骤 2：在集群内的 CoreDNS 上启用缓存

集群运行 CoreDNS 作为 DaemonSet — 每个工作节点一个解析器 pod，处理该节点上所有 pods 的 DNS。`cache` 插件已加载，但默认情况下，正面和负面 TTL 都为 0，这使得本地解析器表现得像一个纯粹的透传。

两个重要参数：

- **positiveTTL** — 成功答案（解析为 IP 的域名）被缓存的时间。默认值为 0，推迟到记录本身的 TTL，对于短 TTL 的内部服务在突发期间提供的保护很少。
- **negativeTTL** — NXDOMAIN 响应被缓存的时间。这个参数的杠杆作用更大，因为上面的搜索域扩展将每个短名称查找转变为多个 NXDOMAIN 查询。

一个典型的起始点是 30–60 秒的正面 TTL 和 10–30 秒的负面 TTL。如果您的应用程序期望快速记录更改，请缩短正面 TTL；对于读重的工作负载，请放宽负面 TTL。

通过其 ConfigMap 编辑 CoreDNS Corefile 并重新加载：

```yaml
# kubectl -n kube-system edit configmap coredns
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health { lameduck 5s }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }
        prometheus :9153
        forward . /etc/resolv.conf {
            max_concurrent 1000
        }
        cache {
            success 9984 30
            denial 9984 15
        }
        loop
        reload
        loadbalance
    }
```

保存后，重启 CoreDNS pods 以使其获取新的 Corefile：

```bash
kubectl -n kube-system rollout restart deployment coredns
kubectl -n kube-system rollout status deployment coredns --timeout=2m
```

允许几分钟时间让缓存预热；上游应立即看到流量下降，并逐渐趋向小的稳定状态。

### 步骤 3：验证端到端

通过从测试 pod 发出两个连续查找并比较延迟来确认缓存是否处于活动状态。镜像必须包含 `dig`；公共镜像如 `registry.k8s.io/e2e-test-images/jessie-dnsutils:1.7` 可能无法从隔离集群访问 — 用任何在集群内的镜像替代，该镜像提供 `bind-utils` / `dnsutils`：

```bash
kubectl run dns-probe --image=<image-with-dig> \
  --restart=Never --rm -it -- /bin/sh -c \
  'time dig +short kubernetes.default.svc.cluster.local; time dig +short kubernetes.default.svc.cluster.local'
```

第二个查询应在一毫秒内完成 — 证明本地缓存提供了服务。在上游，BIND 的 `rndc stats`（或等效指标）应显示递归客户端的高水位标记远低于新上限。

## 诊断步骤

检查实时 Corefile 以确认缓存指令存在：

```bash
kubectl -n kube-system get configmap coredns -o jsonpath='{.data.Corefile}' | grep -A2 cache
```

监控 CoreDNS 指标以获取缓存命中率：

```bash
kubectl -n kube-system port-forward svc/kube-dns 9153:9153 &
curl -s http://localhost:9153/metrics | grep coredns_cache
```

健康的部署将显示 `coredns_cache_hits_total` 增加的速度显著快于 `coredns_cache_misses_total`。如果缓存是冷的（刚部署或重启），比率会在前几分钟内改善；如果保持低位，请确认 `cache` 块已加载，并且 CoreDNS pods 已获取 ConfigMap 更改。

当上游解析器在启用缓存的情况下仍然触发其客户端上限时，分析一个代表性 pod 的 `/etc/resolv.conf` 以查找异常大的 `search` 列表 — 每个额外的搜索域条目都会将 NXDOMAIN 放大器乘以另一个因子。

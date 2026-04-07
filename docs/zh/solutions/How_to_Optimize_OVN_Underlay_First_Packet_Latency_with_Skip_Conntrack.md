---
id: KB202604070001
products:
  - Alauda Container Platform
kind:
  - Solution
sourceSHA: pending
---

# OVN Underlay 网络首包延迟优化 - 跳过 Conntrack 方案（S2 方案）

本文档介绍如何在 Kube-OVN 中配置 `skip-conntrack-dst-cidrs` 参数，使指定目标 IP CIDR 的流量跳过 conntrack 处理，从而降低 OVN Underlay 网络的首包延迟和 conntrack 表压力。

## 概述

在 OVN Underlay 网络模式下，所有跨子网流量默认都会经过 conntrack（连接跟踪）处理，这会导致首包延迟增加。对于对延迟敏感的场景，可通过 `skip-conntrack-dst-cidrs` 功能跳过 conntrack 处理来降低首包延迟。

`skip-conntrack-dst-cidrs` 功能允许管理员指定需要跳过 conntrack 处理的目标 IP CIDR。它在 OVN `ls_in_pre_lb` 逻辑流表中插入优先级为 105 的流表项，优先级高于默认的优先级 100 的 conntrack 流表。

## 先决条件

| 项目 | 要求 |
|------|------|
| ACP 版本 | 4.3+ |
| 网络模式 | OVN Underlay |
| Kube-OVN 版本 | v1.15+（支持 skip-conntrack-dst-cidrs） |

## 配置步骤

> **警告**：一旦对某个目标 CIDR 跳过 conntrack，以下 OVN 功能对该 CIDR 的流量将**不再生效**：
> - **NetworkPolicy** — 依赖 conntrack 状态的 OVN ACL 规则将无法匹配
> - **Service 负载均衡** — ClusterIP/NodePort 服务的 OVN LB 规则将被绕过
>
> 请确保目标 CIDR 是**直接 Pod 到 Pod 的通信**，不依赖 NetworkPolicy 或 Service 路由。

### Step 1: 配置 Kube-OVN Controller

在 kube-ovn-controller 的 Deployment 中添加 `--skip-conntrack-dst-cidrs` 启动参数：

```bash
kubectl edit deploy kube-ovn-controller -n kube-system
```

找到容器启动参数部分，添加该参数：

```yaml
    args:
      # ... 已有参数 ...
      - --skip-conntrack-dst-cidrs=10.0.0.0/24,192.168.1.0/24    # 替换为实际的目标 CIDR
```

保存后自动生效。如需删除配置，删除该行并保存即可。

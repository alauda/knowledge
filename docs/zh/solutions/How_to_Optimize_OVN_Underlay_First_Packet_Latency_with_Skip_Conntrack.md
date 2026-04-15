---
id: KB202604070001
products:
  - Alauda Container Platform
kind:
  - Solution
sourceSHA: a4324855450c5db17a060d47610848fb4a7bf35dcdf12d846c510644f2ca3326
---

# 优化 OVN 下层网络首包延迟的 Skip Conntrack（S2 解决方案）

本文档描述了如何在 Kube-OVN 中配置 `skip-conntrack-dst-cidrs` 参数，以跳过指定目标 IP CIDR 的 conntrack 处理，从而减少 OVN 下层网络的首包延迟。

## 概述

在 OVN 下层网络模式中，所有跨子网流量默认都经过 conntrack（连接跟踪）处理，这增加了首包延迟。对于对延迟敏感的场景，可以使用 `skip-conntrack-dst-cidrs` 功能来绕过 conntrack 处理，从而减少首包延迟。

`skip-conntrack-dst-cidrs` 功能允许管理员指定应完全绕过 conntrack 处理的目标 IP CIDR。它通过在 OVN `ls_in_pre_lb` 逻辑流表中插入优先级为 105 的流来实现，该流优先于默认优先级为 100 的 conntrack 流。

## 先决条件

| 项目             | 要求                                          |
| ---------------- | --------------------------------------------- |
| ACP 版本         | 4.3+                                         |
| 网络模式         | OVN 下层                                     |
| Kube-OVN 版本    | v1.15+（支持 skip-conntrack-dst-cidrs）     |

## 配置步骤

> **警告**：一旦跳过某个目标 CIDR 的 conntrack，以下 OVN 功能将**不再对**该 CIDR 的流量生效：
>
> - **NetworkPolicy** — NetworkPolicy 规则将无法控制该 CIDR 的 Pod 流量
> - **服务访问** — 当服务的后端 Pods 位于该 CIDR 中时，无法通过 ClusterIP、NodePort 或 LoadBalancer 访问该服务
>
> 确保目标 CIDR 是**直接访问的 Pod 到 Pod 流量**，不依赖于 NetworkPolicy 或服务路由。

### 步骤 1：配置 Kube-OVN 控制器

在 kube-ovn-controller 部署中添加 `--skip-conntrack-dst-cidrs` 启动参数：

```bash
kubectl edit deploy kube-ovn-controller -n kube-system
```

找到容器参数部分并添加该参数：

```yaml
containers:
  - name: kube-ovn-controller
    args:
      # ... 现有参数 ...
      - --skip-conntrack-dst-cidrs=10.0.0.0/24,192.168.1.0/24    # 替换为实际目标 CIDR
```

保存后，配置将自动生效。要删除，请删除 `--skip-conntrack-dst-cidrs` 行并保存。

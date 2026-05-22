---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500074
sourceSHA: 42dee2b360b5e04d459a5a6c55f5bbbed7d12f4cb00f594d9b113ed7be59e767
---

# 使用 Navicat 连接到 Redis Sentinel 集群

## 介绍

本指南描述了如何使用 Navicat 客户端连接到运行在哨兵模式下的 Alauda Cache Service for Redis 实例。操作步骤涵盖连接设置、哨兵认证选项和超时配置。

:::info 哨兵密码支持

- 在平台版本 **<= 3.16** 上，不支持哨兵密码认证。哨兵端必须配置为 `None`。
- 在平台版本 **>= 3.18** 上，支持哨兵密码认证。如果实例配置了哨兵密码，请使用 `Password`；否则使用 `None`。
  :::

## 前提条件

- Redis Sentinel 实例必须启用 **NodePort** 外部访问。
- 运行 Navicat 的主机必须能够访问实例中每个 Sentinel 节点的 NodePort IP 和端口。
- 在工作站上安装 Navicat（Premium 或 Navicat for Redis）。
- Redis 密码，以及在平台 >= 3.18 上适用的哨兵密码（如果有）。

## 操作步骤

### 1. 打开 Navicat 并创建新的 Redis 连接

在 Navicat 中，选择 **Connection** > **Redis** 打开新连接对话框。

### 2. 配置常规选项卡

在 **General** 选项卡中，配置哨兵和组部分。

#### 哨兵部分

- **Type**: `Sentinel`
- **Sentinel Host**: 可通过 NodePort 访问的其中一个 Sentinel 节点的地址。
- **Sentinel Port**: 该 Sentinel 节点的匹配 NodePort。
- **Sentinel Authentication**:
  - 在平台 **<= 3.16** 上，选择 `None`（不支持哨兵密码）。
  - 在平台 **>= 3.18** 上：
    - 如果实例未配置哨兵密码，则选择 `None`。
    - 如果配置了哨兵密码，则选择 `Password` 并输入哨兵密码。

#### 组部分

- **Group Name**: `mymaster`（Alauda Redis Sentinel 的默认主节点名称）。
- **Group Authentication**: `Password`
- **Group Password**: 实例的 Redis 密码。

### 3. 配置哨兵选项卡

在 **Sentinel** 选项卡中，启用 **Use additional sentinels** 并添加其余哨兵节点地址（主机 + NodePort），以便在主哨兵不可用时 Navicat 可以进行故障转移。

### 4. 配置高级选项卡

在 **Advanced** 选项卡中，设置非零的 **Connection Timeout**。否则 Navicat 会报告以下错误：

```
With sentinel, connection timeout and socket timeout cannot be 0
```

几秒钟的连接超时（例如，10 秒）对于大多数环境来说是足够的。

### 5. 测试连接

点击 **Test Connection**。成功对话框确认 Navicat 可以访问哨兵，解析当前主节点并进行身份验证。保存连接。

## 重要注意事项

- **NodePort 可达性** — Navicat 必须能够访问 **每个** 哨兵节点，而不仅仅是一个。如果工作站只能看到部分节点，Navicat 的故障转移行为将不可靠。
- **哨兵密码版本限制** — 在平台版本 **<= 3.16** 上配置哨兵密码是不支持的，并将导致任何客户端（不仅仅是 Navicat）连接失败。
- **组名称** — 在标准的 Alauda Redis Sentinel 部署中，组名称始终为 `mymaster`，除非实例已被自定义。
- **超时要求** — 哨兵模式下的 Navicat 连接要求非零连接超时；默认值 `0` 会被拒绝，并显示上述错误。

---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - '3.18,4.0,4.1'
id: KB260500071
sourceSHA: bfe9847647c55937e4ef4012ad45345da7f9792ea02b8deeef15b36625367b76
---

# 如何部署 Nacos 2.2

## 介绍

本指南解释了如何在 Alauda 容器平台 (ACP) 上使用 Alauda 应用目录中的 Nacos Chart 部署一个生产就绪的 **Nacos 2.2.3** 集群。当客户的 SDK 仍然固定在与 2.2 兼容的客户端时，请使用此文档；否则，请优先考虑更新的 [如何部署 Nacos 2.5](./How_to_Deploy_Nacos_2.5.md) 计划。

> **注意**：“Primary” 替代了之前用于集群中主 Nacos 节点的术语“Master”。

## 交付前注意事项

1. **不支持 IPv6。**
2. 社区明确标记为生命周期结束的 Nacos 版本无法得到 Alauda R\&D 的支持。
3. 社区不提供主要版本的升级路径，因此 Alauda 也没有就地升级路径。要迁移到新的主要版本，请从头开始重新部署。
4. Alauda 仅支持使用此计划交付的 Nacos 集群。客户构建的 Nacos 集群不在支持范围内。
5. Alauda 的支持涵盖故障排除、漏洞修复和基于社区发布的错误修复。
6. 此计划交付的 Nacos 版本为 **2.2.3**。Nacos 2.1 存在已知的 HA bug；运行低于 2.2.3 的客户应通过重新部署升级到 2.2.3。
7. **在交付前确认 SDK 兼容性。** 最常见的客户问题是客户端 SDK 早于 2.2.3 — 应用程序可能会以不可预测的方式崩溃。

要检查您的应用程序 SDK 版本是否与此 Nacos 版本兼容，请参见 [Spring Cloud Alibaba 组件版本表](https://github.com/alibaba/spring-cloud-alibaba/wiki/%E7%89%88%E6%9C%AC%E8%AF%B4%E6%98%8E#%E7%BB%84%E4%BB%B6%E7%89%88%E6%9C%AC%E5%85%B3%E7%B3%BB)。

## 架构概述

- Nacos 通过 Helm Chart 交付，并从平台应用商店安装。
- 集群默认有 **三个节点** 以实现高可用性，并可以扩展到任何 **奇数 ≥ 3**（5、7……）以适应更大的部署。Chart 默认设置 Kubernetes 的就绪/存活探针。
- 外部访问可以通过 `NodePort` 或 `LoadBalancer` 暴露。在 ACP 上，**ALB 是负载均衡器的实现**；下面的 Web 控制台验证部分使用 ALB 监听器。当集群中已部署 Istio Ingress Gateway 时，也支持该功能。
- 监控默认启用；客户可以使用 Grafana 抓取 Nacos 指标。
- 该计划不涵盖跨站点 DR 复制或数据迁移。
- 主要版本的升级通过销毁旧集群并重新部署新版本来实现。

## 先决条件

### 1. Violet CLI

从 **应用商店 > 应用入驻** 下载与您的集群版本匹配的 `violet` 工具。

### 2. 存储类

需要一个有效的 `StorageClass`。

> **已知问题**：使用 TopoLVM 时，观察到物理节点重启会导致 Nacos 数据丢失。如果必须使用 TopoLVM，请仔细计划节点维护。其他由网络存储支持的 CSI 驱动程序更安全。

### 3. MySQL

Nacos 社区将 MySQL 5.6.5 列为绝对最低要求，但 **此计划要求 MySQL 5.7.6 或更高版本**，因为下面的引导 SQL 使用了 `CREATE USER IF NOT EXISTS`，而 MySQL 5.6 不支持该语句（该子句是在 5.7.6 中添加的）。MySQL 5.6 也已被社区标记为生命周期结束（自 2021 年起）。您可以使用客户提供的 MySQL 或 Alauda 应用服务 MySQL Operator。

> **已知问题 — MySQL Router < 8.0.35**：通过 MySQL Router 连接的 Nacos 在 8.0.35 之前会失败并显示 `Couldn't read RSA public key from server`。MySQL Router 8.0.35 修复了此问题。Alauda 应用服务从 ACP 3.17 开始提供 MySQL 8.0.36（并回溯到 3.14 / 3.16 的小版本）。

## 操作步骤

### 1. 上传 Nacos 材料包

使用租户账户登录 Alauda Cloud，并从应用市场下载 `nacos` 工件。然后将 Nacos 包推送到目标业务集群：

```bash
violet push \
  --platform-address <platform-address> \
  --clusters <business-cluster-name> \
  --platform-username <platform-admin-username> \
  --platform-password <platform-admin-password> \
  nacos-v2.2.3.tgz
```

以管理员身份登录平台，切换到应用商店中的 **Nacos** 项目和命名空间，并确认 Nacos 包可见。

### 2. 在 MySQL 中创建 Nacos 用户和数据库

使用的代码块取决于 MySQL Router 是否为 8.0.35+（修复了 RSA 密钥握手错误）：如果您位于较旧的 MySQL Router 后面，请使用 `mysql_native_password`，否则请优先使用 `caching_sha2_password`。将 `<account name>` 和 `<password>` 替换为您打算在 Nacos Chart 中配置的值。

#### MySQL Router ≥ 8.0.35（或直接连接到 MySQL）

```sql
CREATE DATABASE IF NOT EXISTS nacos_config;
CREATE USER IF NOT EXISTS '<account name>'@'%'
  IDENTIFIED WITH caching_sha2_password BY '<password>';
GRANT ALL PRIVILEGES ON nacos_config.* TO '<account name>'@'%';
FLUSH PRIVILEGES;
```

#### MySQL Router < 8.0.35

与 MySQL 服务器 `8.0.x`（前 `8.0.35` Router）和 `5.7.6+` 兼容 — 用户必须使用传统的 `mysql_native_password` 身份验证插件，以避免在先决条件中提到的 Router RSA 密钥握手错误。

```sql
CREATE DATABASE IF NOT EXISTS nacos_config;
CREATE USER IF NOT EXISTS '<account name>'@'%'
  IDENTIFIED WITH mysql_native_password BY '<password>';
GRANT ALL PRIVILEGES ON nacos_config.* TO '<account name>'@'%';
FLUSH PRIVILEGES;
```

### 3. 部署 Nacos Chart

在应用商店中，切换到 **Nacos** 项目和命名空间，找到 Nacos chart，然后点击 **部署**。

大多数参数都有合理的默认值。以下字段值得关注：

| 字段                      | 备注                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `name`                     | 实例名称；`nacos` 是一个合理的默认值。                                                                                           |
| `displayName`              | 显示名称，通常为 `Nacos`。                                                                                                     |
| `templateVersion`          | 对于新环境，通常只显示一个版本；在升级时，选择最新的版本。                                                                     |
| 镜像注册表               | 必须与推送材料的注册表匹配；否则拉取将失败。                                                                                     |
| `-XX:InitialRAMPercentage` | 默认 `75.0`。JDK 至少需要一个小数位。                                                                                          |
| `-XX:MaxRAMPercentage`     | 默认 `75.0`。同样的 JDK 要求。                                                                                                 |
| 资源                      | 实验室验证的默认值：请求 2 核心 / 2.5 Gi，限制 2 核心 / 4 Gi。根据实际负载进行扩展。                                             |
| 部署模式                  | `cluster`（默认）用于三节点 HA；`standalone` 用于单节点。生产环境必须使用 `cluster`。                                           |
| 启动模式                  | `naming`（默认） — Nacos 仅作为注册中心。`config` — 仅作为配置中心。`all` — 两者均可。                                        |
| 上下文路径                | 默认 `/nacos`。如果更改，请在下面的所有验证 URL 中替换 `/nacos`。                                                              |
| 管理员密码                | 默认 `nacos`。使用强密码。Nacos 2.2.3 在重启后仍会尊重在 Web 控制台中所做的密码更改。                                           |
| `Server Identity Key`      | 节点间身份验证的头部密钥。对于私有网络，`identitykey` 是可以的。替代了 1.4.1 之前的 User-Agent 方案。                          |
| `Server Identity Value`    | 匹配的头部值，例如 `identityvalue`。                                                                                            |
| 数据存储类                | 支持 Nacos 数据的 StorageClass 名称，例如 `sc-topolvm`。                                                                        |
| 日志存储类                | 日志的 StorageClass 名称。将日志保存在单独的类中可以保护数据 PV 免受日志驱动的耗尽。                                          |
| `db.host`                  | MySQL 主机。当使用平台内部 MySQL 服务时，请包括命名空间：`<service-name>.<namespace>`。                                         |
| `db.port`                  | MySQL 端口。默认 `3306`。                                                                                                       |
| `db.name`                  | MySQL 数据库名称。默认 `nacos_config`。                                                                                        |
| `db.user`                  | Nacos 使用的 MySQL 用户（以及创建模式的初始化容器使用的用户）。默认 `nacos`。                                                  |
| `db.password`              | 与上述用户匹配的密码。                                                                                                         |

> **警告**：重新部署 Chart 会清除底层数据库。如果您打算重新创建实例，请先备份。
>
> **JWT 签名密钥**：与 2.5 chart 不同，Alauda 2.2 chart **不**显示 `JWT 签名密钥` 参数 — Nacos 2.2.3 会回退到其内置的默认令牌密钥。默认值适合在受信网络上的跨命名空间流量，但是公开已知的，因此不要依赖它作为安全边界。如果需要自定义密钥，请通过 chart 的高级选项在 `application.properties` 中覆盖 `nacos.core.auth.default.token.secret.key`（并记住在 2.5 文档中提到的相同 base64 / 解码 ≥ 32 字节的规则）。

## 验证

### 1. API 验证

`exec` 进入集群中的任何非 Nacos pod：

```bash
kubectl -n <namespace> exec -it <pod-name> -- sh
```

在下面的命令中，将 `<nacos-svc>` 替换为 `<nacos-internal-route>.<namespace>.svc.cluster.local`，将 `<port>` 替换为 Nacos 服务端口（默认 `8848`），将 `<token>` 替换为登录调用返回的访问令牌。

#### 获取令牌

```bash
curl -X POST 'http://<nacos-svc>:<port>/nacos/v1/auth/login' \
  -d 'username=nacos&password=nacos'
```

示例响应：

```json
{"accessToken":"eyJhbGciOiJI...","tokenTtl":18000,"globalAdmin":true}
```

#### 注册实例

```bash
curl -X POST 'http://<nacos-svc>:<port>/nacos/v1/ns/instance?serviceName=nacos.naming.serviceName&ip=20.18.7.10&port=8080&accessToken=<token>'
```

#### 发现实例

```bash
curl -X GET 'http://<nacos-svc>:<port>/nacos/v1/ns/instance/list?serviceName=nacos.naming.serviceName&accessToken=<token>'
```

> **注意**：注册的实例将报告 `"healthy":false`，因为此验证仅 POST 注册而不发送心跳。对于短暂注册，“无心跳的不健康”是预期的稳定状态。

#### 发布配置

```bash
curl -X POST "http://<nacos-svc>:<port>/nacos/v1/cs/configs?dataId=nacos.cfg.dataId&group=test&content=helloWorld&accessToken=<token>"
```

#### 检索配置

```bash
curl -X GET "http://<nacos-svc>:<port>/nacos/v1/cs/configs?dataId=nacos.cfg.dataId&group=test&accessToken=<token>"
```

> **注意**：上述示例使用 v1 OpenAPI 以简化操作。Nacos 2.x 还公开了 [v2 OpenAPI](https://nacos.io/docs/next/manual/user/open-api/) (`/nacos/v2/...`)，具有 JSON 主体和不同的身份验证路径 (`/nacos/v2/auth/user/login`) — 对于生产工具非常有用，但这里显示的 v1 调用是最快的手动烟雾测试。

### 2. Web 控制台验证

Nacos 控制台通过 ALB 暴露。首先确认 ALB 已部署，然后添加监听器：

| 字段                | 值                                   |
| -------------------- | ------------------------------------- |
| 端口                 | 任何空闲端口。                        |
| 协议                 | `TCP`。                               |
| 算法                 | 轮询（默认）。                        |
| 内部路由组           | `nacos`，端口 `8848`（Nacos 默认）。 |
| 会话亲和性           | `源 IP 哈希`。                       |
| 后端协议             | `TCP`。                               |

打开 `http://<alb-vip>:<listener-port>/nacos`。默认凭据为 `nacos / nacos` — 首次登录时请立即更改。

## 常见问题解答

### Q1. 当 1.x 客户端连接时，内存使用超过 80%（Nacos 资源 4c8g）

暂时扩大 Nacos 资源以吸收负载，然后将客户端迁移到 2.x SDK。根本原因是来自 1.x 客户端的高频心跳，服务器无法回收。

上游问题：<https://github.com/alibaba/nacos/issues/11424>。

### Q2. 在优雅关闭 Nacos 客户端应用程序后，Nacos 报告的数据不一致

监控 Nacos 的磁盘和内存。磁盘耗尽或内存压力会降低 Nacos 性能并产生不一致的读取。

### Q3. HA Nacos 在 TopoLVM 上在主机重启后不同步

受影响的 Nacos 版本：**2.2.3 及以下。**

- 在 **2.2.3** 上，集群最终处于分歧状态，但可以恢复：重启离线的 Nacos pod，它会重新加入。
- 在 **2.2.3 以下** 的版本中，分歧是不可恢复的 — 重新部署到 2.2.3（或更高版本）。

上游问题：<https://github.com/alibaba/nacos/issues/8099>。

### Q4. Nacos pod 处于 `CrashLoopBackOff`，并显示 `User limit of inotify instances reached or too many open files`

主机的 inotify 配额已耗尽（通常是由于同一节点上的其他工作负载）。

提高主机上的限制：

```text
fs.inotify.max_queued_events = 32768
fs.inotify.max_user_instances = 65536
fs.inotify.max_user_watches = 1048576
```

如果应用程序保持许多描述符打开，还应在 `/etc/security/limits.conf` 中提高 `nofile`。检查频繁创建和销毁 inotify 实例的应用程序，并池化它们的使用。

### Q5. Nacos pod 日志 `UnknownHostException jmenv.tbsite.net`

Nacos peer-finder 插件未能写入 `cluster.conf`（通常是因为 API 服务器过载或暂时无法访问），因此 Nacos 回退到硬编码的淘宝内部端点 (`jmenv.tbsite.net`)。验证 API 服务器的健康状况，并在其稳定后重启 Nacos pods。上游代码参考：[ `alibaba/nacos` "tbsite" 搜索](https://github.com/search?q=repo%3Aalibaba%2Fnacos%20tbsite\&type=code)。

### Q6. Nacos 客户端日志 `Ignore the empty nacos configuration and get it based on dataId`

Nacos 通过组合名称解析配置；在启动期间预期会出现该日志行。对于较旧的客户端，**客户端使用的文件格式**很重要 — `bootstrap.yaml` 成功，而 `bootstrap.properties` 可能无法干净地检索配置。Alauda 内部的 Spring Cloud 演示位于 `https://gitlab-ce.alauda.cn/middleware/nacos-spring-cloud-example`（如果您无法访问该 GitLab，请向您的 Alauda 联系人索取导出的副本）。

### Q7. Nacos 应该使用多大的 MySQL？

| 规模             | CPU (vCores) | 内存 (RAM) | 存储 (SSD) | InnoDB 缓冲池   |
| ----------------- | ------------ | ------------ | ------------- | ------------------ |
| 小型 / 测试      | 2            | 4 GB         | 50 GB+        | 2–3 GB             |
| 中型生产         | 4            | 8–16 GB      | 100–250 GB+   | 4–12 GB            |
| 大型生产         | 8+           | 16–32 GB+    | 250–500 GB+   | 12–24 GB+          |

- **小型** — 实验室、开发或低微服务密度的早期生产。
- **中型** — 稳定的微服务生产，具有明确的性能/可用性预期。
- **大型** — 高吞吐量、关键任务的生产，其中可用性和数据安全至关重要。

### Q8. 在 Nacos 2.2.3 短暂实例下线后，pod 仍然在服务下注册

已知的社区问题，影响 Nacos 2.2.3。在 2.3.x 中修复。跟踪上游：<https://github.com/alibaba/nacos/issues/11258>。要永久消除该症状，请使用 [Nacos 2.5 计划](./How_to_Deploy_Nacos_2.5.md) 重新部署 Nacos。

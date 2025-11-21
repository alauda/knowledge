---
kind:
  - Solution
products:
  - Alauda DevOps
ProductsVersion:
  - 4.x
id: KB251000012
sourceSHA: 6a99ad1d36c2710f9d88cf3270ec5b45dd8475873759f64d89c39a0693740eff
---

# 如何为 Harbor 执行灾难恢复

## 问题

本解决方案描述了如何基于对象存储和 PostgreSQL 灾难恢复能力构建 Harbor 灾难恢复解决方案。该解决方案主要关注数据灾难恢复处理，用户需要实现自己的 Harbor 访问地址切换机制。

## 环境

Harbor CE Operator: >=v2.12.4

## 术语

| 术语                               | 描述                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **主 Harbor**                       | 处理正常业务操作和用户请求的活动 Harbor 实例。该实例完全正常，所有组件均在运行。                                                                                      |
| **备 Harbor**                       | 部署在不同集群/地域的待命 Harbor 实例，具有零个副本。它在灾难恢复场景中保持休眠状态，直到被激活。                                                                     |
| **主 PostgreSQL**                  | 处理所有数据事务的活动 PostgreSQL 数据库集群，并作为数据复制到备份数据库的源。                                                                                      |
| **备 PostgreSQL**                  | 热备份 PostgreSQL 数据库，从主数据库接收实时数据复制。在故障转移期间可以提升为主角色。                                                                                |
| **主对象存储**                     | 存储所有 Harbor 注册表数据的活动 S3 兼容对象存储系统，并作为存储复制的源。                                                                                          |
| **备对象存储**                     | 同步备份对象存储系统，从主存储接收数据复制。在灾难恢复期间确保数据可用性。                                                                                          |
| **恢复点目标 (RPO)**              | 可接受的最大数据丢失量，以时间为单位衡量（例如，5 分钟，1 小时）。它定义了在灾难期间可以丢失多少数据，直到变得不可接受。                                              |
| **恢复时间目标 (RTO)**            | 可接受的最大停机时间，以时间为单位衡量（例如，15 分钟，2 小时）。它定义了在灾难发生后系统必须多快恢复。                                                              |
| **故障转移**                       | 当主系统不可用或故障时，从主系统切换到备系统的过程。                                                                                                                |
| **数据同步**                       | 从主系统到备系统持续复制数据的过程，以保持一致性并启用灾难恢复。                                                                                                    |
| **冷备份**                         | 与主系统没有持续同步的待命系统，需要手动激活，并在灾难恢复期间可能会导致数据丢失。                                                                                    |

## 架构

![harbor](/harbor-disaster-recovery.drawio.svg)

### 架构概述

Harbor 灾难恢复解决方案实现了 Harbor 服务的 **冷备份架构** 和 **热备份数据库复制**。这种混合方法通过实时数据库同步和手动 Harbor 服务故障转移程序提供灾难恢复能力。该架构由两个部署在不同集群或地域的 Harbor 实例组成，备 Harbor 实例在灾难场景中保持休眠状态，数据库层则保持持续同步。

#### 核心组件

- **主 Harbor**：处理正常业务操作和用户请求的活动实例
- **备 Harbor**：具有零个副本的待命实例，准备进行故障转移场景
- **主 PostgreSQL**：处理所有数据事务的活动数据库
- **备 PostgreSQL**：具有实时数据复制的热备份数据库
- **主对象存储**：用于注册表数据的活动 S3 兼容存储
- **备对象存储**：具有数据复制的同步备份存储

#### 数据同步策略

该解决方案利用两种独立的数据同步机制：

1. **数据库层**：PostgreSQL 流复制确保主数据库和备数据库之间的实时事务日志同步
2. **存储层**：对象存储复制保持主存储和备存储系统之间的数据一致性

#### 灾难恢复配置

1. **部署主 Harbor**：配置主实例以连接主 PostgreSQL 数据库，并使用主对象存储作为注册表后端
2. **部署备 Harbor**：配置备实例以连接备 PostgreSQL 数据库，并使用备对象存储作为注册表后端
3. **初始化待命状态**：将所有备 Harbor 组件的副本数量设置为 0，以防止不必要的后台操作和资源消耗

#### 故障转移程序

当发生灾难时，以下步骤确保切换到备环境：

1. **验证主故障**：确认所有主 Harbor 组件均不可用
2. **提升数据库**：使用数据库故障转移程序将备 PostgreSQL 提升为主角色（由于热备份，无数据丢失）
3. **提升存储**：将备对象存储激活为主存储系统
4. **激活 Harbor**：通过将副本数量设置为大于 0 来扩展备 Harbor 组件
5. **更新路由**：切换外部访问地址以指向备 Harbor 实例

## 使用 `Alauda Build of Rook-Ceph` 和 `Alauda support for PostgreSQL` 设置 Harbor 灾难恢复

### 前提条件

1. 提前准备一个主集群和一个灾难恢复集群（或包含不同地域的集群）。
2. 完成 `Alauda Build of Rook-Ceph` 和 `Alauda support for PostgreSQL` 的部署。
3. 参考 `Alauda Build of Rook-Ceph`、`Alauda support for PostgreSQL` 和 [Harbor 实例部署指南](https://docs.alauda.io/alauda-build-of-harbor/2.12/install/03_harbor_deploy.html) 提前规划所需的系统资源。

### 使用 `Alauda support for PostgreSQL` 构建 PostgreSQL 灾难恢复集群

参考 `PostgreSQL 热备份集群配置指南` 使用 `Alauda support for PostgreSQL` 构建灾难恢复集群。

确保主 PostgreSQL 和备 PostgreSQL 在不同的集群（或不同地域）中。

您可以在 [Alauda Knowledge](https://cloud.alauda.io/knowledges#/) 上搜索 `PostgreSQL 热备份集群配置指南` 以获取该文档。

:::warning

`PostgreSQL 热备份集群配置指南` 是一份描述如何使用 `Alauda support for PostgreSQL` 构建灾难恢复集群的文档。请确保在使用此配置时与适当的 ACP 版本兼容。

:::

### 使用 `Alauda Build of Rook-Ceph` 构建对象存储灾难恢复集群

使用 `Alauda Build of Rook-Ceph` 构建灾难恢复集群。参考 [对象存储灾难恢复](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html) 来构建灾难恢复集群。

您需要提前创建一个 CephObjectStoreUser 以获取对象存储的访问凭证，并在主对象存储上准备一个 Harbor 注册表桶：

1. 在主对象存储上创建一个 CephObjectStoreUser 以获取访问凭证：[创建 CephObjectStoreUser](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/create_object_user.html)。

   :::info
   您只需在主对象存储上创建 CephObjectStoreUser。用户信息将通过灾难恢复复制机制自动同步到备对象存储。
   :::

2. 此 `PRIMARY_OBJECT_STORAGE_ADDRESS` 是对象存储的访问地址，您可以从 `对象存储灾难恢复` 的步骤 [配置主区域的外部访问](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html#configure-external-access-for-primary-zone) 中获取。

3. 使用 mc 在主对象存储上创建一个 Harbor 注册表桶，在此示例中，桶名称为 `harbor-registry`。

   ```bash
   $ mc alias set primary-s3 <PRIMARY_OBJECT_STORAGE_ADDRESS> <PRIMARY_OBJECT_STORAGE_ACCESS_KEY> <PRIMARY_OBJECT_STORAGE_SECRET_KEY>
   Added `primary-s3` successfully.
   $ mc alias list
   primary-s3  
   URL       : <PRIMARY_OBJECT_STORAGE_ADDRESS> 
   AccessKey : <PRIMARY_OBJECT_STORAGE_ACCESS_KEY>
   SecretKey : <PRIMARY_OBJECT_STORAGE_SECRET_KEY>
   API       : s3v4
   Path      : auto
   Src       : /home/demo/.mc/config.json
   $ mc mb primary-s3/harbor-registry
   Bucket created successfully `primary-s3/harbor-registry`
   $ mc ls primary-s3/harbor-registry
   ```

### 设置主 Harbor

按照 [Harbor 实例部署](https://docs.alauda.io/alauda-build-of-harbor/2.12/install/03_harbor_deploy.html) 指南部署主 Harbor 实例。配置它以连接到主 PostgreSQL 数据库，并使用主对象存储作为 [注册表存储后端](https://docs.alauda.io/alauda-build-of-harbor/2.12/install/03_harbor_deploy.html#storage-yaml-snippets)。

配置示例：

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: Harbor
metadata:
  name: dr-harbor
spec:
  externalURL: http://dr-harbor.example.com
  helmValues:
    core:
      replicas: 1
      resources:
        limits:
          cpu: 400m
          memory: 512Mi
        requests:
          cpu: 200m
          memory: 256Mi
    database:
      external:
        coreDatabase: harbor
        existingSecret: primary-pg
        existingSecretKey: password
        host: acid-primary-pg.harbor.svc
        port: 5432
        sslmode: require
        username: postgres
      type: external
    existingSecretAdminPassword: harbor-account
    existingSecretAdminPasswordKey: password
    expose:
      ingress:
        hosts:
          core: dr-harbor.example.com
      tls:
        enabled: false
      type: ingress
    jobservice:
      replicas: 1
      resources:
        limits:
          cpu: 400m
          memory: 512Mi
        requests:
          cpu: 200m
          memory: 256Mi
    persistence:
      enabled: true
      imageChartStorage:
        disableredirect: true
        s3:
          existingSecret: object-storage-secret
          bucket: harbor-registry
          regionendpoint: <PRIMARY_OBJECT_STORAGE_ADDRESS>
          v4auth: true
        type: s3
      persistentVolumeClaim:
        jobservice:
          jobLog:
            accessMode: ReadWriteMany
            size: 10Gi
            storageClass: nfs
        trivy:
          accessMode: ReadWriteMany
          size: 10Gi
          storageClass: nfs
    portal:
      replicas: 1
      resources:
        limits:
          cpu: 400m
          memory: 512Mi
        requests:
          cpu: 200m
          memory: 256Mi
    redis:
      external:
        addr: primary-redis-0.primary-redis-hl.harbor.svc:26379
        existingSecret: redis-redis-s3-default-credential
        existingSecretKey: password
        sentinelMasterSet: mymaster
      type: external
    registry:
      controller:
        resources:
          limits:
            cpu: 200m
            memory: 410Mi
          requests:
            cpu: 100m
            memory: 200Mi
      registry:
        resources:
          limits:
            cpu: 600m
            memory: 1638Mi
          requests:
            cpu: 300m
            memory: 419Mi
      replicas: 1
    trivy:
      offlineScan: true
      replicas: 1
      resources:
        limits:
          cpu: 800m
          memory: 2Gi
        requests:
          cpu: 400m
          memory: 200Mi
      skipUpdate: true
  version: 2.12.4
```

### 设置备 Harbor

按照 [Harbor 实例部署](https://docs.alauda.io/alauda-build-of-harbor/2.12/install/03_harbor_deploy.html) 指南部署备 Harbor 实例。配置它以连接到备 PostgreSQL 数据库，并使用备对象存储作为 [注册表存储后端](https://docs.alauda.io/alauda-build-of-harbor/2.12/install/03_harbor_deploy.html#storage-yaml-snippets)。

:::info

主 Harbor 和备 Harbor 的实例名称必须相同。
:::

将所有备 Harbor 实例的副本数量设置为 0，以防止备 Harbor 执行不必要的后台操作。

配置 YAML 片段示例：

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: Harbor
metadata:
  name: dr-harbor
spec:
  helmValues:
    core:
      replicas: 0
    portal:
      replicas: 0
    jobservice:
      replicas: 0
    registry:
      replicas: 0
    trivy:
      replicas: 0
```

### 灾难场景中的主备切换程序

1. 首先确认所有主 Harbor 组件处于非工作状态，否则请先停止所有主 Harbor 组件。

2. 将备 PostgreSQL 提升为主 PostgreSQL。参考 `PostgreSQL 热备份集群配置指南`，执行切换程序。

3. 将备对象存储提升为主对象存储。参考 [Alauda Build of Rook-Ceph 故障转移](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html#procedures-1)，执行切换程序。

4. 通过将副本数量修改为大于 0 来扩展所有备 Harbor 组件：

   配置 YAML 片段示例：

   ```yaml
   apiVersion: operator.alaudadevops.io/v1alpha1
   kind: Harbor
   metadata:
     name: dr-harbor
   spec:
     helmValues:
       core:
         replicas: 1
       portal:
         replicas: 1
       jobservice:
         replicas: 1
       registry:
         replicas: 1
       trivy:
         replicas: 1
   ```

5. 测试镜像推送和拉取，以验证 Harbor 是否正常工作。

6. 切换外部访问地址到备 Harbor。

### 灾难恢复数据检查

检查对象存储和 PostgreSQL 的同步状态，以确保灾难恢复成功。

- 检查 Ceph 对象存储同步状态：[对象存储灾难恢复](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html#check-ceph-object-storage-synchronization-status)
- 检查 PostgreSQL 同步状态：参考 `PostgreSQL 热备份集群配置指南` 的状态检查部分。

### 恢复目标

#### 恢复点目标 (RPO)

RPO 代表灾难恢复场景中可接受的最大数据丢失。在此 Harbor 灾难恢复解决方案中：

- **数据库层**：由于 PostgreSQL 热备份与流复制，数据丢失接近零
- **存储层**：由于同步对象存储复制，数据丢失接近零
- **整体 RPO**：由于数据库和对象存储层的同步复制，数据丢失接近零

**影响 RPO 的因素：**

- 主集群和备集群之间的网络延迟
- 对象存储同步复制和一致性模型
- 数据库复制延迟和提交确认设置

#### 恢复时间目标 (RTO)

RTO 代表灾难恢复期间可接受的最大停机时间。该解决方案提供：

- **手动组件**：Harbor 服务激活和外部路由更新需要手动干预
- **典型 RTO**：完整服务恢复需要 5-15 分钟

**RTO 细分：**

- 数据库故障转移：1-2 分钟（手动）
- 存储故障转移：1-2 分钟（手动）
- Harbor 服务激活：2-5 分钟（手动，冷备份需要启动时间）
- 外部路由更新：1-5 分钟（手动，取决于 DNS 传播）

## 使用其他对象存储和 PostgreSQL 构建 Harbor 灾难恢复解决方案

操作步骤与使用 `Alauda Build of Rook-Ceph` 和 `Alauda support for PostgreSQL` 构建 Harbor 灾难恢复解决方案类似。只需将对象存储和 PostgreSQL 替换为其他对象存储和 PostgreSQL 解决方案。

确保对象存储和 PostgreSQL 解决方案支持灾难恢复能力。

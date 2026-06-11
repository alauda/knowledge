---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - '4.1,4.2,4.3'
id: KB260600001
sourceSHA: cac56cb9877f8fe08ccbd877320b550ce51a7534f8cb4af29e3a8f1bd9c280a6
---

# ZooKeeper 3.8.6 安装指南

## 概述

ZooKeeper 是一个分布式协调服务，用于配置管理、命名、分布式同步和组服务。本指南描述了如何上传 ZooKeeper 3.8.6 插件包，从 ACP Marketplace 创建 ZooKeeper 实例，验证部署，检查监控，并清理测试资源。

## 先决条件

- 已创建目标项目和命名空间，并且命名空间属于目标业务集群。
- 可用的支持动态供给的 StorageClass。每个 ZooKeeper Pod 创建专用的 PVC。
- 业务集群节点可以访问平台镜像注册表。
- 从 **应用商店 > 应用入驻** 下载 `violet` CLI，并与目标平台版本匹配。

## 安装

### 1. 获取插件包

从 Alauda Cloud 下载 ZooKeeper 3.8.6 插件包。包文件名由 Alauda Cloud 页面决定，本指南不依赖于固定的构建号。

### 2. 上传插件包

如果 ZooKeeper 3.8.6 尚未上传到目标平台，请使用 `violet` 将插件包推送到目标平台和业务集群：

```bash
violet push   --platform-address <platform-address>   --clusters <business-cluster-name>   --platform-username <platform-admin-username>   --platform-password <platform-admin-password>   <zookeeper-plugin-package>.tgz
```

如果插件包已经上传，请跳过此步骤并继续上传确认。

### 3. 确认上传

以管理员身份登录平台。转到 **Marketplace > Chart Repositories > public-charts**，搜索 ZooKeeper，并确认 `middleware/zookeeper/chart-zookeeper` 可见。选择上传的 ZooKeeper 3.8.6 版本。

### 4. 准备部署参数

| 参数                | 示例                   | 描述                                                  |
| -------------------- | --------------------- | ------------------------------------------------------ |
| `<project>`          | `middleware-project`  | 目标项目。                                            |
| `<namespace>`        | `middleware`          | 业务集群中的目标命名空间。                            |
| `<instance>`         | `zookeeper`           | ZooKeeper 实例名称。                                   |
| `<storage-class>`    | `topolvm`             | 目标业务集群中可用的 StorageClass。                   |
| `<registry-address>` | `<platform-registry>` | 业务 Pods 用于拉取镜像的注册表地址。                  |

### 5. 确认关键值

- `persistence` 必须是顶级字段。不要将其配置为 `zookeeper.persistence`。
- 在多集群环境中，明确设置 `global.registry.address` 为从目标业务集群可达的注册表地址。
- 保持 `zookeeper.replicaCount` 为奇数。生产环境中至少使用 3 个副本。
- 根据业务容量要求调整 PVC 容量和资源请求或限制。
- 在生产使用前确认快照自动清理策略，以避免长期磁盘增长。

### 6. 创建 ZooKeeper 实例

转到 **Marketplace > Chart Repositories > public-charts**，找到 `middleware/zookeeper/chart-zookeeper`，选择上传的 ZooKeeper 3.8.6 版本，然后点击 **创建**。

填写基本信息：

- **名称**：实例名称，例如 `zookeeper`
- **显示名称**：通常与实例名称相同
- **项目**：目标项目
- **命名空间**：业务集群中的目标命名空间
- **版本**：上传的 ZooKeeper 3.8.6 版本

切换到 **Values** 部分的 **YAML** 标签，并用环境特定的设置替换自定义值：

```yaml
global:
  registry:
    address: <registry-address>
zookeeper:
  replicaCount: 3
persistence:
  enabled: true
  storageClass: <storage-class>
  size: 5Gi
  accessMode: ReadWriteOnce
zookeeperExporter:
  enabled: true
prometheus:
  serviceMonitor:
    enabled: true
```

点击 **创建**。平台创建一个名为 `<instance>` 的应用和 HelmRequest。StatefulSet、Pods、Services 和相关资源也使用 `<instance>` 作为资源名称前缀，例如 `<instance>-0`、`<instance>` 和 `<instance>-headless`。

ZooKeeper StatefulSet 按顺序启动 Pods。一个 3 节点集群通常需要大约 2 到 5 分钟才能准备就绪。实际时间取决于镜像拉取、PVC 绑定和调度。

## 部署验证

为验证命令设置变量：

```bash
export NAMESPACE=<namespace>
export INSTANCE=<instance>
```

### 1. 检查 HelmRequest 和 Application

```bash
kubectl -n ${NAMESPACE} get helmrequests.app.alauda.io ${INSTANCE}
kubectl -n ${NAMESPACE} get applications.app.k8s.io ${INSTANCE} -o jsonpath='{.status.state}{"
"}'
```

预期结果：

- HelmRequest 存在并已成功同步。
- Application 的 `status.state` 为 `Running`。

### 2. 检查 Pods、Services 和 PVCs

```bash
kubectl -n ${NAMESPACE} get pod,sts,svc,pvc -o wide | grep ${INSTANCE}
```

预期结果：

- StatefulSet `READY` 为 `3/3`。
- `${INSTANCE}-0`、`${INSTANCE}-1` 和 `${INSTANCE}-2` 为 `2/2 Running`。
- PVCs 为 `Bound`。
- Services 包括 `${INSTANCE}` 和 `${INSTANCE}-headless`。

## 功能验证

### 1. 健康检查

```bash
kubectl -n ${NAMESPACE} exec ${INSTANCE}-0 -c zookeeper --   sh -c 'echo ruok | nc 127.0.0.1 2181'
```

预期输出：

```text
imok
```

### 2. 验证集群选举

```bash
for i in 0 1 2; do
  echo "${INSTANCE}-${i}"
  kubectl -n ${NAMESPACE} exec ${INSTANCE}-${i} -c zookeeper --     sh -c 'echo mntr | nc 127.0.0.1 2181 | grep zk_server_state'
done
```

预期结果：恰好一个领导者和两个跟随者。

### 3. 验证数据读写

```bash
TEST_PATH=/zk-smoke-$(date +%s)
kubectl -n ${NAMESPACE} exec ${INSTANCE}-0 -c zookeeper --   zkCli.sh -server ${INSTANCE}:2181 create ${TEST_PATH} hello
kubectl -n ${NAMESPACE} exec ${INSTANCE}-0 -c zookeeper --   zkCli.sh -server ${INSTANCE}:2181 get ${TEST_PATH}
kubectl -n ${NAMESPACE} exec ${INSTANCE}-0 -c zookeeper --   zkCli.sh -server ${INSTANCE}:2181 delete ${TEST_PATH}
```

预期结果：创建成功，获取返回 `hello`，删除完成且没有错误。

## 客户端连接

对于同一命名空间中的客户端，请使用客户端服务：

```text
${INSTANCE}:2181
${INSTANCE}.${NAMESPACE}.svc.cluster.local:2181
```

要连接到特定的集群成员，请使用无头服务：

```text
${INSTANCE}-0.${INSTANCE}-headless.${NAMESPACE}.svc.cluster.local:2181
${INSTANCE}-1.${INSTANCE}-headless.${NAMESPACE}.svc.cluster.local:2181
${INSTANCE}-2.${INSTANCE}-headless.${NAMESPACE}.svc.cluster.local:2181
```

## 监控验证

### 1. 确认导出器侧车容器

```bash
kubectl -n ${NAMESPACE} get pod -l app=zookeeper,release=${INSTANCE}   -o jsonpath='{range .items[*]}{.metadata.name}{"	"}{range .spec.containers[*]}{.name}{","}{end}{"
"}{end}'
```

预期结果：每个 Pod 包含 `zookeeper` 和 `zookeeper-exporter` 容器。

### 2. 查询导出器指标

```bash
kubectl -n ${NAMESPACE} port-forward pod/${INSTANCE}-0 9141:9141 &
curl -s http://127.0.0.1:9141/metrics | grep '^zk_up '
```

预期结果：

```text
zk_up 1
```

### 3. 确认 ServiceMonitor

```bash
kubectl -n ${NAMESPACE} get servicemonitors.monitoring.coreos.com ${INSTANCE}-exporter
```

预期结果：当前实例存在 `${INSTANCE}-exporter` ServiceMonitor。

## 变更验证

如果需要更改副本数，请保持副本数为奇数。在生产使用前在测试环境中验证扩展。

在平台 UI 中编辑 Values 并保存应用后，检查滚动更新，然后重复选举和数据读写验证：

```bash
kubectl -n ${NAMESPACE} rollout status statefulset/${INSTANCE} --timeout=15m
kubectl -n ${NAMESPACE} get pod -l app=zookeeper,release=${INSTANCE}
```

## 清理

如果这是一个测试部署，请从平台 UI 中删除应用。删除后，确认 Application、HelmRequest、StatefulSet、Pods、Services、PVCs 和 ServiceMonitor 已被清理。

```bash
kubectl -n ${NAMESPACE} get   applications.app.k8s.io,helmrequests.app.alauda.io,sts,pod,svc,pvc,servicemonitors.monitoring.coreos.com   | grep ${INSTANCE}

kubectl -n ${NAMESPACE} delete pvc -l app=zookeeper,release=${INSTANCE}
```

## 常见问题

### 快照目录持续增长

ZooKeeper 持续写入事务日志和快照。对于生产环境，根据业务需求启用自动清理，以避免填满数据磁盘。

```yaml
env:
  ZOO_AUTOPURGE_PURGEINTERVAL: "24"
  ZOO_AUTOPURGE_SNAPRETAINCOUNT: "5"
```

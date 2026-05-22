---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500103
sourceSHA: 3c38bfae1ddd4a324f764a48d1466abc201b60060e135a280194cfa0fd744dca
---

# 从管理视图导入 Kafka 资源

:::info 适用版本
ACP 3.12.x。
:::

## 介绍

较旧的 Kafka 实例可能是直接从 Strimzi 管理视图创建的。在 ACP 3.12 中，业务视图期望 RDS 层自定义资源。使用 `rdskafka-sync` 工具从现有 Strimzi 资源生成 RDS 资源，并将 Kafka 集群、主题和用户导入业务视图。

导入会更新受管理的 Kafka 资源，并可能重启 Kafka 实例。首先运行检查阶段，并在接受同步之前查看生成的 YAML。

## 先决条件

- 对目标 Kubernetes 集群的集群管理员访问权限。
- 从管理视图创建的现有 Kafka 资源。
- 访问 `rdskafka-sync` 镜像。
- Kafka 实例的备份或回滚计划。

## 快速升级工作流程

### 1. 检查导入准备情况

对于基于 Docker 的环境：

```bash
docker run -it --rm \
  -v ~/.kube/config:/root/.kube/config \
  build-harbor.alauda.cn/middleware/rdskafka-sync:1.0 \
  ./bin/check.sh
```

对于基于 containerd 的环境：

```bash
ctr run --rm \
  --mount type=bind,src=/root/.kube,dst=/root/.kube,options=rbind:rw \
  --net-host \
  build-harbor.alauda.cn/middleware/rdskafka-sync:1.0 \
  sh ./bin/check.sh
```

`Ready` 表示资源可以被导入。`Not Ready` 表示至少有一个资源未通过验证；请查看输出并修复报告的原因，然后再继续。

### 2. 运行导入

对于 Docker：

```bash
docker run -it --rm \
  -v ~/.kube/config:/root/.kube/config \
  build-harbor.alauda.cn/middleware/rdskafka-sync:1.0 \
  ./bin/sync.sh
```

对于 containerd：

```bash
ctr run --rm \
  --mount type=bind,src=/root/.kube,dst=/root/.kube,options=rbind:rw \
  --net-host \
  build-harbor.alauda.cn/middleware/rdskafka-sync:1.0 \
  sh ./bin/sync.sh
```

如果命令在没有错误的情况下完成，导入的资源名称将被打印。如果任何资源导入失败，请联系运维。

## 直接使用 CLI

### 检查资源

```bash
./rdskafka-sync check cluster
./rdskafka-sync check cluster -n <namespace>
./rdskafka-sync check topic -n <namespace>
./rdskafka-sync check user -n <namespace>
```

检查输出包括以下字段：

| 字段          | 说明                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| `NAMESPACE`   | 资源的命名空间。                                                                        |
| `RDSNAME`     | RDS 资源名称。为空表示仅存在管理视图资源，需要导入。                                     |
| `CLUSTERNAME` | 管理视图 Kafka 资源名称。                                                                |
| `VALIDATE`    | 资源是否通过导入验证。只有 `true` 可以被导入。                                          |
| `REASON`      | 验证失败原因。验证成功时为空。                                                           |

### 同步资源

```bash
./rdskafka-sync sync cluster <name> -n <namespace>
./rdskafka-sync sync topic <name> -n <namespace>
./rdskafka-sync sync user <name> -n <namespace>
./rdskafka-sync sync cluster -n <namespace>
./rdskafka-sync sync topic -n <namespace>
./rdskafka-sync sync user -n <namespace>
```

强制同步跳过确认，必须谨慎使用：

```bash
./rdskafka-sync sync cluster <name> -n <namespace> -f
```

## 验证规则

该工具验证资源是否可以安全导入。常见的验证失败包括：

- Kafka 实例未使用基于 PVC 的存储。
- 资源正在被删除。
- 资源不处于就绪状态。
- Kafka 主题或集群配置值使用非字符串值，如布尔值或整数。RDS 操作员期望字符串配置值。

导入的主题始终包含所需的 RDS 配置键。如果管理视图主题未定义它们，则会添加默认值：

```properties
retention.ms=604800000
max.message.bytes=1048576
```

## 重要注意事项

- 导入 Kafka 集群可能会重启 Kafka 实例。
- 在确认操作之前，请查看生成的 RDS YAML 和结果 Strimzi YAML。
- 在导入之前将配置值转换为字符串。
- 在同步之前立即运行检查命令，以便验证输出与当前集群状态匹配。

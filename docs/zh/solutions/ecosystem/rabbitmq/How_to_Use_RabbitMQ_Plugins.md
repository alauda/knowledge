---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500132
sourceSHA: 5a1cd9bb558862848718f08d400a45403245c0f8fb1c9d134c8d09973fb16d00
---

# 如何使用 RabbitMQ 插件

## 介绍

RabbitMQ 插件通过额外的协议、监控、管理、路由行为和集成功能扩展了代理。

操作员创建的 RabbitMQ 实例通常默认启用以下插件：

- `rabbitmq_peer_discovery_k8s`
- `rabbitmq_prometheus`
- `rabbitmq_management`

## 检查插件状态

在 RabbitMQ pod 中运行以下命令：

```bash
rabbitmq-plugins list
```

启用的插件在命令输出中显示为启用标记。

## 启用内置插件

将插件名称添加到 `spec.rabbitmq.additionalPlugins`：

```yaml
spec:
  rabbitmq:
    additionalPlugins:
      - rabbitmq_top
      - rabbitmq_shovel
```

在 pod 准备好后进行验证：

```bash
rabbitmq-plugins list
```

## 常见插件类别

| 类别                | 示例                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| 管理                | `rabbitmq_management`, `rabbitmq_management_agent`                      |
| 监控                | `rabbitmq_prometheus`                                                   |
| 发现                | `rabbitmq_peer_discovery_k8s`, `rabbitmq_peer_discovery_aws`            |
| 复制                | `rabbitmq_shovel`, `rabbitmq_federation`                                |
| 协议                | `rabbitmq_mqtt`, `rabbitmq_amqp1_0`, `rabbitmq_web_stomp`               |
| 交换扩展           | `rabbitmq_consistent_hash_exchange`, `rabbitmq_delayed_message_exchange` |

## 启用社区或自定义插件

如果插件未打包在 RabbitMQ 镜像中，仅将名称放入 `additionalPlugins` 是不够的。插件文件必须在 RabbitMQ 启动之前存在于容器中。

### 方法 1：在 Init 容器中下载

使用 init 容器将 `.ez` 插件文件下载到共享卷中，并扩展 `RABBITMQ_PLUGINS_DIR`。

```yaml
spec:
  rabbitmq:
    additionalPlugins:
      - rabbitmq_management_exchange
    envConfig: |
      RABBITMQ_PLUGINS_DIR=/opt/rabbitmq/plugins:/opt/rabbitmq/community-plugins
  override:
    statefulSet:
      spec:
        template:
          spec:
            volumes:
              - name: community-plugins
                emptyDir: {}
            initContainers:
              - name: copy-community-plugins
                image: curlimages/curl
                command:
                  - sh
                  - -c
                  - curl -L https://<plugin-url> --output /community-plugins/<plugin>.ez
                volumeMounts:
                  - name: community-plugins
                    mountPath: /community-plugins
            containers:
              - name: rabbitmq
                volumeMounts:
                  - name: community-plugins
                    mountPath: /opt/rabbitmq/community-plugins
```

### 方法 2：从节点挂载插件文件

如果环境无法从互联网下载，则从节点挂载插件目录，并在 RabbitMQ 启动之前将其复制到可写的共享卷中。

此方法要求：

- 选定节点上已存在插件文件
- 节点级目录管理
- 更严格的调度控制

## 建议

- 保持插件集最小化。
- 验证插件与正在使用的 RabbitMQ 版本的兼容性。
- 将相同的必需插件集应用于用于迁移或灾难恢复的目标集群。
- 将社区插件视为应用程序依赖项，并在生产发布之前进行测试。

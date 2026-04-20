---
products:
  - Alauda Container Platform
kind:
  - Solution
id: KB1776670415-KAFU
sourceSHA: 3bf479b2413724aec8ebbedcacf906bf770719c81f79ffa99880ca6b87e6f876
---

# Kafka 用户密码配置

## 背景

默认情况下，Alauda 中间件 operator (`rds-operator`) 将 SCRAM-SHA-512 凭证生成委托给 Strimzi 用户 operator，当创建 `KafkaUser` 时会生成一个随机密码。一些用例——从现有 Kafka 集群迁移、与已经有固定密码的外部系统集成或集中管理的凭证轮换——需要在用户上设置已知密码并按需轮换。

`RdsKafkaUser` 暴露了 `spec.authentication.password.valueFrom.secretKeyRef`，因此用户的 SCRAM-SHA-512 密码可以来源于用户管理的 `Secret`。更新 `Secret` 以及在 `RdsKafkaUser` 上添加 `changePasswordTimestamp` 注解会触发就地轮换。

## 适用版本

在 ACP 4.2.x（rds-operator `v4.2.0`，Kafka `4.1.1`）上经过验证。`password.valueFrom.secretKeyRef` 字段是在 rds-operator `v3.16.0` 中引入的；任何捆绑 rds-operator `v3.16.0` 或更高版本的 ACP 版本都支持此流程。`v3.15.x` 系列不包含该字段。

## 先决条件

目标 `RdsKafka` 集群必须具有启用 SCRAM-SHA-512 身份验证和授权的监听器，以便强制执行用户凭证和 ACL：

```yaml
apiVersion: middleware.alauda.io/v1
kind: RdsKafka
metadata:
  name: my-cluster
spec:
  kafka:
    listeners:
      plain:
        authentication:
          type: scram-sha-512
    authorization:
      type: simple
  # ... 其他字段省略
```

示例使用 `plain` 监听器。SCRAM-SHA-512 身份验证在 `tls` 和 `external` 监听器上工作相同——在客户端将连接的监听器上设置 `authentication.type: scram-sha-512`。至少一个监听器必须配置 SCRAM 身份验证类型，以便通过此流程提供的凭证可用。

注意：`kafka.authorization.type: simple` 是使每个用户 ACL 生效所必需的。如果没有它，`KafkaUser` 的 ACL 规则会被接受，但不会被代理强制执行。

## 步骤

### 1. 创建密码 Secret

`Secret` 必须与 `RdsKafka` 实例位于同一命名空间。`password` 字段是 base64 编码的：

```shell
# 'Passw0rd123!' 的 base64
kubectl -n <ns> create secret generic my-user-password \
  --from-literal=password='Passw0rd123!'
```

等效的声明性形式：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: my-user-password
  namespace: <ns>
type: Opaque
data:
  password: UGFzc3cwcmQxMjMh
```

### 2. 创建 RdsKafkaUser

使用 `authentication.type: scram-sha-512` 创建用户并引用密码 `Secret`。集群绑定使用标签 `middleware.alauda.io/cluster: <rdskafka-name>`：

```yaml
apiVersion: middleware.alauda.io/v1
kind: RdsKafkaUser
metadata:
  name: my-user
  namespace: <ns>
  labels:
    middleware.alauda.io/cluster: my-cluster
spec:
  authentication:
    type: scram-sha-512
    password:
      valueFrom:
        secretKeyRef:
          name: my-user-password
          key: password
  authorization:
    type: simple
    acls:
      - host: '*'
        operation: All
        resource:
          name: '*'
          patternType: literal
          type: topic
```

> 使用类型为 `RdsKafkaUser`（组为 `middleware.alauda.io/v1`），而不是下游的 Strimzi `KafkaUser`。该 operator 拥有 Strimzi 对象并会覆盖对其的任何用户编辑。集群标签键为 `middleware.alauda.io/cluster`；该 operator 将其转换为下游 `KafkaUser` 上的 `strimzi.io/cluster`。

### 3. 验证协调

```shell
kubectl -n <ns> get rdskafkauser my-user -o jsonpath='{.status.phase}'
# Active

kubectl -n <ns> get kafkauser my-user -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
# True
```

`RdsKafkaUser` 通过 `status.phase` 报告就绪；下游 Strimzi `KafkaUser` 使用基于条件的标准 `status.conditions[type=Ready]`。在客户端可以进行身份验证之前，两个都必须为绿色。

Strimzi 用户 operator 发布了一个同名的 `Secret`，其中包含配置密码的 SASL/JAAS 配置：

```shell
kubectl -n <ns> get secret my-user -o jsonpath='{.data.sasl\.jaas\.config}' | base64 -d
# org.apache.kafka.common.security.scram.ScramLoginModule required username="my-user" password="Passw0rd123!";
```

客户端应用程序可以直接挂载此 `Secret` 以获取可用的 JAAS 配置。

### 4. 轮换密码

更新密码 `Secret` 并在 `RdsKafkaUser` 上设置 `changePasswordTimestamp` 注解。该 operator 会在几秒钟内协调下游 `KafkaUser`，然后 Strimzi 用户 operator 会重新发布 SASL 凭证：

```shell
NEW_B64=$(printf '%s' 'NewRotated456!' | base64)
kubectl -n <ns> patch secret my-user-password \
  -p "{\"data\":{\"password\":\"$NEW_B64\"}}"

kubectl -n <ns> annotate rdskafkauser my-user \
  "changePasswordTimestamp=$(date +%s)" --overwrite
```

轮换后，使用旧密码的客户端会因 `SaslAuthenticationException: Authentication failed during authentication due to invalid credentials with SASL mechanism SCRAM-SHA-512` 而失败，使用新密码的客户端则可以成功进行身份验证。

### 5. 删除用户

```shell
kubectl -n <ns> delete rdskafkauser my-user
```

删除 `RdsKafkaUser` 会移除下游 Strimzi `KafkaUser`，撤销代理中的 SCRAM 凭证，并且（因为 operator 已将其标记为 `OwnerReference`）会垃圾回收密码 `Secret`。由 Strimzi 用户 operator 自动发布的 SASL `Secret` 作为 `KafkaUser` 拆卸的一部分被删除。

## 注意事项

- 密码 `Secret` 会自动标记为 `RdsKafkaUser` 的 `OwnerReference`。删除 `RdsKafkaUser` 会垃圾回收密码 `Secret`。
- `RdsKafkaUser` 上的 `spec.authentication.type` 仅接受 `tls` 或 `scram-sha-512`。TLS 身份验证（双向 TLS）使用不同的凭证流程，并且不使用 `password` 字段。上游 Strimzi `KafkaUser` 还支持 `tls-external`；该类型的 OCP 用户无法 1:1 迁移，必须重写为 `tls` 并使用 operator 管理的证书。
- 当 Strimzi 用户 operator 处理下游 `KafkaUser` 时，可能会发出有关 ACL 架构的 `DeprecatedFields` 或 `UnknownFields` 状态条件（该 operator 传播单一的 `operation` 字段；上游 Strimzi 现在更喜欢复数的 `operations` 数组）。这些是警告，不会阻止用户变为 `Ready`。

## OCP 对应性

Red Hat OpenShift 容器平台使用 AMQ Streams（产品化的 Strimzi 发行版）来处理 Kafka。相同的功能在上游 `KafkaUser` 资源中本地暴露：

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: my-user
  labels:
    strimzi.io/cluster: my-cluster
spec:
  authentication:
    type: scram-sha-512
    password:
      valueFrom:
        secretKeyRef:
          name: my-user-password
          key: password
  authorization:
    type: simple
    acls:
      - resource:
          type: topic
          name: '*'
          patternType: literal
        operations: [All]
        host: '*'
```

在平台之间迁移时的主要区别：

| 方面                            | ACP (`RdsKafkaUser`)                                                                                                                                                     | OCP / AMQ Streams (`KafkaUser`)                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| API 组 / 类型                   | `middleware.alauda.io/v1` `RdsKafkaUser`                                                                                                                                 | `kafka.strimzi.io/v1beta2` `KafkaUser`                                                                                             |
| 集群绑定标签                   | `middleware.alauda.io/cluster`                                                                                                                                           | `strimzi.io/cluster`                                                                                                               |
| 密码 `secretKeyRef` 字段       | 相同 (`spec.authentication.password.valueFrom.secretKeyRef`)                                                                                                            | 相同                                                                                                                               |
| 支持的 `authentication.type`    | `tls`, `scram-sha-512`                                                                                                                                                   | `tls`, `tls-external`, `scram-sha-512`                                                                                             |
| 轮换触发器                     | 更新密码 `Secret` 并提升 `RdsKafkaUser` 上的 `changePasswordTimestamp` 注解以强制协调下游 `KafkaUser`。                                                                | 更新密码 `Secret`——用户 operator 监视引用的源 `Secret` 并自动重新发布凭证。                                                       |
| ACL 形状                       | 相同的 `resource` 子字段（`type`，`name`，`patternType`）。`acls[*].operation`（单数）未更改地传播到 Strimzi，并触发 `DeprecatedFields` 警告。                       | 更喜欢 `acls[*].operations`（复数数组）；`acls[*].operation`（单数）仍然被接受但已弃用。                                         |
| 密码 `Secret` 的所有权         | Operator 将 `OwnerReference` 设置为 `RdsKafkaUser`——删除用户会垃圾回收 `Secret`。                                                                                     | 用户 operator 读取但不拥有源 `Secret`；生命周期由应用程序管理。                                                                    |

代理端的凭证流程保持不变：用户 operator 将 SCRAM 凭证写入 Kafka，并发布一个包含 `sasl.jaas.config` 的 `Secret` 供客户端使用。从 OCP 移动现有的 `KafkaUser` 清单到 ACP 只是对 `kind`、`apiVersion`、集群标签和 ACL 形状的机械重写——在身份验证或轮换方面没有行为差异。

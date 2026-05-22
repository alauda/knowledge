---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500104
sourceSHA: 331c81ba39b73192b2b10355489ea83862c4a09af2ca2851ec4c1d12744c5ed3
---

# 使用 MetalLB 暴露 Kafka

:::info 适用版本
ACP 3.16.x，已部署 MetalLB。
:::

## 介绍

当 MetalLB 在 Kubernetes 集群中可用时，Kafka 可以通过 `LoadBalancer` 服务暴露代理服务，并从 MetalLB 地址池中接收稳定的外部 IP 地址。

## 先决条件

- 已安装并配置 MetalLB。
- 已部署 Kafka operator。
- MetalLB 地址池中有足够的 IP 地址用于引导服务和代理服务。

## 配置 Kafka 监听器

将外部 Kafka 监听器切换为 `loadbalancer`：

```yaml
spec:
  kafka:
    listeners:
      plain: {}
      external:
        type: loadbalancer
        tls: false
```

创建或更新 Kafka 实例，并等待其变为运行状态。

## 获取外部地址

列出为 Kafka 实例创建的服务：

```bash
kubectl -n <namespace> get svc -l middleware.instance/name=<cluster-name>
```

找到代理服务及其 `EXTERNAL-IP` 值。客户端可以连接到代理端点，例如：

```text
<external-ip>:9094
```

## 测试访问

在 Kafka 客户端环境中：

```bash
./bin/kafka-console-producer.sh \
  --broker-list <external-ip>:9094 \
  --topic my-cluster-topic
```

然后从同一主题消费以确认端到端访问。

## 重要注意事项

- 保持 LoadBalancer 服务。只要服务未被删除，MetalLB IP 将保持稳定。
- Kafka 外部访问要求每个广告的代理端点都能从客户端网络访问。
- 确认防火墙和路由允许对 MetalLB IP 和 Kafka 端口的 TCP 访问。
- 对于 TLS 监听器，请使用适当的客户端信任库和协议设置。

---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500116
sourceSHA: eced4e198d9537ff9f40c89b12c53b621d9bd53e6f184d5a4a4ba03d0178e165
---

# 在 AWS EKS 上通过网络负载均衡器暴露 Kafka

:::info 适用版本
ACP 3.x Kafka 在 AWS EKS 上使用 Strimzi 负载均衡器监听器。
:::

## 介绍

在 AWS EKS 上，Kafka 可以通过 AWS 网络负载均衡器 (NLB) 进行外部暴露。NLB 提供第 4 层 TCP 转发和由 AWS 负载均衡器控制器管理的静态外部端点。

## 先决条件

- 已导入到 ACP 的 EKS 集群。
- 在目标命名空间中部署的 Kafka 操作员。
- 已安装并配置的 AWS 负载均衡器控制器。
- 为 NLB 创建准备的子网、安全组和 IAM 权限。

AWS 控制器设置参考：

```text
https://docs.aws.amazon.com/eks/latest/userguide/network-load-balancing.html
```

## Kafka 监听器配置

将外部监听器类型设置为 `loadbalancer`，并为引导服务和每个代理服务添加 AWS NLB 注释。

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: my-cluster-nlb
spec:
  kafka:
    replicas: 3
    listeners:
      - name: plain
        port: 9092
        tls: false
        type: internal
      - name: external
        port: 9094
        tls: false
        type: loadbalancer
        configuration:
          bootstrap:
            annotations:
              service.beta.kubernetes.io/aws-load-balancer-type: external
              service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
              service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
          brokers:
            - broker: 0
              annotations:
                service.beta.kubernetes.io/aws-load-balancer-type: external
                service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
                service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
            - broker: 1
              annotations:
                service.beta.kubernetes.io/aws-load-balancer-type: external
                service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
                service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
            - broker: 2
              annotations:
                service.beta.kubernetes.io/aws-load-balancer-type: external
                service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
                service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
```

代理条目的数量必须与代理副本数量匹配。

## 验证服务

```bash
kubectl -n <namespace> get svc | grep <cluster-name>
```

使用引导负载均衡器的 `EXTERNAL-IP` 或 DNS 名称和端口 `9094`。还会创建代理负载均衡器，因为 Kafka 客户端在元数据发现后需要特定于代理的地址。

## 测试生产者和消费者

```bash
./bin/kafka-console-producer.sh \
  --bootstrap-server <nlb-dns-name>:9094 \
  --topic my-topic

./bin/kafka-console-consumer.sh \
  --bootstrap-server <nlb-dns-name>:9094 \
  --topic my-topic \
  --from-beginning
```

## 重要注意事项

- Kafka 客户端必须能够访问每个广告的代理端点，而不仅仅是引导端点。
- 使用安全组限制外部 Kafka 访问。
- 对于私有集群，请使用内部 NLB 方案，而不是 `internet-facing`。
- DNS 传播和负载均衡器配置可能需要几分钟。

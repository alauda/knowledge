---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500121
sourceSHA: 19a0f8be0ab20d17b224eb7333e737320583364e34e23eb96a2ed1535721c630
---

# Kafka 在 ACP 3.10.2 中因客户端 CA 证书过期而重启

:::info 适用版本
ACP 3.10.2。
:::

## 问题

Kafka 集群在创建约一年后意外重建或重启。操作员日志显示证书续订活动，Kafka 客户端 CA 证书的有效期为一年。

在受影响的设置中，操作员创建的 Kafka 集群的 `clientsCa` 有效期为一年。临近到期时，证书续订可能会触发 Kafka pod 重启。

## 诊断

导出并检查客户端 CA 证书：

```bash
kubectl -n <namespace> get secret <kafka-name>-clients-ca-cert -o jsonpath='{.data.ca\.crt}' | base64 -d > client-ca.crt
openssl x509 -in client-ca.crt -noout -dates
```

查看重启时的 Kafka 和操作员事件：

```bash
kubectl -n <namespace> get events --sort-by=.lastTimestamp | grep -i kafka
kubectl -n <operator-namespace> logs deploy/<cluster-operator-deployment>
```

## 解决方案

在 Kafka 资源中添加 `clientsCa.validityDays`，使集群和客户端 CA 证书都使用更长的有效期：

```yaml
spec:
  clusterCa:
    validityDays: 3650
  clientsCa:
    validityDays: 3650
```

然后手动触发客户端 CA 续订：

```bash
kubectl -n <namespace> annotate secret <kafka-name>-clients-ca-cert \
  strimzi.io/force-renew=true --overwrite
```

验证新证书的日期：

```bash
kubectl -n <namespace> get secret <kafka-name>-clients-ca-cert -o jsonpath='{.data.ca\.crt}' | base64 -d > client-ca.crt
openssl x509 -in client-ca.crt -noout -dates
```

## 重要注意事项

- 更新产品级 Kafka 资源可能会导致生成的社区 Kafka YAML 恢复。确认最终生成的 YAML 仍包含所需的 CA 设置。
- 根据配置，证书续订可能会重启客户端或代理。尽可能在维护窗口内安排更改。
- 确保应用程序的信任库与续订的 CA 材料保持一致。

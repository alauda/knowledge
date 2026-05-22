---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500100
sourceSHA: 219cd9c3ed779697651eda0bc506fc4efb76fe969ffa29cacb962259c0ae5cd7
---

# 如何配置 RocketMQ 控制台

## 问题

为现有的 RocketMQ 集群部署并访问 `rocketmq-console`。

## 先决条件

- 已经部署了 RocketMQ 集群。
- 您知道目标集群的 NameServer 服务地址。

## 创建控制台资源

示例 `Console` 自定义资源：

```yaml
apiVersion: rocketmq.apache.org/v1alpha1
kind: Console
metadata:
  name: console
  namespace: <namespace>
spec:
  nameServers: my-nameserver-nameserver-server-0.my-nameserver-nameserver-nodes.<namespace>.svc.cluster.local:9876;my-nameserver-nameserver-server-1.my-nameserver-nameserver-nodes.<namespace>.svc.cluster.local:9876;my-nameserver-nameserver-server-2.my-nameserver-nameserver-nodes.<namespace>.svc.cluster.local:9876
  numberOfInstances: 1
  resources:
    limits:
      cpu: "1"
      memory: 1Gi
    requests:
      cpu: "1"
      memory: 1Gi
  version: 1.0.0
```

参数说明：

- `namespace`: 使用与您要管理的 RocketMQ 实例相同的命名空间
- `nameServers`: 指向目标 RocketMQ NameServer 服务地址

## 示例部署

```yaml
apiVersion: rocketmq.apache.org/v1alpha1
kind: Console
metadata:
  name: console
  namespace: dba-demo
spec:
  nameServers: demo-nameserver-server-0.demo-nameserver-nodes.dba-demo.svc.cluster.local:9876;demo-nameserver-server-1.demo-nameserver-nodes.dba-demo.svc.cluster.local:9876
  numberOfInstances: 1
  resources:
    limits:
      cpu: "1"
      memory: 1Gi
    requests:
      cpu: "1"
      memory: 1Gi
  version: 1.0.0
```

使用以下命令创建：

```bash
kubectl create -f /tmp/rocketmq-console.yaml
```

## 验证

检查控制台 Pod：

```bash
kubectl get pod -n <namespace> -owide | grep console
```

检查控制台服务：

```bash
kubectl get svc -n <namespace> | grep console-service
```

示例结果：

```text
console-console-service   NodePort   ...   8080:<nodeport>/TCP
```

## 访问

通过服务地址打开控制台：

```text
http://<node-ip>:<nodeport>
```

## 注意事项

- 确保控制台命名空间与目标 RocketMQ 命名空间一致，除非您的环境明确支持跨命名空间访问。
- 如果使用多个 NameServers，请用分号分隔。
- 使用 Pod 级别的 NameServer 地址时，请使用完整的 StatefulSet DNS 名称，通常包括无头服务段：`<pod>.<headless-service>.<namespace>.svc.cluster.local`。

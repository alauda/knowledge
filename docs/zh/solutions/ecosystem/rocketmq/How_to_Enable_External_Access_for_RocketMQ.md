---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500099
sourceSHA: 6853d8db8e45d33e762bf7aafe9e4dc9cfa99a807a75d28b31789f36f033a0cd
---

# 如何为 RocketMQ 启用外部访问

## 背景

本指南描述了如何将由 RocketMQ Operator 创建的 RocketMQ 集群暴露给 Kubernetes 集群外部的客户端。

该方法使用：

- 每个 NameServer 的 NodePort 服务
- 每个 broker pod 的 NodePort 服务
- broker 监听端口更改，以便外部客户端可以访问正确的 broker 端点
- broker 端的外部地址广告，以便 NameServer 返回可供外部客户端访问的 broker 端点

## 创建共享 Broker 配置

创建一个包含公共 broker 设置的 `ConfigMap`：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: broker-config
  namespace: <namespace>
data:
  BROKER_MEM: " -Xms2g -Xmx2g -Xmn1g "
  broker-common.conf: |
    # brokerClusterName、brokerName 和 brokerId 由 operator 生成。
    deleteWhen=04
    fileReservedTime=48
    flushDiskType=ASYNC_FLUSH
    brokerRole=ASYNC_MASTER
    listenPort=30911
```

命名空间必须与 RocketMQ broker 资源使用的命名空间匹配。

## 创建 NameServers

部署至少两个独立的 NameServers 以提高可用性。

示例：

```yaml
apiVersion: rocketmq.apache.org/v1alpha1
kind: NameService
metadata:
  name: name-service1
  namespace: <namespace>
spec:
  dnsPolicy: ClusterFirstWithHostNet
  hostNetwork: false
  imagePullPolicy: Always
  nameServiceImage: build-harbor.alauda.cn/middleware/rocketmq-namesrv:v3.7.1
  resources:
    limits:
      cpu: 500m
      memory: 1024Mi
    requests:
      cpu: 250m
      memory: 512Mi
  size: 1
  storageMode: StorageClass
  volume:
    size: 1Gi
```

使用 NodePort 服务暴露每个 NameServer：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: namesrv1
  namespace: <namespace>
spec:
  type: NodePort
  ports:
    - name: namesrv
      nodePort: 39876
      port: 9876
      targetPort: 9876
      protocol: TCP
  selector:
    app: rocketmq_name_service
    rocketmq_name_service_cr: name-service1
```

以相同方式创建第二个 NameServer 和服务。

集群内的 `nameServers` 可以使用：

```text
namesrv1:9876;namesrv2:9876
```

外部客户端使用：

```text
<node-ip>:<nodeport>;<node-ip>:<nodeport>
```

## 创建 Broker 集群

示例 broker 资源：

```yaml
apiVersion: rocketmq.apache.org/v1alpha1
kind: Broker
metadata:
  name: broker
  namespace: <namespace>
spec:
  allowRestart: true
  brokerImage: build-harbor.alauda.cn/middleware/rocketmq-broker:v3.7.0
  env:
    - name: BROKER_MEM
      valueFrom:
        configMapKeyRef:
          name: broker-config
          key: BROKER_MEM
  imagePullPolicy: Always
  nameServers: namesrv1:9876;namesrv2:9876
  replicaPerGroup: 1
  size: 2
  resources:
    limits:
      cpu: 500m
      memory: 12288Mi
    requests:
      cpu: 250m
      memory: 2048Mi
  scalePodName: broker-0-master-0
  storageMode: StorageClass
  volume:
    size: 2Gi
  volumes:
    - name: broker-config
      configMap:
        name: broker-config
        items:
          - key: broker-common.conf
            path: broker-common.conf
```

此示例使用 `size: 2` 和 `replicaPerGroup: 1`，创建一个 2 主节点 + 2 从节点的布局。

## 暴露每个 Broker Pod

为每个 broker pod 创建一个 NodePort 服务。`broker-0-master` 的示例：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: broker-0-master
  namespace: <namespace>
spec:
  type: NodePort
  ports:
    - name: broker
      nodePort: 30911
      port: 30911
      targetPort: 30911
      protocol: TCP
  selector:
    app: rocketmq_broker
    broker_cr: broker
    brokerGroup: "0"
    replicaIndex: "0"
```

对其余 pods 重复此模式，例如：

- `broker-0-replica-1` -> `30912`
- `broker-1-master` -> `30913`
- `broker-1-replica-1` -> `30914`

## 更新 Broker 监听端口和广告地址

创建服务后，更新每个 broker StatefulSet，使 broker 同时：

- 监听与服务 `NodePort` 相同的端口
- 广告一个可供外部访问的节点 IP 或主机名，而不是仅限于集群内部的地址

仅更改端口是不够的。RocketMQ 客户端首先联系 NameServer，然后连接 NameServer 元数据返回的 broker 地址。如果 brokers 仍然广告 pod IP 或其他集群内部地址，外部客户端仍然会失败。

例如：

- `broker-0-master` -> `LISTEN_PORT=30911`
- `broker-0-replica-1` -> `LISTEN_PORT=30912`
- `broker-1-master` -> `LISTEN_PORT=30913`
- `broker-1-replica-1` -> `LISTEN_PORT=30914`

还要将 broker 的外部广告 IP 或主机名设置为客户端实际可以访问的节点地址。确切的字段或环境变量名称取决于所使用的 RocketMQ operator 和镜像版本，因此在发布之前请根据您集群中生成的工作负载进行验证。

如果某个端口已被使用，请选择不同的端口，但保持该 broker 的 `port`、`targetPort` 和 `nodePort` 一致。

## 可选：创建 RocketMQ 控制台

示例 `Console` 资源：

```yaml
apiVersion: rocketmq.apache.org/v1alpha1
kind: Console
metadata:
  name: console
  namespace: <namespace>
spec:
  dockerImage: build-harbor.alauda.cn/middleware/rocketmq-dashboard:v3.7.0
  nameServers: namesrv1:9876;namesrv2:9876
  numberOfInstances: 1
  resources:
    limits:
      cpu: "2"
      memory: 1000Mi
    requests:
      cpu: 500m
      memory: 500Mi
```

使用 NodePort 服务暴露它：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: console-service
  namespace: <namespace>
spec:
  type: NodePort
  ports:
    - protocol: TCP
      port: 8080
      targetPort: 8080
      nodePort: 30000
  selector:
    app: rocketmq-console
```

## 访问

部署后：

- 集群外的 RocketMQ 客户端使用外部 NameServer 端点。
- 控制台可通过以下方式访问：

```text
http://<node-ip>:30000
```

---
products:
  - Alauda Container Platform
kind:
  - Solution
id: KB1757074735-2DA0
sourceSHA: 1653e644918065cc94a266ee98dc69caeb7a5f6d0b0cb167ec4a7babae612809
---

# Elasticsearch 规模切换

## 背景

该产品的 Elasticsearch 日志存储插件提供单节点、小规模和大规模部署选项。

单节点部署指的是单个 ES 实例，适用于每秒最多 1400 项和总日志不超过 10 GB 的环境。

小规模部署至少需要 3 个 ES 数据节点（没有专用主节点），适用于每秒最多 12,000 项和总日志不超过 300 GB 的环境。

大规模部署至少需要 3 个数据节点和 3 个主节点，适用于每秒超过 12,000 项和总日志 300 GB 或更多的环境。

在 4.0 版本之后，该产品禁止在界面上切换不同规模，仅支持在同一规模内的节点扩展。如果需要调整部署规模，必须通过此解决方案进行修改。

## 环境信息

适用版本：4.0.x, 4.1.x

## 操作步骤

登录到 **全局主节点**。从单节点直接切换到大规模配置在技术上是不支持的。

## LocalVolume 存储类型的修改步骤

### 从单节点切换到小规模

```shell
kubectl get moduleinfo -A | grep logcenter | grep <cluster-name>                     # 检查目标集群的 logcenter
kubectl edit moduleinfo <moduleinfo_name>                                            # 编辑 moduleinfo YAML 并修改以下部分
```

```yaml
apiVersion: cluster.alauda.io/v1alpha1
kind: ModuleInfo
metadata:
  annotations:
    cpaas.io/display-name: logcenter
    cpaas.io/module-name: '{"en": "Alauda Container Platform Log Storage for Elasticsearch",
      "zh": "Alauda Container Platform Log Storage for Elasticsearch"}'
  creationTimestamp: "<20xx-xx-xxTxx:xx:xxZ>"
  finalizers:
  - moduleinfo
  generation: 3
  labels:
    cpaas.io/cluster-name: global
    cpaas.io/module-name: logcenter
    cpaas.io/module-type: plugin
    cpaas.io/product: Platform-Center
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: global-e671599464a5b1717732c5ba36079795
  resourceVersion: "4202333"
  uid: <Standed UUID>
spec:
  config:
    clusterView:
      isPrivate: "true"
    components:
      elasticsearch:
        address: ""
        basicAuthSecretName: ""
        hostpath: /cpaas/data/elasticsearch
        httpPort: 9200
        install: true
        # 更新 spec.config.components.elasticsearch.k8sNodes 字段以添加 ES 节点（在 minfo 中可选；可以在扩展后通过插件 UI 更新）
        k8sNodes:
        - 1.1.1.1
        - 2.2.2.2
        - 3.3.3.3
        masterK8sNodes: []
        masterReplicas: 0
        masterResources:
          limits:
            cpu: "2"
            memory: 4Gi
          requests:
            cpu: 200m
            memory: 256Mi
        masterStorageSize: 5
        nodeReplicas: 1
        nodeStorageSize: 200
        # 调整 spec.config.components.elasticsearch.resources.limits 字段以修改 ES 数据节点的资源限制（建议至少设置为小规模默认的 2c4G；在 minfo 中可选；可以在扩展后通过插件 UI 更新）
        resources:
          limits:
            cpu: "2"
            memory: 4Gi
          requests:
            cpu: 200m
            memory: 256Mi
        tcpPort: 9300
        # 将规模类型从 `single` 更改为 `normal` (**必须在 minfo 中修改**)
        type: normal
```

### 从小规模切换到大规模

```shell
kubectl get moduleinfo -A | grep logcenter | grep <cluster-name>                     # 检查目标集群的 logcenter
kubectl edit moduleinfo <moduleinfo_name>                                            # 编辑 moduleinfo YAML 并修改以下部分
```

```yaml
apiVersion: cluster.alauda.io/v1alpha1
kind: ModuleInfo
metadata:
  annotations:
    cpaas.io/display-name: logcenter
    cpaas.io/module-name: '{"en": "Alauda Container Platform Log Storage for Elasticsearch",
      "zh": "Alauda Container Platform Log Storage for Elasticsearch"}'
  creationTimestamp: "<20xx-xx-xxTxx:xx:xxZ>"
  finalizers:
  - moduleinfo
  generation: 3
  labels:
    cpaas.io/cluster-name: global
    cpaas.io/module-name: logcenter
    cpaas.io/module-type: plugin
    cpaas.io/product: Platform-Center
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: global-e671599464a5b1717732c5ba36079795
  resourceVersion: "4202333"
  uid: <Standed UUID>
spec:
  config:
    clusterView:
      isPrivate: "true"
    components:
      elasticsearch:
        address: ""
        basicAuthSecretName: ""
        hostpath: /cpaas/data/elasticsearch
        httpPort: 9200
        install: true
        # 更新 spec.config.components.elasticsearch.k8sNodes 字段以添加 ES 节点，更新 spec.config.components.elasticsearch.masterK8sNodes 字段以添加主节点（在 minfo 中可选；可以在扩展后通过插件 UI 更新）
        k8sNodes:
        - 1.1.1.1
        - 2.2.2.2
        - 3.3.3.3
        masterK8sNodes: 
        - 4.4.4.4
        - 5.5.5.5
        - 6.6.6.6 
        masterReplicas: 0
        masterResources:
          limits:
            cpu: "2"
            memory: 4Gi
          requests:
            cpu: 200m
            memory: 256Mi
        masterStorageSize: 5
        nodeReplicas: 1
        nodeStorageSize: 200
        # 调整 spec.config.components.elasticsearch.resources.limits 字段以修改 ES 数据节点的资源限制（建议至少设置为大规模默认的 8c16G；在 minfo 中可选；可以在扩展后通过插件 UI 更新）
        resources:
          limits:
            cpu: "8"
            memory: 16Gi
          requests:
            cpu: "1"
            memory: 2Gi
        tcpPort: 9300
        # 将规模类型从 `normal` 更改为 `big` (**必须在 minfo 中修改**)
        type: big
```

## StorageClass 存储类型的修改步骤

### 从单节点切换到小规模

```shell
kubectl get moduleinfo -A | grep logcenter | grep <cluster-name>                     # 检查目标集群的 logcenter
kubectl edit moduleinfo <moduleinfo_name>                                            # 编辑 moduleinfo YAML 并修改以下部分
```

```yaml
apiVersion: cluster.alauda.io/v1alpha1
kind: ModuleInfo
metadata:
  annotations:
    cpaas.io/display-name: logcenter
    cpaas.io/module-name: '{"en": "Alauda Container Platform Log Storage for Elasticsearch",
      "zh": "Alauda Container Platform Log Storage for Elasticsearch"}'
  creationTimestamp: "<20xx-xx-xxTxx:xx:xxZ>"
  finalizers:
  - moduleinfo
  generation: 1
  labels:
    cpaas.io/cluster-name: business-1
    cpaas.io/module-name: logcenter
    cpaas.io/module-type: plugin
    cpaas.io/product: Platform-Center
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: business-1-40e797a4de9697ada933390391d9d0b4
  ownerReferences:
  - apiVersion: platform.tkestack.io/v1
    kind: Cluster
    name: business-1
    uid: 5f2d5e02-662d-4f06-9a27-17f756e8dbe3
  resourceVersion: "773014"
  uid: <Standed UUID>
spec:
  config:
    clusterView:
      isPrivate: "true"
    components:
      elasticsearch:
        address: ""
        basicAuthSecretName: ""
        hostpath: /cpaas/data/elasticsearch
        httpPort: 9200
        install: true
        k8sNodes: []
        masterK8sNodes: []
        masterReplicas: 0
        masterResources:
          limits:
            cpu: "2"
            memory: 4Gi
          requests:
            cpu: 200m
            memory: 256Mi
        masterStorageSize: 5
        # 修改 spec.config.components.elasticsearch.nodeReplicas 字段以调整 ES 实例的数量。实例数量可以自定义，最小值为 3。或者，此修改可以在扩展后通过插件界面进行。
        nodeReplicas: 3
        nodeStorageSize: 200
        # 修改 spec.config.components.elasticsearch.resources.limits 字段以调整 ES 数据节点的资源配额。建议至少设置为默认的小规模配置 2c4G，可以自定义。或者，此修改也可以在扩展后通过插件界面进行。
        resources:
          limits:
            cpu: "2"
            memory: 4Gi
          requests:
            cpu: 200m
            memory: 256Mi
        tcpPort: 9300
        # 将规模类型从 `single` 更改为 `normal` (**必须在 moduleinfo 中修改**)
        type: normal
```

### 从小规模切换到大规模

```shell
kubectl get moduleinfo -A | grep logcenter | grep <cluster-name>                     # 检查目标集群的 logcenter
kubectl edit moduleinfo <moduleinfo_name>                                            # 编辑 moduleinfo YAML 并修改以下部分
```

```yaml
apiVersion: cluster.alauda.io/v1alpha1
kind: ModuleInfo
metadata:
  annotations:
    cpaas.io/display-name: logcenter
    cpaas.io/module-name: '{"en": "Alauda Container Platform Log Storage for Elasticsearch",
      "zh": "Alauda Container Platform Log Storage for Elasticsearch"}'
  creationTimestamp: "<20xx-xx-xxTxx:xx:xxZ>"
  finalizers:
  - moduleinfo
  generation: 1
  labels:
    cpaas.io/cluster-name: business-1
    cpaas.io/module-name: logcenter
    cpaas.io/module-type: plugin
    cpaas.io/product: Platform-Center
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: business-1-40e797a4de9697ada933390391d9d0b4
  ownerReferences:
  - apiVersion: platform.tkestack.io/v1
    kind: Cluster
    name: business-1
    uid: 5f2d5e02-662d-4f06-9a27-17f756e8dbe3
  resourceVersion: "773014"
  uid: <Standed UUID>
spec:
  config:
    clusterView:
      isPrivate: "true"
    components:
      elasticsearch:
        address: ""
        basicAuthSecretName: ""
        hostpath: /cpaas/data/elasticsearch
        httpPort: 9200
        install: true
        k8sNodes: []
        masterK8sNodes: []
        # 修改 spec.config.components.elasticsearch.masterReplicas 字段以调整 ES 主节点实例的数量（最小 3），此修改可以在扩展后通过插件界面进行。
        masterReplicas: 3
        masterResources:
          limits:
            cpu: "2"
            memory: 4Gi
          requests:
            cpu: 200m
            memory: 256Mi
        masterStorageSize: 5
        # 修改 spec.config.components.elasticsearch.nodeReplicas 字段以调整 ES 数据节点实例的数量（最小 3），此修改可以在扩展后通过插件界面进行。
        nodeReplicas: 3
        nodeStorageSize: 200
        # 修改 spec.config.components.elasticsearch.resources.limits 字段以调整 ES 数据节点的资源配额。建议至少设置为默认的大规模配置 8c16G，可以自定义。此修改也可以在扩展后通过插件界面进行。
        resources:
          limits:
            cpu: "8"
            memory: 16Gi
          requests:
            cpu: "1"
            memory: 2Gi
        tcpPort: 9300
        # 将规模类型从 `normal` 更改为 `big` (**必须在 minfo 中修改**)
        type: big
```

## 验证步骤

修改后，检查在 **平台管理** **> Marketplace > Clusters Plugins > ACP Log Collector** 部分是否已生效。

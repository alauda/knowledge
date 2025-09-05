---
products: 
  - Alauda Container Platform
kind:
  - Solution
---

# Elasticsearch Scale Switching

## Background

The product's Elasticsearch log storage plugin offers single-node, small-scale, and large-scale deployment options. After version 4.0, the product prohibits switching between different scales on the interface and only supports node expansion within the same scale. Manual operations are required to modify the scale if needed.

## Environment Information

Applicable Versions: 4.0.x, 4.1.x

## Procedure

Log in to the **global master node**. Direct switching from a single-node to a large-scale configuration is technically unsupported.

## Modification Steps for LocalVolume Storage Type

### Switching from single-node to small-scale

```shell
kubectl get moduleinfo -A | grep logcenter | grep <cluster-name>                     # Check the logcenter of the target cluster
kubectl edit moduleinfo <moduleinfo_name>                                            # Edit the moduleinfo YAML and modify the following sections
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
        # Update the spec.config.components.elasticsearch.k8sNodes field to add ES nodes (optional in minfo; can be updated later via the plugin UI after scaling)
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
        # Adjust the spec.config.components.elasticsearch.resources.limits field to modify resource limits for ES data nodes (recommended to set at least the small-scale default of 2c4G; optional in minfo; can be updated later via the plugin UI)
        resources:
          limits:
            cpu: "2"
            memory: 4Gi
          requests:
            cpu: 200m
            memory: 256Mi
        tcpPort: 9300
        # Change the scale type from `single` to `normal` (**must be modified in minfo**)
        type: normal
```

### Switching from small-scale to large-scale

```shell
kubectl get moduleinfo -A | grep logcenter | grep <cluster-name>                     # Check the logcenter of the target cluster
kubectl edit moduleinfo <moduleinfo_name>                                            # Edit the moduleinfo YAML and modify the following sections
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
        # Update the spec.config.components.elasticsearch.k8sNodes field to add ES nodes and the spec.config.components.elasticsearch.masterK8sNodes field to add master nodes (optional in minfo; can be updated later via the plugin UI after scaling)
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
        # Adjust the spec.config.components.elasticsearch.resources.limits field to modify resource limits for ES data nodes (recommended to set at least the large-scale default of 8c16G; optional in minfo; can be updated later via the plugin UI)
        resources:
          limits:
            cpu: "8"
            memory: 16Gi
          requests:
            cpu: "1"
            memory: 2Gi
        tcpPort: 9300
        # Change the scale type from `normal` to `big` (**must be modified in minfo**)
        type: big
```

## Modification Steps for StorageClass Storage Type

### Switching from single-node to small-scale

```shell
kubectl get moduleinfo -A | grep logcenter | grep <cluster-name>                     # Check the logcenter of the target cluster
kubectl edit moduleinfo <moduleinfo_name>                                            # Edit the moduleinfo YAML and modify the following sections
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
        # Modify the spec.config.components.elasticsearch.nodeReplicas field to adjust the number of ES instances. The instance count can be customized with a minimum value of 3. Alternatively, this modification can be performed via the plugin interface after scaling.
        nodeReplicas: 3
        nodeStorageSize: 200
        # Modify the spec.config.components.elasticsearch.resources.limits field to adjust resource quotas for ES data nodes. It is recommended to set at least the default small-scale configuration of 2c4G, which can be customized. Alternatively, this modification can also be performed via the plugin interface after scaling.
        resources:
          limits:
            cpu: "2"
            memory: 4Gi
          requests:
            cpu: 200m
            memory: 256Mi
        tcpPort: 9300
        # Change the scale type from `single` to `normal` (**must be modified in moduleinfo**)
        type: normal
```

### Switching from small-scale to large-scale

```shell
kubectl get moduleinfo -A | grep logcenter | grep <cluster-name>                     # Check the logcenter of the target cluster
kubectl edit moduleinfo <moduleinfo_name>                                            # Edit the moduleinfo YAML and modify the following sections
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
        # Modify the spec.config.components.elasticsearch.masterReplicas field to adjust the number of ES master node instances (minimum 3), this modification can be performed via the plugin interface after scaling.
        masterReplicas: 3
        masterResources:
          limits:
            cpu: "2"
            memory: 4Gi
          requests:
            cpu: 200m
            memory: 256Mi
        masterStorageSize: 5
        # Modify the spec.config.components.elasticsearch.nodeReplicas field to adjust the number of ES data node instances (minimum 3), this modification can be performed via the plugin interface after scaling.
        nodeReplicas: 3
        nodeStorageSize: 200
        # Modify the spec.config.components.elasticsearch.resources.limits field to adjust resource quotas for ES data nodes. It is recommended to set at least the default large-scale configuration of 8c16G, which can be customized. This modification can also be performed via the plugin interface after scaling.
        resources:
          limits:
            cpu: "8"
            memory: 16Gi
          requests:
            cpu: "1"
            memory: 2Gi
        tcpPort: 9300
        # Change the scale type from `normal` to `big` (**must be modified in minfo**)
        type: big
```

## Verification Steps

After modification, check whether the changes have taken effect in the **Platform Management** **> Marketplace > Clusters Plugins > ACP Log Collector** section.

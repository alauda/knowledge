---
products: 
  - Alauda Container Platform
kind:
  - Solution
---


# Resolution for Conflict Between Platform-Exclusive Scenarios and Log Monitoring Plugin in Upgrade to Version 4.2

## Background

When upgrading the ACP version to 4.2.x, conflicts between the platform-exclusive scenario and the self-selected nodes for the log monitoring plugin cause upgrade failures. This solution is required to resolve the issue.

## Applicable Scenarios

Upgrading to version 4.2.x.

## Detection

### Step 1: Check if it is a Platform-Exclusive Scenario

```shell
1. Log in to the master node of the global cluster.

2. Execute the following command. If the return value is Base, it indicates a platform-exclusive scenario. Proceed to the next step of detection.

➜ kubectl get productbase.v1alpha1.product.alauda.io base -o jsonpath='{.spec.deployType}'
```

### Step 2: Check if the Global Log Monitoring Plugin Uses Local Storage and Non-Platform-Exclusive Nodes

```shell
1. Log in to the master node of the global cluster.

2. Retrieve the platform-exclusive nodes.

➜ kubectl get nodes -l node-role.kubernetes.io/cpaas-system -o wide

3. Execute the following command to confirm if the log monitoring plugin is deployed.

➜ kubectl get moduleinfo -l 'cpaas.io/cluster-name=global,cpaas.io/module-name in (prometheus,victoriametrics,logcenter,logclickhouse)' -o custom-columns=NAME:'.metadata.name',MODULE:'.metadata.labels.cpaas\.io/module-name'

4. Confirm whether the deployed log monitoring plugin uses local storage and non-platform-exclusive nodes.

Prometheus/Victoriametrics Monitoring Plugin: Check if the return indicates LocalVolume and uses non-platform-exclusive nodes. If yes, execute the corresponding operations for this plugin in the Problem Resolution steps.
➜ kubectl get moduleinfo <moduleinfo-name> -o jsonpath='Type:{.spec.config.storage.type}{"\n"}Nodes:{.spec.config.storage.nodes}{"\n"}'

Elasticsearch Log Storage Plugin: Check if the return indicates LocalVolume and uses non-platform-exclusive nodes. If yes, execute the corresponding operations for this plugin in the Problem Resolution steps.
➜ kubectl get moduleinfo <moduleinfo-name> -o jsonpath='Type:{.spec.config.components.storageClassConfig.type}{"\n"}ESNodes:{.spec.config.components.elasticsearch.k8sNodes}{"\n"}ESMasterNodes:{.spec.config.components.elasticsearch.masterK8sNodes}{"\n"}KafkaNodes:{.spec.config.components.kafka.k8sNodes}{"\n"}'

ClickHouse Log Storage Plugin: Check if the return indicates LocalVolume and uses non-platform-exclusive nodes. If yes, execute the corresponding operations for this plugin in the Problem Resolution steps.
➜ kubectl get moduleinfo <moduleinfo-name> -o jsonpath='Type:{.spec.config.components.storageClassConfig.type}{"\n"}CKNodes:{.spec.config.components.clickhouse.k8sNodes}{"\n"}'
```

## Problem Resolution

### Prometheus Monitoring Plugin

```shell
cat <<EOF | kubectl create -f -
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  labels:
    target: fb6047e14c28909f84766d7902c9b546
  name: change-prometheus-prometheus-0-nodeselector
spec:
  jsonPatch:
    - op: remove
      path: /spec/nodeSelector/node-role.kubernetes.io~1cpaas-system
  release: cpaas-system/kube-prometheus
  target:
    apiVersion: monitoring.coreos.com/v1
    kind: Prometheus
    name: kube-prometheus-0
    namespace: cpaas-system
---
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  labels:
    target: 3e1291e8a1158e0ae1ca0febb722a6eb
  name: change-prometheus-prometheus-1-nodeselector
spec:
  jsonPatch:
    - op: remove
      path: /spec/nodeSelector/node-role.kubernetes.io~1cpaas-system
  release: cpaas-system/kube-prometheus
  target:
    apiVersion: monitoring.coreos.com/v1
    kind: Prometheus
    name: kube-prometheus-1
    namespace: cpaas-system
---
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  labels:
    target: 71ee303f02f933b9cabfbf667dab683e
  name: change-prometheus-prometheus-2-nodeselector
spec:
  jsonPatch:
    - op: remove
      path: /spec/nodeSelector/node-role.kubernetes.io~1cpaas-system
  release: cpaas-system/kube-prometheus
  target:
    apiVersion: monitoring.coreos.com/v1
    kind: Prometheus
    name: kube-prometheus-2
    namespace: cpaas-system
---
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  labels:
    target: 8b98cf81313f70917e55c320ac8528ee
  name: change-prometheus-alertmanager-nodeselector
spec:
  jsonPatch:
    - op: remove
      path: /spec/nodeSelector/node-role.kubernetes.io~1cpaas-system
  release: cpaas-system/kube-prometheus
  target:
    apiVersion: monitoring.coreos.com/v1
    kind: Alertmanager
    name: kube-prometheus
    namespace: cpaas-system
EOF
```

### Victoriametrics Monitoring Plugin

```shell
cat <<EOF | kubectl create -f -
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  labels:
    target: c3849be9de68b3745c2448e4a91e03ca
  name: change-victoriametrics-vmcluster-nodeselector
spec:
  jsonPatch:
    - op: remove
      path: /spec/vminsert/nodeSelector/node-role.kubernetes.io~1cpaas-system
    - op: remove
      path: /spec/vmselect/nodeSelector/node-role.kubernetes.io~1cpaas-system
    - op: remove
      path: /spec/vmstorage/nodeSelector/node-role.kubernetes.io~1cpaas-system
  release: cpaas-system/victoriametrics
  target:
    apiVersion: operator.victoriametrics.com/v1beta1
    kind: VMCluster
    name: cluster
    namespace: cpaas-system
---
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  labels:
    target: 3592effe9303af75b2419d6ae3627a6e
  name: change-victoriametrics-alertmanager-nodeselector
spec:
  jsonPatch:
    - op: remove
      path: /spec/nodeSelector/node-role.kubernetes.io~1cpaas-system
  release: cpaas-system/victoriametrics
  target:
    apiVersion: operator.victoriametrics.com/v1beta1
    kind: VMAlertmanager
    name: alertmanager
    namespace: cpaas-system
EOF
```

### Elasticsearch Log Plugin

```shell
cat <<EOF | kubectl create -f -
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  labels:
    target: b8a8e4e1de90097a4271feb975390b5e
  name: change-elasticsearch-elasticsearch-nodeselector
spec:
  jsonPatch:
    - op: remove
      path: /spec/template/spec/nodeSelector/node-role.kubernetes.io~1cpaas-system
  release: cpaas-system/logcenter
  target:
    apiVersion: apps/v1
    kind: StatefulSet
    name: cpaas-elasticsearch
    namespace: cpaas-system
---
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  labels:
    target: cb421402b28b1500cdeb51abacf3103f
  name: change-elasticsearch-elasticsearch-master-nodeselector
spec:
  jsonPatch:
    - op: remove
      path: /spec/template/spec/nodeSelector/node-role.kubernetes.io~1cpaas-system
  release: cpaas-system/logcenter
  target:
    apiVersion: apps/v1
    kind: StatefulSet
    name: cpaas-elasticsearch-master
    namespace: cpaas-system
---
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  labels:
    target: ac007aec25b3c1248bc7078c93b96a22
  name: change-elasticsearch-kafka-nodeselector
spec:
  jsonPatch:
    - op: remove
      path: /spec/template/spec/nodeSelector/node-role.kubernetes.io~1cpaas-system
  release: cpaas-system/logcenter
  target:
    apiVersion: apps/v1
    kind: StatefulSet
    name: cpaas-kafka
    namespace: cpaas-system
---
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  labels:
    target: decb9711da9687416144fb09c9a90b92
  name: change-elasticsearch-zookeeper-nodeselector
spec:
  jsonPatch:
    - op: remove
      path: /spec/template/spec/nodeSelector/node-role.kubernetes.io~1cpaas-system
  release: cpaas-system/logcenter
  target:
    apiVersion: apps/v1
    kind: StatefulSet
    name: cpaas-zookeeper
    namespace: cpaas-system
EOF
```

### ClickHouse Log Plugin

```shell
cat <<EOF | kubectl create -f -
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  labels:
    target: cb60c71fba588ce93207398793d5df0a
  name: change-clickhouse-clickhouse-nodeselector
spec:
  jsonPatch:
    - op: remove
      path: /spec/templates/podTemplates/0/spec/nodeSelector/node-role.kubernetes.io~1cpaas-system
    - op: remove
      path: /spec/templates/podTemplates/1/spec/nodeSelector/node-role.kubernetes.io~1cpaas-system
  release: cpaas-system/logclickhouse
  target:
    apiVersion: clickhouse.altinity.com/v1
    kind: ClickHouseInstallation
    name: cpaas-clickhouse
    namespace: cpaas-system
---
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  labels:
    target: 8431e11f34de6f62013c123e5ca373bf
  name: change-clickhouse-razor-nodeselector
spec:
  jsonPatch:
    - op: remove
      path: /spec/template/spec/nodeSelector/node-role.kubernetes.io~1cpaas-system
  release: cpaas-system/logclickhouse
  target:
    apiVersion: apps/v1
    kind: StatefulSet
    name: razor
    namespace: cpaas-system
EOF
```

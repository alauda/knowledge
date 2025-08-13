---
products: 
   - Alauda Container Platform
kind:
   - Solution
---

# How to Correct the Issue of Node Role Settings in big cluster ElasticSearch

## Issue

The big cluster ElasticSearch upgrade from ACP version 3.18.2 to 4.x will have the following failures: `node does not have the data role but has shard data`

It is necessary to use this solution to correct node roles setting before the upgrade

## Environment

v3.18.2

## Diagnostic Steps

### Step 0: Prepare ElasticSearch connection info

Log in to a controller node in cluster
```shell
# Retrieve ElasticSearch connection details and credentials
ES_HOST=$(kubectl -n cpaas-system get feature log-center -o jsonpath='{.spec.accessInfo.elasticsearch.address}')
USERNAME=$(kubectl -n cpaas-system get secrets elasticsearch-basic-auth -o yaml | grep username | awk '{print $2}' | base64 -d)
PASSWORD=$(kubectl -n cpaas-system get secrets elasticsearch-basic-auth -o yaml | grep password | awk '{print $2}' | base64 -d)
```

### Step 1: Ensure ElasticSearch is ready

Execute the following command to ensure ElasticSearch statue is green
```shell
curl -sk -u $USERNAME:$PASSWORD "$ES_HOST/_cluster/health?pretty"

# Example
{
  "cluster_name" : "prod-alauda",
  "status" : "green",
  ...
}
```

### Step 2: Modify the roles of cpaas-elasticsearch to data

Execute the following command to edit StatefulSet cpaas-elasticsearch roles to data:
```shell
kubectl edit statefulset -n cpaas-system cpaas-elasticsearch
```

Reference the following content for modification:
```yaml
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  annotations:
    configmap.reloader.stakater.com/reload: es-config-v7
    secret.reloader.stakater.com/reload: elasticsearch-basic-auth,elasticsearch-node0-cert
  labels:
    service_name: cpaas-elasticsearch
  name: cpaas-elasticsearch
  namespace: cpaas-system
spec:
  ...
  template:
    ...
    spec:
      ...
      containers:
      - env:
        - name: CPU_LIMIT
          valueFrom:
            resourceFieldRef:
              containerName: cpaas-elasticsearch
              divisor: "0"
              resource: limits.cpu
        - name: MEM_LIMIT
          valueFrom:
            resourceFieldRef:
              containerName: cpaas-elasticsearch
              divisor: "0"
              resource: limits.memory
# CHANGE the following content
        - name: node.data
          value: "true"
        - name: node.master
          value: "false"
# TO:
        - name: node.roles
          value: "data"  
# END
        - name: ALAUDA_ES_CLUSTERS
          value: xxx.xxx.xx.xx,xxx.xxx.xx.xx,xxx.xxx.xx.xx
        - name: COMP_NAME
          value: elasticsearch
  ...
``` 
Wait the pod running

Execute the following command to check the ElasticSearch roles is data
```shell
curl -sk -u $USERNAME:$PASSWORD "$ES_HOST/_cat/nodes?v" | grep -v cpaas-elasticsearch-master

# Example: node.role `d` means data
ip         heap.percent ram.percent cpu load_1m load_5m load_15m node.role master name
xx.x.x.xxx           29          88   3    0.82    0.98     1.17 d         -      cpaas-elasticsearch-2
xx.x.x.xxx           27          86   1    0.67    0.87     0.94 d         -      cpaas-elasticsearch-0
xx.x.x.xxx           55          88   1    1.01    0.96     1.35 d         -      cpaas-elasticsearch-1
```

### Step 3: Prohibit the allocation of shards to the ElasticSearch master node

Execute the following command to prohibit the allocation of shards to the ElasticSearch master node
```shell
# Get all the ElasticSearch master node
ES_MASTER_NODES=$(kubectl get po -n cpaas-system --no-headers -o custom-columns=":metadata.name" | grep 'cpaas-elasticsearch-master' | paste -sd, -)
 
# Prohibit the allocation of shards to the master node
curl -sk -X PUT -u "$USERNAME:$PASSWORD" "$ES_HOST/_cluster/settings" \
     -H 'Content-Type: application/json' \
     -d "{\"transient\": {\"cluster.routing.allocation.exclude._name\": \"$ES_MASTER_NODES\"}}"

# Check the cluster settings have been set
curl -sk -u $USERNAME:$PASSWORD "$ES_HOST/_cluster/settings?pretty"

# Example:
{
  "persistent" : { },
  "transient" : {
    "cluster" : {
      "routing" : {
        "allocation" : {
          "exclude" : {
            "_name" : "cpaas-elasticsearch-master-0,cpaas-elasticsearch-master-1,cpaas-elasticsearch-master-2"
          }
        }
      }
    }
  }
}
```

### Step 4: Wait for allocation to complete

Execute the following command to view the shards allocation until there is no shards on the master node at all: 
```shell
curl -sk -u $USERNAME:$PASSWORD "$ES_HOST/_cat/shards?v" | grep cpaas-elasticsearch-master
```

### Step 5: Modify the roles of cpaas-elasticsearch-master to master

Execute the following command to edit statefulset cpaas-elasticsearch-master roles to master: 
```shell 
kubectl edit statefulset -n cpaas-system cpaas-elasticsearch-master
```

Reference the following content for modification:
```yaml
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  annotations:
    configmap.reloader.stakater.com/reload: es-config-v7
    secret.reloader.stakater.com/reload: elasticsearch-basic-auth,elasticsearch-node0-cert
  labels:
    service_name: cpaas-elasticsearch
  name: cpaas-elasticsearch-master
  namespace: cpaas-system
spec:
  ...
  template:
    ...
    spec:
      ...
      containers:
      - env:
# CHANGE the following content
          - name: node.data
            value: "false"
          - name: node.master
            value: "true"
# TO:
          - name: node.roles
            value: "master"
# END  
        - name: ALAUDA_ES_CLUSTERS
          value: xxx.xxx.xx.xx,xxx.xxx.xx.xx,xxx.xxx.xx.xx
        - name: COMP_NAME
          value: elasticsearch
  ...
```
Wait the pod running

Execute the following command to check the ElasticSearch roles is master
```shell
curl -sk -u $USERNAME:$PASSWORD "$ES_HOST/_cat/nodes?v" | grep master

# Example: node.role `m` means master
ip         heap.percent ram.percent cpu load_1m load_5m load_15m node.role master name
xx.x.x.xxx           39          59   0    0.48    0.73     1.05 m         *      cpaas-elasticsearch-master-2
xx.x.x.xxx           52          59   0    1.02    1.40     1.25 m         -      cpaas-elasticsearch-master-1
xx.x.x.xxx           29          59   0    0.85    0.91     1.06 m         -      cpaas-elasticsearch-master-0
```

### Step 6: Restore the prohibition of allocating shards to the master node

Execute the following command to restore the prohibition of allocating shards to the elasticsearch master node
```shell
curl -sk -X PUT -u "$USERNAME:$PASSWORD" "$ES_HOST/_cluster/settings" \
     -H 'Content-Type: application/json' \
     -d '{"transient": {"cluster.routing.allocation.exclude._name": null}}' 
 
# Check the cluster settings have been restored
curl -sk -u $USERNAME:$PASSWORD "$ES_HOST/_cluster/settings?pretty"

# Example:
{
  "persistent" : {},
  "transient" : {}
}
```

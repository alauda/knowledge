---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# How to Configure RocketMQ Console

## Problem

Deploy and access `rocketmq-console` for an existing RocketMQ cluster.

## Prerequisites

- A RocketMQ cluster is already deployed.
- You know the NameServer Service addresses for the target cluster.

## Create the Console Resource

Example `Console` custom resource:

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

Parameter notes:

- `namespace`: use the same namespace as the RocketMQ instance you want to manage
- `nameServers`: point to the target RocketMQ NameServer Service addresses

## Example Deployment

```yaml
apiVersion: rocketmq.apache.org/v1alpha1
kind: Console
metadata:
  name: console
  namespace: dba-demo
spec:
  nameServers: demo-nameserver-server-0.dba-demo.svc.cluster.local:9876;demo-nameserver-nodes.dba-demo.svc.cluster.local:9876
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

Create it with:

```bash
kubectl create -f /tmp/rocketmq-console.yaml
```

## Verify

Check the console pod:

```bash
kubectl get pod -n <namespace> -owide | grep console
```

Check the console Service:

```bash
kubectl get svc -n <namespace> | grep console-service
```

Example result:

```text
console-console-service   NodePort   ...   8080:<nodeport>/TCP
```

## Access

Open the console through the Service address:

```text
http://<node-ip>:<nodeport>
```

## Notes

- Make sure the console namespace and the target RocketMQ namespace are aligned unless your environment explicitly supports cross-namespace access.
- If multiple NameServers are used, separate them with semicolons.

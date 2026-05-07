---
products:
  - Alauda Application Services
kind:
  - Solution
---

# How to Deploy the RedisInsight Web Console

## Introduction

RedisInsight is a graphical user interface for interacting with Redis databases. It supports key browsing, CRUD operations on standard data structures, JSON editing, slow log analysis, Pub/Sub, bulk operations, and a Workbench for advanced commands. This guide explains how to deploy RedisInsight 2.58 in a Kubernetes cluster and connect it to Sentinel and Cluster mode Redis instances.

:::warning
RedisInsight does not include built-in authentication or authorization. Once the service is exposed, anyone who can reach the URL can connect and operate on attached Redis instances. Restrict access at the network or load balancer layer.
:::

## Prerequisites

- A Kubernetes cluster with `kubectl` access.
- A working `StorageClass` for persistent storage.
- The RedisInsight image available in your image registry. Pull `redis/redisinsight:2.58` from Docker Hub (`https://hub.docker.com/r/redis/redisinsight`) and push it to your private registry.

## Procedure

### 1. Prepare the Image

Pull and push the RedisInsight image to your registry. Replace the `image` field in the deployment YAML with the registry-specific path if needed.

### 2. Apply the Deployment YAML

Save the following manifest as `redis-insight.yaml`. Adjust the `storageClassName` and resource limits as appropriate for your environment.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  labels:
    app.kubernetes.io/name: redis-insight
  name: redis-insight-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  storageClassName: <your-storage-class>
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app.kubernetes.io/name: redis-insight
  name: redis-insight
spec:
  replicas: 1
  revisionHistoryLimit: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: redis-insight
  strategy:
    type: Recreate
  template:
    metadata:
      labels:
        app.kubernetes.io/name: redis-insight
    spec:
      containers:
        - env:
            - name: RI_APP_PORT
              value: "5540"
            - name: RI_APP_HOST
              value: "0.0.0.0"
            - name: RI_ENCRYPTION_KEY
              value: ""
            - name: RI_LOG_LEVEL
              value: info
            - name: RI_FILES_LOGGER
              value: "false"
            - name: RI_STDOUT_LOGGER
              value: "true"
            - name: RI_PROXY_PATH
              value: ""
          image: redis/redisinsight:2.58
          imagePullPolicy: IfNotPresent
          name: web
          ports:
            - name: http
              containerPort: 5540
              protocol: TCP
          resources:
            limits:
              cpu: 1
              memory: 1Gi
            requests:
              cpu: 500m
              memory: 500Mi
          livenessProbe:
            failureThreshold: 3
            initialDelaySeconds: 10
            periodSeconds: 10
            successThreshold: 1
            httpGet:
              path: /api/health/
              port: http
            timeoutSeconds: 5
          startupProbe:
            failureThreshold: 3
            initialDelaySeconds: 10
            periodSeconds: 10
            successThreshold: 1
            tcpSocket:
              port: http
            timeoutSeconds: 5
          securityContext:
            readOnlyRootFilesystem: true
            runAsUser: 1000
            runAsNonRoot: true
            runAsGroup: 1000
          volumeMounts:
            - mountPath: /data
              name: redis-insight-data
      restartPolicy: Always
      securityContext:
        fsGroup: 1000
      terminationGracePeriodSeconds: 30
      volumes:
        - name: redis-insight-data
          persistentVolumeClaim:
            claimName: redis-insight-data
---
apiVersion: v1
kind: Service
metadata:
  labels:
    app.kubernetes.io/name: redis-insight
  name: redis-insight
spec:
  ports:
    - name: http
      port: 5540
      protocol: TCP
      targetPort: http
  selector:
    app.kubernetes.io/name: redis-insight
  type: NodePort
```

:::note
The container, Pod port, and Service port are all set to **5540** (the RedisInsight default since 2.x). `targetPort: http` resolves to the named container port, so all three values stay aligned.
:::

Deploy the resources:

```bash
kubectl -n <namespace> create -f redis-insight.yaml
```

### 3. Environment Variable Reference

The RedisInsight image supports the following environment variables:

| Name | Description | Default |
|------|-------------|---------|
| `RI_APP_PORT` | Port that RedisInsight listens on | `5540` |
| `RI_APP_HOST` | Address that RedisInsight listens on | `0.0.0.0` |
| `RI_SERVER_TLS_KEY` | TLS private key | (empty) |
| `RI_SERVER_TLS_CERT` | TLS certificate for the TLS key | (empty) |
| `RI_ENCRYPTION_KEY` | Encryption key for sensitive data stored locally (database passwords, Workbench history, etc.) | (empty) |
| `RI_LOG_LEVEL` | Log level | `info` |
| `RI_FILES_LOGGER` | Write logs to files | `true` |
| `RI_STDOUT_LOGGER` | Write logs to stdout | `true` |
| `RI_PROXY_PATH` | Sub-path when running behind a reverse proxy | (empty) |

## Accessing RedisInsight

### Via NodePort

The provided manifest exposes RedisInsight as a `NodePort` Service. Compute an externally reachable URL:

```bash
namespace="<namespace>"
echo "http://$(kubectl -n $namespace get pods -l app.kubernetes.io/name=redis-insight -o jsonpath='{.items[0].status.hostIP}'):$(kubectl -n $namespace get svc redis-insight -o jsonpath='{.spec.ports[0].nodePort}')"
```

### Via Load Balancer (ALB)

In **Container Platform > Networking > Load Balancers**, create a rule that forwards traffic to the `redis-insight` Service. Access RedisInsight using the load balancer's address.

## Connecting to Redis

After opening the RedisInsight URL and accepting the EULA, use **Add Redis Database**.

### Sentinel Mode

1. Enter the Sentinel address (cluster-internal address if RedisInsight is co-located with Redis, otherwise the external address). Leaving the password empty is acceptable: Sentinel password support is available starting from operator version 3.18.
2. Configure the replica connection: set **Database Alias**, **Password**, and **Database Index** as required.
3. Select the group(s) to add the instance to.
4. Return to the home page from the top-left logo. The new instance appears in the list. Click an entry to inspect and edit data.

### Cluster Mode

1. Enter the address of any cluster node (cluster-internal or external).
2. RedisInsight automatically detects Cluster mode and adds the instance to the list.
3. Click the instance entry to inspect and edit data.

## Data Operations

- **Browse**: Click an instance to view its keys. Use filters to narrow results.
- **Edit**: Select a key to view its value in the right pane and edit in place.
- **Bulk Operations**: From the instance detail view, open **Workbench** in the left navigation to run multiple commands at once.

## Uninstall

To remove the RedisInsight deployment:

```bash
# Delete the Deployment
kubectl -n <namespace> delete deployment redis-insight
# Delete the Service
kubectl -n <namespace> delete svc redis-insight
# Delete the PersistentVolumeClaim
kubectl -n <namespace> delete pvc redis-insight-data
```

## Important Considerations

- **No built-in authentication**: Restrict network access to RedisInsight via the cluster firewall, ingress authentication, or a VPN. Treat RedisInsight as a privileged management tool.
- **Storage class availability**: Confirm the `storageClassName` exists in the cluster before applying the manifest. Substitute another storage class if needed.
- **Resource sizing**: The default limits (1 CPU / 1 GiB) suit small to medium environments. Increase them if you expect many concurrent users or large datasets.
- **Image source**: For air-gapped environments, ensure the RedisInsight image is mirrored to your internal registry before deployment.
- **Reference**: The procedures above are based on RedisInsight 2.58. UI elements may differ slightly in other versions. See the [official RedisInsight documentation](https://redis.io/docs/latest/develop/connect/insight/) for the latest guidance.

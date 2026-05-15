---
kind:
   - How To
products:
  - Alauda Application Services
ProductsVersion:
   - 4.0,4.1,4.2,4.3
id: KB260515005
---

# How to Deploy CloudBeaver for MySQL Management

## Issue

You need a web-based SQL client for browsing and querying MySQL instances managed by Alauda Application Services, without installing a desktop tool on every operator's workstation. CloudBeaver is the open-source web edition of DBeaver and runs as a single-pod Deployment on Kubernetes. This how-to deploys CloudBeaver and connects it to a MySQL Group Replication (MGR) instance.

## Environment

- Any Kubernetes cluster reachable to operators (NodePort exposure is used below; Ingress works equally well)
- A `StorageClass` capable of provisioning ReadWriteOnce PVCs — used to persist CloudBeaver workspace state across pod restarts
- Network reachability from the CloudBeaver pod to the target MySQL Router service

## Resolution

### 1. Prepare the manifest

Save the following to `cloudbeaver.yaml`. Adjust `storageClassName`, image registry, and resource requests to match your environment:

```yaml
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cloudbeaver
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  storageClassName: sc-topolvm     # replace with any RWO StorageClass available in the cluster
  volumeMode: Filesystem
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudbeaver
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cloudbeaver
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app: cloudbeaver
    spec:
      containers:
        - name: cloudbeaver
          image: docker-mirrors.alauda.cn/dbeaver/cloudbeaver:latest
          imagePullPolicy: Always
          ports:
            - name: web
              containerPort: 8978
              protocol: TCP
          resources:
            limits:
              cpu: "1"
              memory: 1Gi
            requests:
              cpu: 100m
              memory: 256Mi
          volumeMounts:
            - name: cloudbeaver-data
              mountPath: /opt/cloudbeaver/workspace
      volumes:
        - name: cloudbeaver-data
          persistentVolumeClaim:
            claimName: cloudbeaver
---
apiVersion: v1
kind: Service
metadata:
  name: cloudbeaver
spec:
  type: NodePort
  selector:
    app: cloudbeaver
  ports:
    - name: web
      port: 8978
      targetPort: 8978
      protocol: TCP
```

> CloudBeaver stores its administrator password, saved connections, and query history under `/opt/cloudbeaver/workspace`. Without a persistent volume, everything is lost on every pod restart. Confirm the chosen `storageClassName` exists in the target cluster before applying.

### 2. Deploy

```bash
kubectl -n <namespace> apply -f cloudbeaver.yaml
kubectl -n <namespace> rollout status deploy/cloudbeaver
```

### 3. Discover the access URL

The Service uses NodePort, so any node IP plus the allocated NodePort exposes the UI:

```bash
namespace=<namespace>
HOST=$(kubectl -n "$namespace" get pod -l app=cloudbeaver \
        -o jsonpath='{.items[0].status.hostIP}')
PORT=$(kubectl -n "$namespace" get svc cloudbeaver \
        -o jsonpath='{.spec.ports[0].nodePort}')
echo "http://$HOST:$PORT"
```

Open the URL in a browser.

### 4. Initial setup

1. On first launch CloudBeaver prompts you to set the administrator password. Choose a strong password and store it safely — this account governs all subsequent server-side configuration.
2. Log in with the administrator user.
3. (Optional) Switch the UI language under the user menu in the top-right.

### 5. Connect to a MySQL instance

1. Click **New Connection** and choose **MySQL**.
2. Fill **Host** with the Router service of the target MGR instance and **Port** with the read-write port. From outside the cluster, retrieve the NodePort:

   ```bash
   kubectl -n <mysql-namespace> get svc <instance>-router
   ```

3. Enter the application database user and password.
4. Under **Driver Properties**, set `allowPublicKeyRetrieval` to `TRUE` so the MySQL 8 driver can complete the `caching_sha2_password` handshake against a non-TLS endpoint. Do not enable this against an untrusted network — it lets the client retrieve the server's public key over an unencrypted channel.
5. Under **Access Management**, grant the current CloudBeaver user permission to use the new connection.
6. Save and test the connection. SQL editors can now be opened from the browser and queries executed against the MGR cluster.

### 6. Uninstall

```bash
kubectl -n <namespace> delete -f cloudbeaver.yaml
```

The PVC is removed alongside the rest of the manifest. To preserve CloudBeaver state for a future redeploy, delete only the Deployment and Service and re-attach the existing PVC during the next install.

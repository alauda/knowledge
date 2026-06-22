---
kind:
   - How To
products:
  - Alauda Application Services
ProductsVersion:
   - 4.0,4.1,4.2,4.3
id: KB260515008
---

# How to Deploy CloudBeaver for PostgreSQL Management

## Issue

You need a web-based SQL client for browsing and querying PostgreSQL instances managed by Alauda Application Services, without installing a desktop tool on every operator's workstation. CloudBeaver is the open-source web edition of DBeaver and runs as a single-pod Deployment on Kubernetes. This how-to deploys CloudBeaver and connects it to a PostgreSQL cluster managed by the PostgreSQL Operator.

## Environment

- Any Kubernetes cluster reachable to operators (NodePort exposure is used below; Ingress / Route works equally well)
- A `StorageClass` capable of provisioning ReadWriteOnce PVCs — used to persist CloudBeaver workspace state across pod restarts
- Network reachability from the CloudBeaver pod to the target PostgreSQL Service (`<cluster>` on port 5432)

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

> **Air-gapped / IPv6-only clusters:** the public `docker-mirrors.alauda.cn/dbeaver/cloudbeaver:latest` image may be unreachable from the cluster. Mirror it into the cluster's own registry first and reference that path in the Deployment, for example `skopeo copy docker://docker-mirrors.alauda.cn/dbeaver/cloudbeaver:latest docker://<cluster-registry>/dbeaver/cloudbeaver:latest`.

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

### 5. Connect to a PostgreSQL instance

1. Click **New Connection** and choose **PostgreSQL**.
2. Fill **Host** with the cluster Service name and **Port** `5432`. From inside the cluster the host is `<cluster>.<namespace>` (the read-write Service); the `<cluster>-repl` Service points at replicas. From outside the cluster, retrieve the NodePort or LoadBalancer address:

   ```bash
   kubectl -n <pg-namespace> get svc <cluster>
   ```

3. Enter the database user and password. The Operator stores each role's credentials in a Secret named `<role>.<cluster>.credentials.postgresql.acid.zalan.do`. Retrieve the `postgres` superuser password from its Secret:

   ```bash
   kubectl get secret postgres.<cluster>.credentials.postgresql.acid.zalan.do \
     -n <pg-namespace> -o jsonpath='{.data.password}' | base64 -d; echo
   ```

   The same Secret also carries `username`, `host` and `port` keys.

4. (Optional) Set **Database** to the target database; otherwise CloudBeaver connects to the default `postgres` database.
5. Under **Access Management**, grant the current CloudBeaver user permission to use the new connection.
6. Save and test the connection. SQL editors can now be opened from the browser and queries executed against the PostgreSQL cluster.

### 6. Uninstall

```bash
kubectl -n <namespace> delete -f cloudbeaver.yaml
```

The PVC is removed alongside the rest of the manifest. To preserve CloudBeaver state for a future redeploy, delete only the Deployment and Service and re-attach the existing PVC during the next install.

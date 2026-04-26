---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

Tekton `PipelineRun` workspaces and Jenkins shared `jnlp` agent workspaces both want a `ReadWriteMany` PersistentVolumeClaim so several Pods (or several Tasks within one Run) can stream artifacts and logs through the same backing volume. The simplest portable answer that does not require a CSI driver is the open-source `nfs-subdir-external-provisioner`. Pointed at any reachable NFS export, it dynamically carves a sub-directory per PVC and binds it as a PV.

This article covers preparing an NFS export, deploying the provisioner, registering a `StorageClass`, and consuming the resulting PVCs from Tekton and Jenkins.

## Resolution

### Step 1 — Prepare the NFS export

On the NFS server (any host with `nfs-utils` and a free filesystem path):

```bash
sudo mkdir -p /srv/nfs/k8s-shared
sudo chown nobody:nogroup /srv/nfs/k8s-shared
sudo chmod 0777 /srv/nfs/k8s-shared

cat <<'EOF' | sudo tee -a /etc/exports
/srv/nfs/k8s-shared 10.0.0.0/8(rw,sync,no_subtree_check,no_root_squash)
EOF

sudo exportfs -rav
sudo systemctl enable --now nfs-server
```

Verify the export from a worker node:

```bash
showmount -e <nfs-server-ip>
mount -t nfs <nfs-server-ip>:/srv/nfs/k8s-shared /mnt && umount /mnt
```

### Step 2 — Deploy the provisioner

Apply the upstream `nfs-subdir-external-provisioner` Deployment, RBAC, and parameter ConfigMap. The two values that must be customized are `NFS_SERVER` and `NFS_PATH`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nfs-subdir-external-provisioner
  namespace: nfs-provisioner
spec:
  replicas: 1
  selector:
    matchLabels:
      app: nfs-subdir-external-provisioner
  template:
    metadata:
      labels:
        app: nfs-subdir-external-provisioner
    spec:
      serviceAccountName: nfs-subdir-external-provisioner
      containers:
        - name: nfs-subdir-external-provisioner
          image: registry.k8s.io/sig-storage/nfs-subdir-external-provisioner:v4.0.18
          env:
            - name: PROVISIONER_NAME
              value: example.com/nfs-subdir
            - name: NFS_SERVER
              value: 10.10.10.10
            - name: NFS_PATH
              value: /srv/nfs/k8s-shared
          volumeMounts:
            - name: nfs-root
              mountPath: /persistentvolumes
      volumes:
        - name: nfs-root
          nfs:
            server: 10.10.10.10
            path: /srv/nfs/k8s-shared
```

The provisioner Deployment also needs a ServiceAccount, ClusterRole, and ClusterRoleBinding granting `get/list/watch/update` on `persistentvolumes`, `persistentvolumeclaims`, `storageclasses`, and `events`. The upstream chart and YAML manifests bundle these.

### Step 3 — Register a StorageClass

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-shared
provisioner: example.com/nfs-subdir
parameters:
  archiveOnDelete: "false"
  pathPattern: "${.PVC.namespace}/${.PVC.name}"
reclaimPolicy: Delete
volumeBindingMode: Immediate
```

### Step 4 — Consume from Tekton

Use the StorageClass as the source for a `volumeClaimTemplate` workspace. All Tasks in the PipelineRun share the same PVC:

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: build-and-push-
spec:
  pipelineRef:
    name: build-and-push
  workspaces:
    - name: source
      volumeClaimTemplate:
        spec:
          accessModes: [ReadWriteMany]
          storageClassName: nfs-shared
          resources:
            requests:
              storage: 5Gi
```

### Step 5 — Consume from Jenkins (Kubernetes plugin)

Mount the PVC into the `jnlp` agent template. The agent's workspace path becomes a per-Pod sub-directory under the shared NFS root:

```yaml
podTemplate(
  containers: [containerTemplate(name: 'jnlp', image: 'jenkins/inbound-agent:latest')],
  volumes: [persistentVolumeClaim(claimName: 'jenkins-shared-cache', mountPath: '/home/jenkins/agent/cache')]
) {
  node(POD_LABEL) {
    sh 'ls /home/jenkins/agent/cache'
  }
}
```

Pre-create the PVC once:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: jenkins-shared-cache
  namespace: jenkins
spec:
  accessModes: [ReadWriteMany]
  storageClassName: nfs-shared
  resources:
    requests:
      storage: 20Gi
```

## Diagnostic Steps

If a PVC stays in `Pending`:

- Confirm the provisioner Pod is `Running` and connected to the NFS server:

  ```bash
  kubectl -n nfs-provisioner get pods
  kubectl -n nfs-provisioner logs deploy/nfs-subdir-external-provisioner --tail=50
  ```

- Check that the StorageClass `provisioner` field exactly matches the `PROVISIONER_NAME` env var on the Deployment (the strings must match byte-for-byte, including case):

  ```bash
  kubectl get sc nfs-shared -o jsonpath='{.provisioner}'
  kubectl -n nfs-provisioner get deploy nfs-subdir-external-provisioner \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PROVISIONER_NAME")].value}'
  ```

- For PVCs created with `ReadWriteMany` that fail to mount on a worker node, install the NFS client packages on every node (`nfs-common` on Debian/Ubuntu; `nfs-utils` on CentOS/Rocky/AlmaLinux). The kubelet shells out to `mount.nfs`; missing the client binary surfaces as a mount error in the kubelet journal.

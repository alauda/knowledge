---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.3.x
---

# Mounting a cert-manager TLS Secret into a Pod on ACP

## Issue

On Alauda Container Platform running Kubernetes v1.34.5 with cert-manager controller image `registry.alauda.cn:60080/3rdparty/cert-manager-controller:v1.17.18-v4.3.1` (namespace `cert-manager`), a workload needs to serve TLS using a server certificate and private key that live in a `kubernetes.io/tls` Secret. The standard composition is a cert-manager `Certificate` whose `spec.secretName` names the destination Secret, and a Pod (or Deployment) that mounts that Secret as a read-only volume so the application reads `tls.crt` and `tls.key` from a known directory.

## Resolution

Declare a cert-manager `Certificate` and let its `spec.secretName` field designate the target Secret; the controller produces a Secret of type `kubernetes.io/tls` populated with the issued private key and signed certificate under the conventional `tls.crt` / `tls.key` keys. Existing Secrets on the cluster already follow this shape — for example, `acp-storage-operator-service-cert` in the `acp-storage-operator` namespace has type `kubernetes.io/tls` and exposes the two-key form that workloads expect.

Define an Issuer (or use an existing `ClusterIssuer`), then create the `Certificate` that points at it. The Secret comes into being once the request is signed, with the canonical TLS layout:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: app-server-tls
  namespace: my-app
spec:
  secretName: app-server-tls
  duration: 2160h
  renewBefore: 360h
  commonName: app.my-app.svc
  dnsNames:
    - app.my-app.svc
    - app.my-app.svc.cluster.local
  issuerRef:
    name: my-issuer
    kind: Issuer
    group: cert-manager.io
```

Mount the resulting Secret read-only into the workload by declaring a `secret` volume that references `secretName` and a `volumeMount` that places the keys at a predictable directory inside the container. The application then reads `tls.crt` and `tls.key` from that mount path and serves TLS directly:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-server
  namespace: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: app-server
  template:
    metadata:
      labels:
        app: app-server
    spec:
      containers:
        - name: app-server
          image: <your-app-image>
          ports:
            - containerPort: 8443
          volumeMounts:
            - name: tls
              mountPath: /etc/tls
              readOnly: true
      volumes:
        - name: tls
          secret:
            secretName: app-server-tls
```

The application is then configured to load its server certificate from `/etc/tls/tls.crt` and its private key from `/etc/tls/tls.key`. When cert-manager rotates the certificate it rewrites the same Secret, and the kubelet refreshes the projected files in the mount path without restarting the Pod — but only the on-disk files are updated automatically. Whether the running process actually serves the new certificate depends on the application: a process that watches the files and hot-reloads (or re-reads them per connection) picks up the rotation on its own, while a process that reads `tls.crt` / `tls.key` once at startup keeps using the old certificate in memory until it is restarted. For applications without hot-reload, plan to restart or roll the workload after each rotation. Two further caveats: the kubelet refresh is not instantaneous — projected Secret volumes update on the kubelet sync interval plus cache propagation delay, so expect up to roughly a minute of lag between the Secret changing and the files updating — and a Secret mounted via `subPath` does **not** receive updates at all, so mount the whole volume (as shown above) rather than a `subPath` if you rely on in-place rotation.

## Diagnostic Steps

Confirm the destination Secret was produced with the expected `kubernetes.io/tls` type and the two standard keys. The Secret name must match `Certificate.spec.secretName`; its `type` column must read `kubernetes.io/tls`, and the data section must list `tls.crt` and `tls.key`:

```bash
kubectl -n my-app get secret app-server-tls
kubectl -n my-app get secret app-server-tls -o jsonpath='{.type}'
kubectl -n my-app get secret app-server-tls -o jsonpath='{.data}' | tr ',' '\n'
```

If the Secret is absent, inspect the `Certificate` object — the controller records progress on its `status.conditions[]`, and the Secret is created only after the request is signed:

```bash
kubectl -n my-app get certificate app-server-tls
kubectl -n my-app describe certificate app-server-tls
```

Once the Pod is running, verify the keys are projected into the expected directory and that the file mode is readable by the container's user:

```bash
kubectl -n my-app exec deploy/app-server -- ls -l /etc/tls
```

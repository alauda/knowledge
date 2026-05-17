---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Deploying a CPU-only vLLM inference workload on ACP

## Issue

A CPU-only vLLM container can be brought up on Alauda Container Platform using
only generic Kubernetes primitives. The workload is a user-built `vllm` image
fronted by a `Deployment`, a `PersistentVolumeClaim` mounted at the model cache
directory inside the container, a `Service` exposing the inference port, and
external access via an `Ingress`; no vLLM-specific operator or custom resource
is required on the cluster. This pattern is useful for experimentation
and benchmarking on clusters that lack accelerator hardware, and is explicitly
positioned as non-production: CPU inference is experimental, and the supported
production path on ACP uses GPU-accelerated serving via the Alauda AI suite
rather than a hand-rolled `Deployment`.

## Root Cause

Model files are downloaded by vLLM at runtime from an upstream model registry,
which makes the model cache directory inside the container the dominant cost
on pod restart. Without a persistent volume mounted at that path, the model is
re-downloaded every time the pod restarts, which is slow and wastes bandwidth.
The standard mitigation is to back the cache directory with a
`PersistentVolumeClaim` so that downloaded artifacts survive pod restarts.

## Resolution

Run the vLLM image as a regular `Deployment` in any namespace, mount a PVC at
the cache directory, expose port `8001` with a `Service`, and front the
`Service` with a standard `networking.k8s.io/v1` `Ingress` for external access. The default in-cluster ingress controller on ACP is ALB; the same
manifest shape works against any conformant Ingress controller.

Provision the PVC from a `StorageClass` that suits the cluster's storage
posture. On ACP, node-local persistent storage is provided by the
`local-storage-operator` package (catalog channel `stable`, currentCSV
`local-storage-operator.v4.3.1`); LVM-backed local volumes are typically
fronted by a TopoLVM-provisioned default `StorageClass`, and for
shared-access scenarios any default `StorageClass` is acceptable.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vllm-cache
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi
```

Inject the model-registry access token into the container by referencing a
`Secret` through an environment variable named `HUGGING_FACE_HUB_TOKEN`. The
binding uses the standard `valueFrom.secretKeyRef` form; no platform-specific
shape is involved.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: hf-token
type: Opaque
stringData:
  token: <model-registry-access-token>
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-cpu
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vllm-cpu
  template:
    metadata:
      labels:
        app: vllm-cpu
    spec:
      containers:
      - name: vllm
        image: <registry>/vllm-cpu:<tag>
        ports:
        - containerPort: 8001
        env:
        - name: HUGGING_FACE_HUB_TOKEN
          valueFrom:
            secretKeyRef:
              name: hf-token
              key: token
        volumeMounts:
        - name: cache
          mountPath: /root/.cache/huggingface
      volumes:
      - name: cache
        persistentVolumeClaim:
          claimName: vllm-cache
---
apiVersion: v1
kind: Service
metadata:
  name: vllm-cpu
spec:
  selector:
    app: vllm-cpu
  ports:
  - port: 8001
    targetPort: 8001
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: vllm-cpu
spec:
  rules:
  - host: <external-host>
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: vllm-cpu
            port:
              number: 8001
```

If the pod requires elevated capabilities, label the namespace to relax Pod
Security Admission enforcement where needed:

```bash
kubectl label ns <namespace> \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/warn=privileged \
  pod-security.kubernetes.io/audit=privileged \
  --overwrite
```

For a supported production deployment of vLLM on ACP, install the
`aml-operator` package (catalog channel `alpha`, currentCSV
`aml-operator.v1.4.0`, install mode `AllNamespaces`) which provisions the
Alauda AI suite — including `KServe` and an `InferenceService` /
`ServingRuntime` API on top of `kserveless-operator` — and serves vLLM
through a managed `InferenceService` resource rather than a hand-written
`Deployment`.

## Diagnostic Steps

Confirm the pod is admitted and running, and that the cache volume is mounted
at the expected path so that re-downloads do not occur across restarts:

```bash
kubectl get pod -l app=vllm-cpu
kubectl describe pod -l app=vllm-cpu
kubectl get pvc vllm-cache
```

Confirm the access token is reaching the container via the expected env-var
shape (the value itself is sensitive — only check that the variable is
present):

```bash
kubectl exec deploy/vllm-cpu -- printenv | grep -c '^HUGGING_FACE_HUB_TOKEN='
```

Confirm external reachability through the configured `Ingress` host or
NodePort:

```bash
kubectl get ingress vllm-cpu
kubectl get svc vllm-cpu
```

If a production-grade managed path is required instead of this experimental
CPU shape, inspect the Alauda AI install and the available `ServingRuntime`
entries on the cluster:

```bash
kubectl get packagemanifest aml-operator -n cpaas-system \
  -o jsonpath='{.status.channels[?(@.name=="alpha")].currentCSV}'
kubectl get servingruntime -A
kubectl get clusterservingruntime
```

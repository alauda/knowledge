---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

vLLM is the de facto open-source inference engine for large language models, valued for its high throughput, low latency, and paged-attention memory layout. It is engineered around GPU acceleration, but the project upstream also publishes a CPU build that lets a developer prototype an OpenAI-compatible model endpoint without dedicated accelerator hardware. CPU mode is **not** a production target — token throughput is one to two orders of magnitude below a GPU run — but it is enough to wire up an end-to-end serving topology, exercise client tooling, and benchmark relative behaviour before committing to GPU-backed nodes.

This note records a reproducible recipe for running vLLM on CPU worker nodes through standard Kubernetes primitives only: a Deployment, a PersistentVolumeClaim for the Hugging Face model cache, a Secret carrying the model-hub access token, a Service for in-cluster reachability, and an Ingress for external curl access. Production AI workloads on the platform should use the dedicated AI surface (KServe-based serving, GPU device plugins, the `hardware_accelerator` operators) — this article is intentionally narrow and intended for early evaluation work.

## Resolution

### Build a CPU-targeted vLLM image

Upstream now publishes pre-built CPU images via `vllm-project/vllm` releases; pull one of those if it matches the target architecture. To build locally from source, clone the repository and use the CPU Dockerfile:

```bash
git clone https://github.com/vllm-project/vllm
cd vllm
docker buildx build \
  --platform linux/amd64 \
  -t registry.example.com/lab/vllm-cpu:latest \
  -f docker/Dockerfile.cpu .
docker push registry.example.com/lab/vllm-cpu:latest
```

Push the image to whichever registry the cluster pulls from. If the target namespace requires a pull secret, attach it to the workload's ServiceAccount with `imagePullSecrets`.

### Provide persistent storage for the Hugging Face cache

vLLM downloads the model weights on first start. Without persistent storage, every pod restart re-downloads several gigabytes; with a PVC mapped to `~/.cache/huggingface`, the cache survives restarts. Any RWO storage class works for a single replica:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vllm-hf-cache
  namespace: ai-lab
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi
```

For node-local backing, an LVM-style local-storage CSI (the `Alauda Build of Local Storage` or `Alauda Build of TopoLVM` operator) gives the lowest-latency path — pin the PVC to a chosen worker via the relevant `volumeBindingMode: WaitForFirstConsumer` storage class.

### Provide the Hugging Face access token

Most Hugging Face models require accepting a license and authenticating via a personal access token. Hold the token in a Secret rather than in the Deployment spec:

```bash
kubectl -n ai-lab create secret generic hf-token \
  --from-literal=HUGGING_FACE_HUB_TOKEN=hf_xxx_redacted_xxx
```

### Deploy vLLM

The Deployment runs a single replica that mounts the PVC, sources the token from the Secret, and exposes the OpenAI-compatible HTTP API on port `8001`. CPU-only inference is memory-bound, so request enough RAM to hold the model weights plus the KV cache; for `Llama-3.2-1B-Instruct` allocate at least 8 GiB. Pin the pod to CPU worker nodes with a node selector if the cluster has heterogeneous capacity.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-cpu
  namespace: ai-lab
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
          image: registry.example.com/lab/vllm-cpu:latest
          args:
            - serve
            - meta-llama/Llama-3.2-1B-Instruct
            - --port=8001
          ports:
            - containerPort: 8001
              name: http
          envFrom:
            - secretRef:
                name: hf-token
          resources:
            requests:
              cpu: "4"
              memory: 8Gi
            limits:
              cpu: "8"
              memory: 16Gi
          volumeMounts:
            - name: hf-cache
              mountPath: /root/.cache/huggingface
      volumes:
        - name: hf-cache
          persistentVolumeClaim:
            claimName: vllm-hf-cache
```

### Expose the endpoint

Inside the cluster, a ClusterIP Service is enough:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: vllm-cpu
  namespace: ai-lab
spec:
  selector:
    app: vllm-cpu
  ports:
    - name: http
      port: 80
      targetPort: 8001
```

For external reachability, use a standard Ingress (or the platform's ALB Operator if a richer L7 surface is needed). The OpenAI-compatible API does not require sticky sessions, so the default round-robin behaviour is fine:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: vllm-cpu
  namespace: ai-lab
spec:
  rules:
    - host: vllm.lab.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: vllm-cpu
                port:
                  number: 80
```

A standard Pod Security Standard `restricted` namespace is enough for the CPU build — there is no privileged-container requirement. If the target namespace enforces `baseline` or `restricted`, run vLLM as a non-root user inside the image; the default upstream Dockerfile already does this.

### Sanity-check the endpoint

Once the Deployment is `Available` and the model has finished downloading (watch `kubectl logs` for the `Application startup complete` line), drive a chat request through the Ingress:

```bash
curl -X POST http://vllm.lab.example.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-llama/Llama-3.2-1B-Instruct",
    "messages": [
      {"role": "user", "content": "Hello! What is the capital of Massachusetts?"}
    ]
  }'
```

A successful response carries a `choices[0].message.content` field with a model-generated answer.

### Benchmark the deployment

For a relative read of throughput and latency, drive the endpoint with `guidellm`, the open-source benchmarking tool from the vLLM team:

```bash
pip install guidellm
export HF_TOKEN=hf_xxx_redacted_xxx
guidellm benchmark \
  --target http://vllm.lab.example.com/v1 \
  --model meta-llama/Llama-3.2-1B-Instruct \
  --data "prompt_tokens=512,output_tokens=128" \
  --rate-type sweep \
  --max-seconds 240
```

The sweep mode starts at one in-flight request and ramps to saturation, which exposes the server's behaviour under load. The standard reported indicators are:

- **Requests per second (RPS)** — completed inference requests per second; whole-system throughput.
- **Time to first token (TTFT)** — wall time from request arrival to the first emitted token; chat-latency proxy.
- **Inter-token latency (ITL)** — time between successive tokens; streaming-quality proxy.
- **End-to-end latency** — total request duration; relevant for batch and offline calls.

CPU-only numbers will sit far below GPU baselines — that is expected. Use the run as a control to validate the full pipeline (image, PVC, token plumbing, Service, Ingress) before re-running the same plan against GPU-backed nodes through the platform's KServe-based AI surface.

## Diagnostic Steps

If the pod loops in `CrashLoopBackOff`, the most common causes are out-of-memory (model weights exceed the container limit), Hugging Face authentication failure, or registry pull errors:

```bash
kubectl -n ai-lab describe pod -l app=vllm-cpu
kubectl -n ai-lab logs deploy/vllm-cpu --tail=200
```

Check the previous container instance for OOM evidence (`OOMKilled` reason in the pod status). Raise the memory request and limit in steps of 4 GiB until the pod stabilises.

If model download stalls, confirm the Secret was wired in correctly:

```bash
kubectl -n ai-lab exec deploy/vllm-cpu -- env | grep HUGGING_FACE
```

A missing or blank token causes `huggingface_hub` to fall back to anonymous access and download fails for gated models such as the Llama family.

If the curl call returns 404 or times out, walk the chain bottom-up:

```bash
kubectl -n ai-lab port-forward svc/vllm-cpu 8001:80
curl -s http://127.0.0.1:8001/v1/models
```

A successful local response confirms the Service and pod are healthy; a failed external curl after that points at the Ingress controller, DNS, or ingress class configuration.

To verify the cache PVC is doing its job, compare startup time of a fresh pod against a restarted pod — the second start should skip the multi-gigabyte download:

```bash
kubectl -n ai-lab logs deploy/vllm-cpu --tail=20 | grep -E '(Loading model|Downloading|Application startup)'
```

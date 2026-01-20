---
products:
   - Secure Accelerator Access Conformance Test
kind:
   - Article
---
# Secure Accelerator Access Conformance Test

## Requirement

**MUST**: Ensure that access to accelerators from within containers is properly isolated and mediated by the Kubernetes resource management framework (device plugin or DRA) and container runtime, preventing unauthorized access or interference between workloads.

## Prerequisites

Before running the test, ensure you have:
- A Kubernetes cluster with at least **one GPU node containing 2 or more physical GPUs**
- Alauda Build of NVIDIA GPU Device Plugin installed (see Step 2 below)
- `kubectl` configured to access the cluster
- Appropriate permissions to create namespaces and pods

## Setup

### Step 1: Create an Alauda Container Platform Kubernetes Cluster with GPU Nodes

### Step 2: Install Alauda Build of NVIDIA GPU Device Plugin

[Alauda Build of NVIDIA GPU Device Plugin installation guide](https://docs.alauda.io/pgpu/0.17/install/install.html)

### Step 3: Label GPU Nodes

Label all your GPU nodes to enable device plugin scheduling:

```bash
kubectl label nodes <gpu-node> nvidia-device-enable=pgpu
```

### Step 4: Verify GPU Capacity

Verify that at least one GPU node has 2 or more GPUs:

```bash
# Find nodes with 2 or more GPUs
kubectl get nodes -l nvidia-device-enable=pgpu -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.capacity.nvidia\.com/gpu}{"\n"}{end}' | \
  awk '$2 >= 2 {print $1 " has " $2 " GPUs"}'
```

## Tests Executed

### Test 1: "Cannot access devices if a pod doesn't request them"

**What it does**: Creates a pod that does NOT request any GPU devices and checks that the pod cannot access any GPUs.

**Why it matters**: This is a security test. If a pod doesn't ask for a GPU, it shouldn't be able to access one. The test verifies this by checking for GPU device files (`/dev/nvidia*`) and running `nvidia-smi` inside the pod, expecting it to fail (command not found), proving the pod has no access to GPUs.

### Test 2: "Must map devices to the right pods"

**What it does**: Creates TWO pods, each requesting 1 GPU, on the same node (which has at least 2 GPUs). Then it runs `nvidia-smi -L` in both pods to list which GPU each pod can see.

**Why it matters**: This verifies isolation between pods. Each pod should see a different GPU - pod A shouldn't be able to see or access the GPU assigned to pod B. The test confirms this by checking that the GPU UUIDs from `nvidia-smi -L` are different in each pod, proving they have different GPUs assigned to them.

## Test Script

```bash
#!/bin/bash
set -e

# ================= CONFIG =================
NAMESPACE="secure-accelerator-access"
CUDA_IMAGE="${CUDA_IMAGE:-nvidia/cuda:12.1.1-base-ubuntu22.04}"

echo "=== Secure Accelerator Access Conformance Test ==="
echo ""
echo "Configuration:"
echo "  Namespace: $NAMESPACE"
echo "  CUDA Image: $CUDA_IMAGE"
echo ""

# ================ PRE-FLIGHT ================
echo "=== Pre-flight Checks ==="

if ! command -v kubectl &> /dev/null; then
    echo "❌ ERROR: kubectl not found."
    exit 1
fi
echo "✓ kubectl is available"

echo "Searching for GPU nodes with 2+ GPUs..."

GPU_NODES_INFO=$(kubectl get nodes -l nvidia-device-enable=pgpu \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.capacity.nvidia\.com/gpu}{"\n"}{end}')

if [ -z "$GPU_NODES_INFO" ]; then
    echo "❌ ERROR: No GPU node found."
    echo "Label GPU nodes with:"
    echo "  kubectl label node <node> nvidia-device-enable=pgpu"
    exit 1
fi

GPU_NODE=$(echo "$GPU_NODES_INFO" | awk '$2 >= 2 {print $1; exit}')
GPU_CAPACITY=$(echo "$GPU_NODES_INFO" | awk '$2 >= 2 {print $2; exit}')

if [ -z "$GPU_NODE" ]; then
    echo "❌ ERROR: No GPU node with 2+ GPUs found."
    echo "Current GPU nodes:"
    echo "$GPU_NODES_INFO"
    exit 1
fi

echo "✓ Selected GPU node: $GPU_NODE with $GPU_CAPACITY GPUs"

ELIGIBLE_COUNT=$(echo "$GPU_NODES_INFO" | awk '$2 >= 2 {count++} END {print count+0}')
if [ "$ELIGIBLE_COUNT" -gt 1 ]; then
    echo "  Note: Found $ELIGIBLE_COUNT eligible GPU nodes, using: $GPU_NODE"
fi

echo ""
echo "=== Starting Tests ==="
echo ""

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

cleanup() {
    echo ""
    echo "Cleaning up namespace..."
    kubectl delete namespace "$NAMESPACE" --ignore-not-found=true
}
trap cleanup EXIT

# ==================== TEST 1 ====================
echo ""
echo "=== TEST 1: Access Denial (No GPU request) ==="

cat <<EOF | kubectl apply -n "$NAMESPACE" -f -
apiVersion: v1
kind: Pod
metadata:
  name: no-gpu-pod
spec:
  restartPolicy: Never
  nodeName: ${GPU_NODE}
  containers:
  - name: test-container
    image: ${CUDA_IMAGE}
    command: ["/bin/bash", "-c"]
    args:
      - |
        echo "Checking for GPU device files in /dev..."
        ls -la /dev/nvidia* 2>/dev/null || echo "No nvidia devices found"
        echo ""
        echo "Running nvidia-smi..."
        if nvidia-smi --query-gpu=uuid --format=csv,noheader; then
            echo "ERROR: nvidia-smi succeeded - pod has GPU access!"
            exit 1
        else
            echo "SUCCESS: nvidia-smi failed (exit code $?) - GPU access properly denied"
            exit 0
        fi
EOF

echo "Waiting for pod completion..."
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded \
  -n "$NAMESPACE" pod/no-gpu-pod --timeout=300s || true

TEST1_PHASE=$(kubectl get pod -n "$NAMESPACE" no-gpu-pod \
  -o jsonpath='{.status.phase}')
if [ "$TEST1_PHASE" != "Succeeded" ]; then
    echo "❌ TEST 1 FAILED (phase: $TEST1_PHASE)"
    kubectl logs -n "$NAMESPACE" no-gpu-pod
    TEST1_EXIT_CODE=1
else
    TEST1_EXIT_CODE=$(kubectl get pod -n "$NAMESPACE" no-gpu-pod \
      -o jsonpath='{.status.containerStatuses[0].state.terminated.exitCode}')
fi

if [ "$TEST1_EXIT_CODE" -eq 0 ]; then
    echo "✅ TEST 1 PASSED"
else
    echo "❌ TEST 1 FAILED"
    kubectl logs -n "$NAMESPACE" no-gpu-pod
fi

kubectl delete pod -n "$NAMESPACE" no-gpu-pod --ignore-not-found=true

# ==================== TEST 2 ====================
echo ""
echo "=== TEST 2: GPU Isolation Between Pods ==="

GPU_CAPACITY=$(kubectl get node "$GPU_NODE" \
  -o jsonpath='{.status.capacity.nvidia\.com/gpu}')
echo "Node GPU capacity: $GPU_CAPACITY"

cat <<EOF | kubectl apply -n "$NAMESPACE" -f -
apiVersion: v1
kind: Pod
metadata:
  name: gpu-test-pod-1
spec:
  restartPolicy: Never
  nodeName: ${GPU_NODE}
  containers:
  - name: cuda-container
    image: ${CUDA_IMAGE}
    resources:
      requests:
        nvidia.com/gpu: 1
      limits:
        nvidia.com/gpu: 1
    command: ["/bin/bash", "-c"]
    args:
      - |
        echo "Pod 1: Checking GPU devices..."
        nvidia-smi -L
        echo ""
        echo "Pod 1: GPU UUID:"
        nvidia-smi --query-gpu=uuid --format=csv,noheader
        echo ""
        echo "Pod 1: Number of GPUs visible:"
        nvidia-smi -L | wc -l
        exit 0
EOF

cat <<EOF | kubectl apply -n "$NAMESPACE" -f -
apiVersion: v1
kind: Pod
metadata:
  name: gpu-test-pod-2
spec:
  restartPolicy: Never
  nodeName: ${GPU_NODE}
  containers:
  - name: cuda-container
    image: ${CUDA_IMAGE}
    resources:
      requests:
        nvidia.com/gpu: 1
      limits:
        nvidia.com/gpu: 1
    command: ["/bin/bash", "-c"]
    args:
      - |
        echo "Pod 2: Checking GPU devices..."
        nvidia-smi -L
        echo ""
        echo "Pod 2: GPU UUID:"
        nvidia-smi --query-gpu=uuid --format=csv,noheader
        echo ""
        echo "Pod 2: Number of GPUs visible:"
        nvidia-smi -L | wc -l
        exit 0
EOF

echo "Waiting for pods to finish..."
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded \
  -n "$NAMESPACE" pod/gpu-test-pod-1 --timeout=300s
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded \
  -n "$NAMESPACE" pod/gpu-test-pod-2 --timeout=300s

POD1_UUID=$(kubectl logs -n "$NAMESPACE" gpu-test-pod-1 \
  | grep -A1 "Pod 1: GPU UUID:" | tail -n 1 | tr -d ' ')

POD2_UUID=$(kubectl logs -n "$NAMESPACE" gpu-test-pod-2 \
  | grep -A1 "Pod 2: GPU UUID:" | tail -n 1 | tr -d ' ')

POD1_GPU_COUNT=$(kubectl logs -n "$NAMESPACE" gpu-test-pod-1 \
  | grep -A1 "Pod 1: Number of GPUs visible:" | tail -n 1 | tr -d ' ')

POD2_GPU_COUNT=$(kubectl logs -n "$NAMESPACE" gpu-test-pod-2 \
  | grep -A1 "Pod 2: Number of GPUs visible:" | tail -n 1 | tr -d ' ')

echo "Pod 1 GPU UUID: $POD1_UUID"
echo "Pod 2 GPU UUID: $POD2_UUID"
echo "Pod 1 GPUs visible: $POD1_GPU_COUNT"
echo "Pod 2 GPUs visible: $POD2_GPU_COUNT"

TEST2_PASSED=true

if [ "$POD1_GPU_COUNT" != "1" ]; then
    echo "❌ Pod 1 can see $POD1_GPU_COUNT GPUs (expected 1)"
    TEST2_PASSED=false
fi

if [ "$POD2_GPU_COUNT" != "1" ]; then
    echo "❌ Pod 2 can see $POD2_GPU_COUNT GPUs (expected 1)"
    TEST2_PASSED=false
fi

if [ "$GPU_CAPACITY" -ge 2 ]; then
    if [ "$POD1_UUID" == "$POD2_UUID" ]; then
        echo "❌ Both pods have SAME GPU UUID - isolation failed!"
        TEST2_PASSED=false
    else
        echo "✅ Pods have DIFFERENT GPU UUIDs - isolation confirmed"
    fi
else
    echo "⚠️ Single GPU node - only validated per-pod visibility = 1"
fi

if $TEST2_PASSED; then
    echo "✅ TEST 2 PASSED"
else
    echo "❌ TEST 2 FAILED"
fi

kubectl delete pod -n "$NAMESPACE" gpu-test-pod-1 gpu-test-pod-2 --ignore-not-found=true

# ================= SUMMARY =================
echo ""
echo "=== CONFORMANCE SUMMARY ==="

if [ "$TEST1_EXIT_CODE" -eq 0 ] && $TEST2_PASSED; then
    echo "✅ Platform MEETS secure accelerator access requirement"
    echo "Conformance: PASS"
    exit 0
else
    echo "❌ Platform does NOT meet requirement"
    echo "Conformance: FAIL"
    exit 1
fi
```
Save the above script as `test_secure_accelerator_access.sh`.

## Test Output

### Run test script

**Note**: For air-gapped environments, ensure the CUDA image is already pushed to your private registry and accessible to the cluster.

```bash
CUDA_IMAGE=nvidia/cuda:12.4.1-base-ubuntu20.04 ./test_secure_accelerator_access.sh
```


## Result

✅ **PASS** - GPU access properly isolated and mediated by Kubernetes device plugin and container runtime.

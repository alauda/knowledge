---
products:
  - Alauda AI
kind:
  - Article
id: KB260100016
sourceSHA: 35c45a34dd828eb85d6a422e1c5b3fd82236076c2c03189ee545ba2492b786b5
---

# 安全加速器访问一致性测试

## 需求

**必须**：确保从容器内部对加速器的访问得到适当的隔离，并由Kubernetes资源管理框架（设备插件或DRA）和容器运行时进行调解，防止未经授权的访问或工作负载之间的干扰。

## 前提条件

在运行测试之前，请确保您具备：

- 一个Kubernetes集群，至少包含**一个包含2个或更多物理GPU的GPU节点**
- 安装了Alauda构建的NVIDIA GPU设备插件（请参见下面的步骤2）
- 配置了`kubectl`以访问集群
- 具有创建命名空间和Pod的适当权限

## 设置

### 步骤1：创建一个带有GPU节点的Alauda容器平台Kubernetes集群

### 步骤2：安装Alauda构建的NVIDIA GPU设备插件

[Alauda构建的NVIDIA GPU设备插件安装指南](https://docs.alauda.io/pgpu/0.17/install/install.html)

### 步骤3：标记GPU节点

标记所有GPU节点以启用设备插件调度：

```bash
kubectl label nodes <gpu-node> nvidia-device-enable=pgpu
```

### 步骤4：验证GPU容量

验证至少有一个GPU节点具有2个或更多GPU：

```bash
# 查找具有2个或更多GPU的节点
kubectl get nodes -l nvidia-device-enable=pgpu -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.capacity.nvidia\.com/gpu}{"\n"}{end}' | \
  awk '$2 >= 2 {print $1 " has " $2 " GPUs"}'
```

## 执行的测试

### 测试1：“如果Pod不请求设备，则无法访问设备”

**功能**：创建一个不请求任何GPU设备的Pod，并检查该Pod无法访问任何GPU。

**重要性**：这是一个安全测试。如果Pod没有请求GPU，则不应能够访问GPU。该测试通过检查GPU设备文件（`/dev/nvidia*`）并在Pod内部运行`nvidia-smi`来验证这一点，期望其失败（命令未找到），证明Pod没有访问GPU的权限。

### 测试2：“必须将设备映射到正确的Pod”

**功能**：在同一节点上创建两个请求1个GPU的Pod（该节点至少有2个GPU）。然后在两个Pod中运行`nvidia-smi -L`以列出每个Pod可以看到的GPU。

**重要性**：这验证了Pod之间的隔离。每个Pod应该看到不同的GPU - Pod A不应能够看到或访问分配给Pod B的GPU。该测试通过检查每个Pod中`nvidia-smi -L`的GPU UUID是否不同来确认这一点，证明它们被分配了不同的GPU。

## 测试脚本

```bash
#!/bin/bash
set -e

# ================= CONFIG =================
NAMESPACE="secure-accelerator-access"
CUDA_IMAGE="${CUDA_IMAGE:-nvidia/cuda:12.1.1-base-ubuntu22.04}"

echo "=== 安全加速器访问一致性测试 ==="
echo ""
echo "配置："
echo "  命名空间: $NAMESPACE"
echo "  CUDA镜像: $CUDA_IMAGE"
echo ""

# ================ 预检查 ================
echo "=== 预检查 ==="

if ! command -v kubectl &> /dev/null; then
    echo "❌ 错误：未找到kubectl。"
    exit 1
fi
echo "✓ kubectl可用"

echo "正在搜索具有2个以上GPU的GPU节点..."

GPU_NODES_INFO=$(kubectl get nodes -l nvidia-device-enable=pgpu \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.capacity.nvidia\.com/gpu}{"\n"}{end}')

if [ -z "$GPU_NODES_INFO" ]; then
    echo "❌ 错误：未找到GPU节点。"
    echo "请使用以下命令标记GPU节点："
    echo "  kubectl label node <node> nvidia-device-enable=pgpu"
    exit 1
fi

GPU_NODE=$(echo "$GPU_NODES_INFO" | awk '$2 >= 2 {print $1; exit}')
GPU_CAPACITY=$(echo "$GPU_NODES_INFO" | awk '$2 >= 2 {print $2; exit}')

if [ -z "$GPU_NODE" ]; then
    echo "❌ 错误：未找到具有2个以上GPU的GPU节点。"
    echo "当前GPU节点："
    echo "$GPU_NODES_INFO"
    exit 1
fi

echo "✓ 选择的GPU节点：$GPU_NODE，具有$GPU_CAPACITY个GPU"

ELIGIBLE_COUNT=$(echo "$GPU_NODES_INFO" | awk '$2 >= 2 {count++} END {print count+0}')
if [ "$ELIGIBLE_COUNT" -gt 1 ]; then
    echo "  注意：找到$ELIGIBLE_COUNT个合格的GPU节点，使用：$GPU_NODE"
fi

echo ""
echo "=== 开始测试 ==="
echo ""

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

cleanup() {
    echo ""
    echo "清理命名空间..."
    kubectl delete namespace "$NAMESPACE" --ignore-not-found=true
}
trap cleanup EXIT

# ==================== 测试1 ====================
echo ""
echo "=== 测试1：访问拒绝（未请求GPU） ==="

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
        echo "检查/dev中的GPU设备文件..."
        ls -la /dev/nvidia* 2>/dev/null || echo "未找到nvidia设备"
        echo ""
        echo "运行nvidia-smi..."
        if nvidia-smi --query-gpu=uuid --format=csv,noheader; then
            echo "错误：nvidia-smi成功 - Pod具有GPU访问权限！"
            exit 1
        else
            echo "成功：nvidia-smi失败（退出代码 $?) - GPU访问已正确拒绝"
            exit 0
        fi
EOF

echo "等待Pod完成..."
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded \
  -n "$NAMESPACE" pod/no-gpu-pod --timeout=300s || true

TEST1_PHASE=$(kubectl get pod -n "$NAMESPACE" no-gpu-pod \
  -o jsonpath='{.status.phase}')
if [ "$TEST1_PHASE" != "Succeeded" ]; then
    echo "❌ 测试1失败（阶段：$TEST1_PHASE）"
    kubectl logs -n "$NAMESPACE" no-gpu-pod
    TEST1_EXIT_CODE=1
else
    TEST1_EXIT_CODE=$(kubectl get pod -n "$NAMESPACE" no-gpu-pod \
      -o jsonpath='{.status.containerStatuses[0].state.terminated.exitCode}')
fi

if [ "$TEST1_EXIT_CODE" -eq 0 ]; then
    echo "✅ 测试1通过"
else
    echo "❌ 测试1失败"
    kubectl logs -n "$NAMESPACE" no-gpu-pod
fi

kubectl delete pod -n "$NAMESPACE" no-gpu-pod --ignore-not-found=true

# ==================== 测试2 ====================
echo ""
echo "=== 测试2：Pod之间的GPU隔离 ==="

GPU_CAPACITY=$(kubectl get node "$GPU_NODE" \
  -o jsonpath='{.status.capacity.nvidia\.com/gpu}')
echo "节点GPU容量：$GPU_CAPACITY"

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
        echo "Pod 1：检查GPU设备..."
        nvidia-smi -L
        echo ""
        echo "Pod 1：GPU UUID："
        nvidia-smi --query-gpu=uuid --format=csv,noheader
        echo ""
        echo "Pod 1：可见的GPU数量："
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
        echo "Pod 2：检查GPU设备..."
        nvidia-smi -L
        echo ""
        echo "Pod 2：GPU UUID："
        nvidia-smi --query-gpu=uuid --format=csv,noheader
        echo ""
        echo "Pod 2：可见的GPU数量："
        nvidia-smi -L | wc -l
        exit 0
EOF

echo "等待Pods完成..."
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded \
  -n "$NAMESPACE" pod/gpu-test-pod-1 --timeout=300s
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded \
  -n "$NAMESPACE" pod/gpu-test-pod-2 --timeout=300s

POD1_UUID=$(kubectl logs -n "$NAMESPACE" gpu-test-pod-1 \
  | grep -A1 "Pod 1：GPU UUID：" | tail -n 1 | tr -d ' ')

POD2_UUID=$(kubectl logs -n "$NAMESPACE" gpu-test-pod-2 \
  | grep -A1 "Pod 2：GPU UUID：" | tail -n 1 | tr -d ' ')

POD1_GPU_COUNT=$(kubectl logs -n "$NAMESPACE" gpu-test-pod-1 \
  | grep -A1 "Pod 1：可见的GPU数量：" | tail -n 1 | tr -d ' ')

POD2_GPU_COUNT=$(kubectl logs -n "$NAMESPACE" gpu-test-pod-2 \
  | grep -A1 "Pod 2：可见的GPU数量：" | tail -n 1 | tr -d ' ')

echo "Pod 1 GPU UUID: $POD1_UUID"
echo "Pod 2 GPU UUID: $POD2_UUID"
echo "Pod 1 可见的GPU数量: $POD1_GPU_COUNT"
echo "Pod 2 可见的GPU数量: $POD2_GPU_COUNT"

TEST2_PASSED=true

if [ "$POD1_GPU_COUNT" != "1" ]; then
    echo "❌ Pod 1可以看到$POD1_GPU_COUNT个GPU（预期1个）"
    TEST2_PASSED=false
fi

if [ "$POD2_GPU_COUNT" != "1" ]; then
    echo "❌ Pod 2可以看到$POD2_GPU_COUNT个GPU（预期1个）"
    TEST2_PASSED=false
fi

if [ "$GPU_CAPACITY" -ge 2 ]; then
    if [ "$POD1_UUID" == "$POD2_UUID" ]; then
        echo "❌ 两个Pod具有相同的GPU UUID - 隔离失败！"
        TEST2_PASSED=false
    else
        echo "✅ Pods具有不同的GPU UUID - 隔离确认"
    fi
else
    echo "⚠️ 单GPU节点 - 仅验证每个Pod的可见性=1"
fi

if $TEST2_PASSED; then
    echo "✅ 测试2通过"
else
    echo "❌ 测试2失败"
fi

kubectl delete pod -n "$NAMESPACE" gpu-test-pod-1 gpu-test-pod-2 --ignore-not-found=true

# ================= 总结 =================
echo ""
echo "=== 一致性总结 ==="

if [ "$TEST1_EXIT_CODE" -eq 0 ] && $TEST2_PASSED; then
    echo "✅ 平台满足安全加速器访问要求"
    echo "一致性：通过"
    exit 0
else
    echo "❌ 平台不满足要求"
    echo "一致性：未通过"
    exit 1
fi
```

将上述脚本保存为`test_secure_accelerator_access.sh`。

## 测试输出

### 运行测试脚本

**注意**：对于隔离环境，请确保CUDA镜像已推送到您的私有注册表并可供集群访问。

```bash
CUDA_IMAGE=nvidia/cuda:12.4.1-base-ubuntu20.04 ./test_secure_accelerator_access.sh
```

## 结果

✅ **通过** - GPU访问已正确隔离并由Kubernetes设备插件和容器运行时调解。

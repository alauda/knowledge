---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB260100012
sourceSHA: 2c1cd5fa4ce9025d6c1868b4b019f9b717230d6ce932d954983dd5b35a4eb571
---

# Alauda 为 GPU 提供的 NVIDIA DRA 驱动程序构建

## 介绍

动态资源分配（DRA）是 Kubernetes 的一项功能，提供了一种更灵活和可扩展的方式来请求和分配硬件资源，如 GPU。与仅支持简单计数相同资源的传统设备插件不同，DRA 允许基于设备属性和能力进行细粒度的资源选择。

## 先决条件

- **NvidiaDriver v565+**
- **Kubernetes v1.32+**
- **ACP v4.1+**
- **对您的 ACP 集群的集群管理员访问权限**
- **底层容器运行时（如 containerd）必须启用 CDI**
- **必须启用 DRA 和相应的 API 组**

## 安装

### 在您的 GPU 节点上安装 Nvidia 驱动程序

请参考 [Nvidia 官方网站的安装指南](https://docs.nvidia.com/cuda/cuda-installation-guide-linux/)

### 安装 Nvidia 容器运行时

请参考 [Nvidia 容器工具包的安装指南](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

### 在 Containerd 中启用 CDI

CDI（容器设备接口）为设备供应商提供了一种标准机制，以描述提供访问特定资源（如 GPU）所需的内容，而不仅仅是简单的设备名称。

在 containerd 2.0 及更高版本中，默认启用 CDI 支持。早期版本（从 1.7.0 开始）需要手动激活此功能。

#### 在 containerd v1.7.x 中启用 CDI 的步骤（仅在 GPU 节点上需要）

1. 更新 containerd 配置。

   编辑配置文件：

   ```bash
   vi /etc/containerd/config.toml
   ```

   添加或修改以下部分：

   ```toml
   [plugins."io.containerd.grpc.v1.cri"]
     enable_cdi = true
   ```

2. 重启 containerd。

   ```bash
   systemctl restart containerd
   systemctl status containerd
   ```

   确保服务正常运行。

3. 验证 CDI 是否启用。

   ```bash
   journalctl -u containerd | grep "EnableCDI:true"
   ```

   等待片刻，如果有日志输出，则表示设置成功。

### 在 Kubernetes 中启用 DRA

DRA 支持在 Kubernetes 1.34 及更高版本中默认启用。早期版本（从 1.32 开始）需要手动激活此功能。

#### 在 Kubernetes 1.32–1.33 中启用 DRA 的步骤

在所有主节点上：

1. 编辑 `/etc/kubernetes/manifests/kube-apiserver.yaml` 中的 `kube-apiserver` 组件清单：

   对于 Kubernetes 1.32：

   ```yaml
   spec:
     containers:
       - command:
           - kube-apiserver
           - --feature-gates=DynamicResourceAllocation=true # required
           - --runtime-config=resource.k8s.io/v1beta1=true # required
         # ... other flags
   ```

   对于 Kubernetes 1.33：

   ```yaml
   spec:
     containers:
       - command:
           - kube-apiserver
           - --feature-gates=DynamicResourceAllocation=true # required
           - --runtime-config=resource.k8s.io/v1beta1=true,resource.k8s.io/v1beta2=true # required
         # ... other flags
   ```

2. 编辑 `/etc/kubernetes/manifests/kube-controller-manager.yaml` 中的 `kube-controller-manager` 组件清单：

   ```yaml
   spec:
     containers:
       - command:
           - kube-controller-manager
           - --feature-gates=DynamicResourceAllocation=true # required
         # ... other flags
   ```

3. 编辑 `/etc/kubernetes/manifests/kube-scheduler.yaml` 中的 `kube-scheduler` 组件清单：

   ```yaml
   spec:
     containers:
       - command:
           - kube-scheduler
           - --feature-gates=DynamicResourceAllocation=true
         # ... other flags
   ```

4. 对于 kubelet，在所有节点上编辑 `/var/lib/kubelet/config.yaml`：

   ```yaml
   apiVersion: kubelet.config.k8s.io/v1beta1
   kind: KubeletConfiguration
   featureGates:
     DynamicResourceAllocation: true
   ```

   重启 kubelet：

   ```bash
   sudo systemctl restart kubelet
   ```

### 下载集群插件

`Alauda 为 GPU 提供的 NVIDIA DRA 驱动程序构建` 集群插件可以从客户门户获取。

请联系客户支持以获取更多信息。

### 上传集群插件

有关上传集群插件的更多信息，请参考 [上传集群插件](https://docs.alauda.io/container_platform/4.2/extend/upload_package.html)

### 安装 Alauda 为 GPU 提供的 NVIDIA DRA 驱动程序构建

1. 在您的 GPU 节点上添加标签 "nvidia-device-enable=pgpu-dra" 以便 `nvidia-dra-driver-gpu-kubelet-plugin` 调度。

   ```bash
   kubectl label nodes {nodeid} nvidia-device-enable=pgpu-dra
   ```

   **注意：在同一节点上，您只能设置以下标签之一：`gpu=on`、`nvidia-device-enable=pgpu` 或 `nvidia-device-enable=pgpu-dra`。**

2. 转到 `管理员` -> `Marketplace` -> `集群插件` 页面，切换到目标集群，然后部署 `Alauda 为 GPU 提供的 NVIDIA DRA 驱动程序构建` 集群插件。

### 验证 DRA 设置

1. 检查 DRA 驱动程序和 DRA 控制器 Pod：

   ```bash
   kubectl get pods -n kube-system | grep "nvidia-dra-driver-gpu"
   ```

   您应该得到类似以下的结果：

   ```text
   nvidia-dra-driver-gpu-controller-675644bfb5-c2hq4   1/1     Running   0              18h
   nvidia-dra-driver-gpu-kubelet-plugin-65fjt          2/2     Running   0              18h
   ```

2. 验证 ResourceSlice 对象：

   ```bash
   kubectl get resourceslices -o yaml
   ```

   对于 GPU 节点，您应该看到类似以下的输出：

   ```yaml
   apiVersion: resource.k8s.io/v1beta1
   kind: ResourceSlice
   metadata:
     generateName: 192.168.140.59-gpu.nvidia.com-
     name: 192.168.140.59-gpu.nvidia.com-gbl46
     ownerReferences:
       - apiVersion: v1
         controller: true
         kind: Node
         name: 192.168.140.59
         uid: 4ab2c24c-fc35-4c75-bcaf-db038356575c
   spec:
     devices:
       - basic:
           attributes:
             architecture:
               string: Pascal
             brand:
               string: Tesla
             cudaComputeCapability:
               version: 6.0.0
             cudaDriverVersion:
               version: 12.8.0
             driverVersion:
               version: 570.124.6
             pcieBusID:
               string: 0000:00:0b.0
             productName:
               string: Tesla P100-PCIE-16GB
             resource.kubernetes.io/pcieRoot:
               string: pci0000:00
             type:
               string: gpu
             uuid:
               string: GPU-b87512d7-c8a6-5f4b-8d3f-68183df62d66
           capacity:
             memory:
               value: 16Gi
         name: gpu-0
     driver: gpu.nvidia.com
     nodeName: 192.168.140.59
     pool:
       generation: 1
       name: 192.168.140.59
       resourceSliceCount: 1
   ```

## 验证设置

本文档假设您已按照安装说明进行操作，并且所有相关的 GPU 组件均在运行并处于就绪状态。本文描述了如何验证已安装的 Alauda 为 GPU 提供的 NVIDIA DRA 驱动程序构建是否有效。

### 运行验证工作负载

创建规范文件：

```bash
cat <<EOF > dra-gpu-test.yaml
---
apiVersion: resource.k8s.io/v1beta1
kind: ResourceClaimTemplate
metadata:
  name: gpu-template
spec:
  spec:
    devices:
      requests:
      - name: gpu
        deviceClassName: gpu.nvidia.com
        selectors:
        - cel:
            expression: "device.attributes['gpu.nvidia.com'].productName == 'Tesla P100-PCIE-16GB'"
---
apiVersion: v1
kind: Pod
metadata:
  name: dra-gpu-workload
spec:
  tolerations:
  - key: "nvidia.com/gpu"
    operator: "Exists"
    effect: "NoSchedule"
  runtimeClassName: nvidia
  restartPolicy: OnFailure
  resourceClaims:
  - name: gpu-claim
    resourceClaimTemplateName: gpu-template
  containers:
  - name: cuda-container
    image: "ubuntu:22.04"
    command: ["bash", "-c"]
    args: ["nvidia-smi -L; trap 'exit 0' TERM; sleep 9999 & wait"]
    resources:
      claims:
      - name: gpu-claim
EOF
```

应用规范：

```bash
kubectl apply -f dra-gpu-test.yaml
```

获取 Pod 中容器的输出：

```bash
kubectl logs dra-gpu-workload -f
```

输出预计会显示容器中的 GPU UUID。例如：

```text
GPU 0: Tesla P100-PCIE-16GB (UUID: GPU-b87512d7-c8a6-5f4b-8d3f-68183df62d66)
```

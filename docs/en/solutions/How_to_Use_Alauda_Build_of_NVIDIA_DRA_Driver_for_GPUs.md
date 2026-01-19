---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.x
---

# Alauda Build of NVIDIA DRA Driver for GPUs

## Introduction

Dynamic Resource Allocation (DRA) is a Kubernetes feature that provides a more flexible and extensible way to request and allocate hardware resources like GPUs. Unlike traditional device plugins that only support simple counting of identical resources, DRA enables fine-grained resource selection based on device attributes and capabilities.

## Prerequisites

- **NvidiaDriver v565+**
- **Kubernetes v1.32+**
- **ACP v4.1+**
- **Cluster administrator access to your ACP cluster**
- **CDI must be enabled in the underlying container runtime (such as containerd)**
- **DRA and corresponding API groups must be enabled**

## Installation

### Installing Nvidia driver in your GPU node

Refer to [Installation guide of Nvidia Official website](https://docs.nvidia.com/cuda/cuda-installation-guide-linux/)

### Installing Nvidia Container Runtime

Refer to [Installation guide of Nvidia Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

### Enable CDI in Containerd

CDI (Container Device Interface) provides a standard mechanism for device vendors to describe what is required to provide access to a specific resource such as a GPU beyond a simple device name.

CDI support is enabled by default in containerd version 2.0 and later. Earlier versions, starting from 1.7.0, support for this feature requires manual activation.

#### Steps to Enable CDI in containerd v1.7.x

1. Update containerd configuration.

    Edit the configuration file:
    
    ```bash
    vi /etc/containerd/config.toml
    ```
    
    Add or modify the following section:
    
    ```toml
    [plugins."io.containerd.grpc.v1.cri"]
      enable_cdi = true
    ```

2. Restart containerd.

    ```bash
    systemctl restart containerd
    systemctl status containerd
    ```

    Ensure the service is running correctly.

3. Verify CDI is Enabled.

    ```bash
    journalctl -u containerd | grep "EnableCDI:true"
    ```

    Wait a moment, if there are logs, it means the setup was successful.

### Enable DRA in Kubernetes

DRA support is enabled by default in Kubernetes 1.34 and later. Earlier versions, starting from 1.32, support for this feature requires manual activation.

#### Steps to Enable DRA in Kubernetes 1.32–1.33

On the all master nodes:

1. Edit `kube-apiserver` component manifests in `/etc/kubernetes/manifests/kube-apiserver.yaml`:

    ```yaml
    spec:
      containers:
        - command:
            - kube-apiserver
            - --feature-gates=DynamicResourceAllocation=true # required
            - --runtime-config=resource.k8s.io/v1beta1=true,resource.k8s.io/v1beta2=true # required
          # ... other flags
    ```

2. Edit `kube-controller-manager` component manifests in `/etc/kubernetes/manifests/kube-controller-manager.yaml`:

    ```yaml
    spec:
      containers:
        - command:
            - kube-controller-manager
            - --feature-gates=DynamicResourceAllocation=true # required
          # ... other flags
    ```

3. Edit `kube-scheduler` component manifests in `/etc/kubernetes/manifests/kube-scheduler.yaml`:

    ```yaml
    spec:
      containers:
        - command:
            - kube-scheduler
            - --feature-gates=DynamicResourceAllocation=true
          # ... other flags
    ```

4. For kubelet, edit `/var/lib/kubelet/config.yaml` on the all nodes:

    ```yaml
    apiVersion: kubelet.config.k8s.io/v1beta1
    kind: KubeletConfiguration
    featureGates:
      DynamicResourceAllocation: true
    ```

    Restart kubelet:
    
    ```bash
    sudo systemctl restart kubelet
    ```

### Downloading Cluster plugin

`Alauda Build of NVIDIA DRA Driver for GPUs` cluster plugin can be retrieved from Customer Portal.

Please contact Consumer Support for more information.

### Uploading the Cluster plugin

For more information on uploading the cluster plugin, please refer to [Uploading Cluster Plugins](https://docs.alauda.io/container_platform/4.2/extend/upload_package.html)

### Installing Alauda Build of NVIDIA DRA Driver for GPUs

1. Add label "nvidia-device-enable=pgpu-dra" in your GPU node for `nvidia-dra-driver-gpu-kubelet-plugin` schedule.
    
    ```bash
    kubectl label nodes {nodeid} nvidia-device-enable=pgpu-dra
    ```
    
    **Note: On the same node, you can only set one of the following labels: `gpu=on`, `nvidia-device-enable=pgpu`, or `nvidia-device-enable=pgpu-dra`.**

2. Go to the `Administrator` -> `Marketplace` -> `Cluster Plugin` page, switch to the target cluster, and then deploy the `Alauda Build of NVIDIA DRA Driver for GPUs` Cluster plugin.

### Verify DRA setup

1. Check DRA driver and DRA controller pods:

    ```bash
    kubectl get pods -n kube-system | grep "nvidia-dra-driver-gpu"
    ```
    
    You should get results similar to:
    
    ```text
    nvidia-dra-driver-gpu-controller-675644bfb5-c2hq4   1/1     Running   0              18h
    nvidia-dra-driver-gpu-kubelet-plugin-65fjt          2/2     Running   0              18h
    ```

2. Verify ResourceSlice objects:

    ```bash
    kubectl get resourceslices -o yaml
    ```

    For GPU nodes, you should see output similar to:
    
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

## Validate Setup

This document assumes that you have followed the installation instructions, and that all relevant GPU components are running, and in a Ready state. This article describes how to verify that the installed Alauda Build of NVIDIA DRA Driver for GPUs is valid.

### Run validation workload

Create spec file:

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

Apply spec:

```bash
kubectl apply -f dra-gpu-test.yaml
```

Obtain output of container in the pod:

```bash
kubectl logs dra-gpu-workload -f
```

The output is expected to show the GPU UUID from the container. Example:

```text
GPU 0: Tesla P100-PCIE-16GB (UUID: GPU-b87512d7-c8a6-5f4b-8d3f-68183df62d66)
```

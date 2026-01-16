---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
id: KB260100011
sourceSHA: 5b1dc55fae4516a6851fd14d0f3a264348f5c8ef1c8d0d6c0bf62626147f70fa
---

# 将 VMware 虚拟机迁移到 Alauda 容器平台虚拟化

## 概述

本文档描述了如何使用 **Alauda Build of Forklift Operator** 将虚拟机从 VMware 集群迁移到 **Alauda 容器平台 (ACP) 虚拟化与 KubeVirt**。

Forklift 支持多个源平台，包括 VMware、OpenShift 虚拟化 (OCP)、Red Hat 虚拟化 (RHV)、OpenStack 以及 ACP 本身。本指南特别关注从 VMware 迁移到 ACP 的工作流程（目标提供者命名为 `host`）。

## 环境信息

Alauda 容器平台：>= 4.2.0

Forklift 版本：>= v4.2.1（从 cloud.alauda.io 获取最新版本）

ESXi 版本：>= 6.7.0

## 先决条件

- **Alauda 容器平台环境**：一个可用的启用虚拟化的 ACP 集群。
- **Operator 包**：必须从 Alauda 云下载 Alauda Build of Forklift Operator。
- **网络插件**：必须安装 Multus (*平台管理 → 集群管理 → 集群插件 → 安装 Multus*)。
- **VMware 环境**：
  - ESXi 主机名必须可解析（通过 DNS 或 CoreDNS 覆盖）。
  - ESXi 主机上必须启用 SSH 服务。
  - 客户端虚拟机中必须安装 VMware Tools。
- **机制说明**：Forklift 使用 ESXi 主机名构建迁移 Pod，以构造 `V2V_libvirtURL`，并通过 SSH 以 `esx://` 连接以检索磁盘映像。

## 术语

在继续之前，请了解迁移过程中使用的以下关键概念：

- **提供者**：表示源或目标虚拟化平台（例如，`vmware`、`ocp`、`rhv`、`openstack`、`acp`）。为当前 ACP 集群自动创建一个名为 **host** 的默认目标提供者。
- **StorageMap**：将源环境中使用的存储类映射到目标 ACP 集群中的存储类。
- **NetworkMap**：将源子网/网络映射到目标子网/网络。
- **计划**：描述要迁移哪些虚拟机的迁移计划。它引用一个 `StorageMap` 和一个 `NetworkMap`。
- **迁移**：触发 `计划` 的执行并提供实时状态更新。

## 迁移操作步骤

迁移过程分为以下步骤：

1. 上传并部署 Operator
2. 部署 Forklift 控制器
3. 准备 VDDK 初始化镜像
4. 添加 VMware 提供者
5. 创建网络和存储映射
6. 执行迁移计划
7. 迁移后配置

### 1. 使用 Violet 上传 Forklift Operator

从 [cloud.alauda.io](https://cloud.alauda.io) 下载 `violet` 工具。

使用 `violet` 工具将 Forklift operator 工件上传到平台。

```bash
export PLATFORM_URL=https://<platform-address>/
export PLATFORM_USER=<platform-user>
export PLATFORM_PASSWORD=<platform-password>

violet push <forklift-operator-package-name> \
  --platform-address $PLATFORM_URL \
  --platform-username $PLATFORM_USER \
  --platform-password $PLATFORM_PASSWORD
```

### 2. 部署 Operator

1. 导航到 **管理员 → Marketplace → OperatorHub**。
2. 找到 **forklift-operator**。
3. 点击 **部署**。

### 3. 创建 ForkliftController 实例

创建一个 `ForkliftController` 资源以初始化系统。

1. 在 Forklift Operator 下导航到 **已部署的 Operator → 资源实例**。
2. 创建 `ForkliftController`。

验证所有 Pod 是否正在运行：

```bash
kubectl get pod -n konveyor-forklift
```

预期的 Pod 包括：

- `forklift-api`
- `forklift-controller`
- `forklift-operator`
- `forklift-validation`
- `forklift-volume-populator-controller`

*注意：将自动创建一个名为 **host** 的提供者，以表示当前 ACP 集群，仅作为目标使用。*

### 4. 准备 VDDK 初始化镜像

VMware 虚拟磁盘开发工具包 (VDDK) 是磁盘传输所需的。

1. 从 Broadcom 官方网站下载匹配的 VMware VDDK Linux 包：[Broadcom VDDK 下载](https://developer.broadcom.com/sdks/vmware-virtual-disk-development-kit-vddk/latest)（需要登录）。
2. 解压包：
   ```bash
   tar xf VMware-vix-disklib-<vddk-version>.x86_64.tar.gz
   ```
3. 创建 `Containerfile`：
   ```
   FROM registry.access.redhat.com/ubi8/ubi-minimal
   USER 1001
   COPY vmware-vix-disklib-distrib /vmware-vix-disklib-distrib
   RUN mkdir -p /opt
   ENTRYPOINT ["cp", "-r", "/vmware-vix-disklib-distrib", "/opt"]
   ```
4. 构建并将镜像推送到您的注册表：
   ```bash
   podman build -t registry.example.com/kubev2v/vddk:<vddk-version> .
   podman push registry.example.com/kubev2v/vddk:<vddk-version>
   ```

### 5. 添加 VMware 提供者

创建一个包含 VMware 凭据的密钥并注册提供者。
VMware 的 sdkEndpoint 定义了工具如何连接到源或目标环境，`vcenter` 通过 vCenter 连接以管理多个主机，而 `esxi` 直接连接到单个 ESXi 主机。

```bash
export VMWARE_URL=https://<vmware-url>/sdk
export VMWARE_USER=<vmware-user>
export VMWARE_PASSWORD=<vmware-password>
export VDDKIMAGE=registry.example.com/kubev2v/vddk:8.0
export SDK_ENDPOINT='esxi'

# 创建密钥
kubectl -n konveyor-forklift create secret generic vmware \
  --from-literal=url=$VMWARE_URL \
  --from-literal=user=$VMWARE_USER \
  --from-literal=password=$VMWARE_PASSWORD \
  --from-literal=insecureSkipVerify=true

kubectl label secret vmware -n konveyor-forklift \
  createdForProviderType=vsphere \
  createdForResourceType=providers

# 创建提供者
kubectl apply -f - <<EOF
apiVersion: forklift.konveyor.io/v1beta1
kind: Provider
metadata:
  name: vmware
  namespace: konveyor-forklift
spec:
  type: vsphere
  url: $VMWARE_URL
  secret:
    name: vmware
    namespace: konveyor-forklift
  settings:
    sdkEndpoint: $SDK_ENDPOINT
    vddkInitImage: $VDDKIMAGE
EOF
```

验证提供者状态是否为 `Ready`。

### 6. 创建 NetworkMap

将源 VMware 网络映射到目标 Pod 网络。

要查找网络 ID：

1. 在 VMware 中打开虚拟机 → **编辑设置** → **网络适配器**。
2. 点击连接的网络。
3. 观察浏览器 URL（例如，`.../portgroups/HaNetwork-data`）。ID 是最后一段（例如，`HaNetwork-data`）。

```bash
export VMWARE_NET=HaNetwork-data

kubectl apply -f - <<EOF
apiVersion: forklift.konveyor.io/v1beta1
kind: NetworkMap
metadata:
  name: vmware-networkmap
  namespace: konveyor-forklift
spec:
  map:
    - source:
        id: $VMWARE_NET
      destination:
        type: pod
  provider:
    source:
      name: vmware
      namespace: konveyor-forklift
    destination:
      name: host
      namespace: konveyor-forklift
EOF
```

### 7. 创建 StorageMap

将源数据存储映射到目标 StorageClass。

要查找数据存储 UUID：

1. 在 VMware 中转到 **存储** 并选择虚拟机使用的数据存储。
2. 在详细信息页面中找到 **UUID** 字段（例如，`68b175ce-3432506e-e94c-74867adff816`）。

```bash
export SC_NAME=topolvm
export VMWARE_DATA_ID=<datastore-uuid>

kubectl apply -f - <<EOF
apiVersion: forklift.konveyor.io/v1beta1
kind: StorageMap
metadata:
  name: vmware-storagemap
  namespace: konveyor-forklift
spec:
  map:
    - source:
        id: $VMWARE_DATA_ID
      destination:
        storageClass: $SC_NAME
  provider:
    source:
      name: vmware
      namespace: konveyor-forklift
    destination:
      name: host
      namespace: konveyor-forklift
EOF
```

### 8. 创建迁移计划

定义 `计划` 资源以指定要迁移的虚拟机并链接映射资源。

```bash
export TARGET_NS=demo-space
export VM_NAME=vm-test

kubectl apply -f - <<EOF
apiVersion: forklift.konveyor.io/v1beta1
kind: Plan
metadata:
  name: example-plan
  namespace: konveyor-forklift
  annotations:
    populatorLabels: "True"
spec:
  provider:
    source:
      name: vmware
      namespace: konveyor-forklift
    destination:
      name: host
      namespace: konveyor-forklift
  map:
    network:
      name: vmware-networkmap
      namespace: konveyor-forklift
    storage:
      name: vmware-storagemap
      namespace: konveyor-forklift
  targetNamespace: $TARGET_NS
  migrateSharedDisks: true
  pvcNameTemplateUseGenerateName: true
  warm: true
  vms:
    - name: $VM_NAME
EOF
```

在继续之前，等待计划状态为 `READY=True`。

### 9. 创建迁移

触发迁移过程。

```bash
kubectl apply -f - <<EOF
apiVersion: forklift.konveyor.io/v1beta1
kind: Migration
metadata:
  name: example-migration
  namespace: konveyor-forklift
spec:
  plan:
    name: example-plan
    namespace: konveyor-forklift
EOF
```

**执行切换（用于温迁移）：**

对于温迁移，增量快照每小时运行一次。当准备切换到目标虚拟机时，设置特定的切换时间戳。系统将在预定时间自动关闭源虚拟机，将最终快照同步到 ACP，然后启动目标虚拟机。

```bash
kubectl patch migration example-migration -n konveyor-forklift \
  --type='merge' \
  -p '{"spec":{"cutover":"2025-01-16T10:00:00Z"}}'
```

将 `2025-01-16T10:00:00Z` 替换为您希望的切换时间，格式为 RFC3339。

### 10. 迁移后配置（添加磁盘标签）

迁移后，为 PVC 添加标签，以确保它们在 ACP UI 中正确关联到虚拟机并得到妥善管理。

```bash
export VM_PVC=<pvc-name>

kubectl label pvc -n $TARGET_NS $VM_PVC vm.cpaas.io/used-by=$VM_NAME
kubectl label pvc -n $TARGET_NS $VM_PVC vm.cpaas.io/reclaim-policy=Delete
```

一旦标记，虚拟磁盘将在 ACP 的虚拟机详细信息页面中可见。

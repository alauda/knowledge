---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500817
sourceSHA: b9afe7edbd5c68baf6ae459824c4a3e148afaa73aed28f9bb16d258322be9570
---

# ACP 上 Tekton CI/CD 的动态 NFS 存储供给

## 问题

CI/CD 工具如 Tekton 需要持久存储，以便在 Pod 重启后仍能保存数据，以便管道中的后续任务可以相互传递工作区数据。传统模式是动态供给：Pod 或 PipelineRun 引用一个 PersistentVolumeClaim，PVC 指定一个 StorageClass，外部供给者监视 PVC 并按需创建 PersistentVolume。许多本地部署使用 NFS 作为支持，这样单个导出可以为 `ReadWriteMany` 管道工作区和每个 PVC 的子目录提供服务。

在 Alauda Container Platform (Kubernetes `v1.34.5`，集群 `glean-lab-base-0529`) 上，上游的 `nfs-subdir-external-provisioner` Helm chart 不在工件目录中，并且没有第一方的打包。该集群提供了一个不同的 NFS 动态供给驱动程序：`nfs` ModulePlugin（`chart-csi-driver-nfs`，默认通道 `v4.4.0-beta.7`，仓库 `acp/chart-csi-driver-nfs`），它安装了上游的 `kubernetes-csi/csi-driver-nfs` CSI 驱动程序。该驱动程序在 `nfs.csi.k8s.io` 下注册，并通过 CSI 接口扮演相同的动态供给角色，而不是文章风格的 chart 使用的 sig-storage-lib 外部供给者 Pod。

## 解决方案

### 1. 安装 NFS CSI ModulePlugin

该驱动程序作为 `ClusterPluginInstance` 以 `nfs` 插件名称提供；在标准集群上，插件定义通过市场 ModulePlugin 解析（默认已安装）。确认插件存在并且 CSI 驱动程序已注册，然后验证控制器和每个节点的 DaemonSet Pod 是否在运行：

```bash
kubectl get clusterplugininstance nfs
# NAME   PLUGIN
# nfs    nfs

kubectl get csidriver nfs.csi.k8s.io
# NAME             ATTACHREQUIRED   PODINFOONMOUNT   STORAGECAPACITY   ...   MODES        AGE
# nfs.csi.k8s.io   false            false            false             ...   Persistent   4h6m

kubectl -n cpaas-system get pods -l app.kubernetes.io/name=csi-driver-nfs
```

该插件在 `cpaas-system` 中部署了一个 `csi-nfs-controller` Deployment 和一个 `csi-nfs-node` DaemonSet；在任何 NFS 支持的 PVC 可以挂载之前，两个 Pod 必须处于运行状态。

### 2. 提供可访问的 NFS 导出

该驱动程序在每个工作节点上使用标准的 Linux NFS 客户端进行挂载——与文章风格的供给者使用的内核侧挂载完全相同。集群不运行 NFS 服务器；选择一个客户拥有的导出，确保从每个工作节点的 IP 范围可访问，并确认导出的访问控制（`no_root_squash` / `rw` / 允许的主机）允许 kubelet 的挂载。

### 3. 创建一个 NFS 支持的 StorageClass

将 `nfs.csi.k8s.io` 作为供给者，并通过 `parameters` 传递服务器和共享。启用动态供给后，每个引用此 StorageClass 的 PVC 将从共享中切割出自己的子目录，并自动创建 PV：

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-csi
provisioner: nfs.csi.k8s.io
parameters:
  server: nfs.example.internal
  share: /exports/cluster
reclaimPolicy: Delete
volumeBindingMode: Immediate
```

`provisioner: nfs.csi.k8s.io` 是文章中 NFS 子目录外部供给者的替代品：相同的动态供给行为，CSI 驱动程序的血统，而不是 sig-storage-lib。`parameters.server` 和 `parameters.share` 映射到上游 Helm chart 将写入的 `nfs.server` 和 `nfs.path` 值。

### 4. 可选地将其标记为默认

集群的默认 StorageClass 是携带上游 `storageclass.kubernetes.io/is-default-class: "true"` 注释的那个。省略 `spec.storageClassName` 的 PVC 会被修改为当前默认的 StorageClass，正如上游 Kubernetes 中的行为：

```bash
kubectl get sc
# NAME                    PROVISIONER          RECLAIMPOLICY   VOLUMEBINDINGMODE      ...
# topolvm-hdd (default)   topolvm.cybozu.com   Delete          WaitForFirstConsumer   ...

kubectl annotate sc nfs-csi storageclass.kubernetes.io/is-default-class=true --overwrite
kubectl annotate sc topolvm-hdd storageclass.kubernetes.io/is-default-class- --overwrite
```

开箱即用的 ACP 将 `topolvm-hdd` 作为默认值；一次只能有一个 StorageClass 携带该注释，因此在提升 `nfs-csi` 时关闭旧的默认。如果 `nfs-csi` 应该是一个附加选择而不是默认值，则保持两个注释不变。

### 5. 从 Tekton Pipeline 工作区使用 StorageClass

Tekton operator（`tektoncd-operator`，作为 `Alauda DevOps Pipelines` OperatorBundle 在平台目录中提供，默认通道 `latest`，版本 `v4.2.0`）安装 `TektonConfig` / `TektonPipeline` 并以标准上游形状公开 `tekton.dev/v1` Pipeline / PipelineRun 资源。由 PVC 支持的工作区只需在 `workspaces[].persistentVolumeClaim.claimName` 下命名 PVC，后续任务共享挂载的目录：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pipeline-shared
  namespace: cicd
spec:
  accessModes: ["ReadWriteMany"]
  resources:
    requests:
      storage: 1Gi
  storageClassName: nfs-csi
---
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: build-and-test
  namespace: cicd
spec:
  pipelineRef:
    name: build-and-test
  workspaces:
  - name: shared-data
    persistentVolumeClaim:
      claimName: pipeline-shared
```

在 NFS CSI 驱动程序下，PVC 可以请求 `ReadWriteMany`，因此调度在不同节点上的任务可以同时挂载相同的工作区。使用默认的 `topolvm-hdd` SC 支持相同的工作区也可以，但 topolvm 是一个本地卷供给者，仅允许 `ReadWriteOnce`；对于顺序任务，Tekton 通过调度一个亲和性助手 StatefulSet 来共同放置 Pod。此模式已在 `glean-lab-base-0529` 上验证：一个两任务管道（`write` 然后 `read`）共享一个 `topolvm-hdd` 支持的 PVC 工作区运行成功，`read` 任务打印了 `write` 任务写入的文件。

## 诊断步骤

确认驱动程序和 StorageClass 已安装，并且 StorageClass 正确渲染：

```bash
kubectl get csidriver nfs.csi.k8s.io
kubectl get sc nfs-csi -o yaml
kubectl -n cpaas-system get pods -l app.kubernetes.io/name=csi-driver-nfs
```

创建一个烟雾测试 PVC，并观察外部供给者如何处理它：

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nfs-smoke
  namespace: default
spec:
  accessModes: ["ReadWriteMany"]
  resources:
    requests:
      storage: 100Mi
  storageClassName: nfs-csi
EOF

kubectl describe pvc nfs-smoke
```

健康的供给周期会发出一个 `Provisioning` 事件，其来源是 `nfs.csi.k8s.io_<driver-pod>`，并以 `ProvisioningSucceeded` 结束。如果 StorageClass 中的 `server` 或 `share` 从烟雾测试 Pod 所在的节点不可达，则事件显示为 `ProvisioningFailed`，并伴随底层的 `mount.nfs:` 错误（`Failed to resolve server …`，`Connection refused`，`access denied by server`）；这些是 NFS 服务器端的故障，而不是集群故障，需要在导出上修复，才能使任何 PVC 绑定。

## 注意事项

文章中命名的 `nfs-subdir-external-provisioner` Helm chart 不在 ACP 工件目录中（在工件仓库中为 `PACKAGE_NOT_FOUND`）。如果对其磁盘布局有严格要求，仍然可以从上游清单中应用，但它没有平台打包，没有账本条目，也没有 `ClusterPluginInstance`——支持的路径是 `csi-driver-nfs`。

上游指南中描述的 Jenkins 工作流（`Alauda DevOps Jenkins v3` OperatorBundle，`jenkins-operator` v3.20.15）在 Pod 规格级别遵循相同模式——PVC 挂载到 Jenkins 控制器/智能体 Pod 中——但在此修订版中未在此集群上测试操作员安装和控制器-PVC 绑定路径；将 Jenkins 变体视为类似但未经验证。

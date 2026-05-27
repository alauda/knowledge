---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500200
sourceSHA: 03b70d23e3f11281a3aed9a7eba194de5a3cf6f44733c1198cf6059e4a5179b2
---

# Argo CD UI 返回“由于 argocd-gitops-server 端点为空，应用程序在 ACP 上不可用”

## 问题

在 Alauda Container Platform v4.3.13 上，使用 `chart-argocd-installer` v4.2.0 和 `argocd-operator.v4.2.0` CSV（argocd-gitops-server 容器镜像 `build-harbor.alauda.cn/3rdparty/argoproj/argocd:v3.1.9-2`），对 Argo CD UI 的集群内请求可能无法到达后端，即使 argocd-gitops-server pods 报告为运行中。argocd-operator 在 `argocd` 命名空间中协调一个集群内的 ClusterIP 服务 `argocd-gitops-server`，其选择器与 argocd-gitops-server 部署的 pods 匹配；任何通过此服务解析 UI 的调用者都通过服务的 Endpoints 对象进行路由，因此当 Endpoints 子集为空或过时时，服务无法转发到任何就绪的 pod IP。

## 根本原因

在失败状态下，`argocd-gitops-server` 服务对象存在于 `argocd` 命名空间中，但其关联的 Endpoints 对象在 `.subsets[]` 中没有 `addresses`。该 Endpoints 行的健康状态在端口 8080 上携带两个就绪的 argocd-gitops-server pod IP（与服务的 `targetPort=8080` 匹配，针对 `http` / `https` 命名端口）；当这些地址缺失时，上游的 endpoint-controller（标签 `endpoints.kubernetes.io/managed-by=endpoint-controller`）没有任何内容可以为服务暴露，因此解析服务的调用者无法获得后端 pod IP。

## 解决方案

删除 `argocd` 命名空间中的 `argocd-gitops-server` 服务：

```bash
kubectl delete svc argocd-gitops-server -n argocd
```

该服务对象由 `argocd` 命名空间中的 ArgoCD CR `argocd-gitops`（apiVersion `argoproj.io/v1beta1`）通过 `ownerReferences` 拥有，且 `controller=true`。argocd-operator（CSV `argocd-operator.v4.2.0`）监视此 CR，并在其协调循环中重新创建拥有的 `argocd-gitops-server` 服务，恢复删除前存在的相同服务形状和选择器。

一旦服务恢复，kube-controller-manager endpoints 控制器将从 `argocd` 命名空间中匹配的就绪 argocd-gitops-server pods 重新填充 Endpoints 对象。服务选择器 `app.kubernetes.io/name=argocd-gitops-server` 匹配两个 argocd-gitops-server 部署 pods（`argocd-gitops-server-6779c7944d-*`），因此它们的 pod IP 在 `.subsets[0].addresses` 中重新出现，并且在 operator 重新创建服务后，`argocd-gitops-server` Endpoints 对象被重新填充。

对于非默认的自定义 ArgoCD 实例——例如在不同命名空间中的单独 ArgoCD CR——请在删除命令中用该实例的实际服务和命名空间替换服务名称和命名空间。在 ACP 中，服务器服务名称遵循 CR 名称模式 `<argocd-cr-name>-server`，因此名为 `argocd-gitops` 的 CR 生成服务 `argocd-gitops-server`，命名空间默认为 `argocd`，适用于平台安装。

## 诊断步骤

确认 `argocd` 命名空间中的 argocd-gitops-server pods 正在运行；健康状态显示两个 pods `1/1 Running` 来自 `argocd-gitops-server-*` 副本集：

```bash
kubectl get pods -n argocd -l app.kubernetes.io/name=argocd-gitops-server
```

在 `argocd` 命名空间中一起列出服务和 Endpoints 对象；在 `argocd-gitops-server` endpoints 行上，空或 `<none>` 的 `ADDRESSES` 列是服务未选择任何就绪 pods 的信号，而健康行则在端口 8080 上携带就绪的 pod IP：

```bash
kubectl get svc,ep -n argocd
```

---
products:
  - Alauda DevOps
kind:
  - Solution
id: KB260100010
sourceSHA: 131c66b825a9d248105208246282981c1c6e40f5b9d5df395de2fd1cf5411944
---

# Kube Event Enricher 安装指南

本指南提供了在您的 Kubernetes 集群中安装和配置 Kube Event Enricher Sink 的逐步说明。

## 先决条件

在安装 Kube Event Enricher Sink 之前，请确保您具备以下条件：

- 一个 Kubernetes 集群（推荐 v1.33 或更高版本）
- 已安装 [Knative Eventing](https://knative.dev/docs/install/)
- 已配置 `kubectl` 以访问您的集群
- 有足够的权限创建命名空间、部署和 RBAC 资源

## 离线包准备

本节描述如何为隔离或离线环境准备安装包。

### 所需材料

安装所需的以下组件：

- kubeevent-enricher 部署的清单 YAML 文件
- kubeevent-enricher-sink 的容器镜像

### 下载离线安装包

从 AlaudaCloud 下载安装包到您的工作目录：

```bash
export DOWNLOAD_URL=https://xxx.xx/kubeveent-enricher.tar.gz

mkdir kubeevent-enricher
cd kubeevent-enricher
wget ${DOWNLOAD_URL}
tar -xvzf ./kubeevent-enricher.tar.gz
```

### 上传镜像到集群注册表

根据您的集群架构，将容器镜像上传到集群的镜像注册表，并更新清单中的注册表引用。

```bash
# 设置您的集群注册表地址
export CLUSTER_REGISTRY={change-to-your-cluster-registry}

# 加载镜像归档
podman load -i ./dist/kubeevent-enricher-sink-amd64.image.tar

# 为您的集群注册表标记镜像
podman tag build-harbor.alauda.cn/devops/kubeevent-enricher-sink/enricher:xxx ${CLUSTER_REGISTRY}/devops/kubeevent-enricher-sink/enricher:xxx

# 推送到您的集群注册表
podman push ${CLUSTER_REGISTRY}/devops/kubeevent-enricher-sink/enricher:xxx

# 使用您的注册表地址更新清单
# 注意：在 macOS 上，sed 需要在 -i 和备份扩展之间留一个空格
# 在 macOS 上使用：sed -i '' "s/..."（带空格）
# 在 Linux 上使用：sed -i "s/..."（不带 ''）
sed -i'' "s/registry.alauda.cn:60070/${CLUSTER_REGISTRY}/g" dist/install.yaml
```

**注意**：本指南中所有后续命令假设您在 `kubeevent-enricher` 目录中工作。

## 安装

### 使用发布的清单

应用发布的安装清单：

```bash
kubectl apply -f dist/install.yaml
```

### 验证安装

检查部署是否正在运行：

```bash
# 检查部署状态
kubectl -n kubeevent-enricher rollout status deploy/kubeevent-enricher-sink

# 验证 Pods 是否正在运行
kubectl -n kubeevent-enricher get pods

```

## 配置

Kube Event Enricher Sink 通过部署清单中的命令行标志进行配置。您可以通过在应用之前编辑 `dist/install.yaml` 文件中的 `kubeevent-enricher-sink` 部署来修改这些标志，或者在安装后更新 `kubeevent-enricher` 命名空间中的 `kubeevent-enricher-sink` 部署。

### 可用标志

| 标志                  | 描述                                                                                                                                         | 默认值                                               | 是否必需 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------- |
| `--broker-ingress`    | Knative Broker 入口 URL，用于发送增强事件。增强器构造完整的 Broker URL 为 `<broker-ingress>/<namespace>/<broker-name>`                 | `http://broker-ingress.knative-operators.svc.cluster.local` | 否       |
| `--log-level`         | 应用程序的日志级别。有效值：`debug`、`info`、`warn`、`error`                                                                             | `info`                                            | 否       |
| `--event-type-prefix` | 要添加到 CloudEvent 类型属性的前缀。最终类型将为 `<prefix>.<kind>.<reason>.v1alpha1`                                                    | `dev.katanomi.cloudevents.kubeevent`              | 否       |

## 卸载

要从您的集群中移除 Kube Event Enricher Sink：

```bash
kubectl delete -f dist/install.yaml
```

## 故障排除

### 检查服务状态

```bash
# 查看部署详情
kubectl -n kubeevent-enricher describe deploy kubeevent-enricher-sink

# 查看 Pod 日志
kubectl -n kubeevent-enricher logs -l app=kubeevent-enricher-sink --tail=100
```

### 常见问题

**问题**：Pods 启动失败，显示 "ImagePullBackOff"

- **解决方案**：确保您的集群可以访问容器注册表。如果使用私有注册表，请检查镜像拉取密钥。

**问题**：事件未被增强

- **解决方案**：
  - 验证 APIServerSource 是否正确配置为发送到增强器服务
  - 检查增强器是否具有读取相关资源的适当 RBAC 权限
  - 查看增强器日志以获取错误消息

**问题**：事件未到达 Broker

- **解决方案**：
  - 验证 `--broker-ingress` 标志是否指向正确的 Broker 入口服务
  - 检查网络策略是否允许从增强器命名空间到 Broker 的流量
  - 确保 Broker 存在于目标命名空间

## 后续步骤

安装后，请参考以下文档：

- [Artifact Promotion Notifications](ArtifactPromotionRun_Approval_Notification_with_CorpWeChat.md) - 使用 Kube Event Enricher 实现工件推广场景通知

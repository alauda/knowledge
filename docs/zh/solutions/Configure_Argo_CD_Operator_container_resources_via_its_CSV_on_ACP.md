---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500514
sourceSHA: 69f5d2e73ee4075fee62e4aa96e891475ec1ec9903189f7c0b20b824761b5302
---

# 通过其 CSV 在 ACP 上配置 Argo CD Operator 容器资源

## 问题

在 Alauda 容器平台上，Argo CD operator 作为 `argocd-operator` OperatorBundle（命名空间 `argocd` 中的 CSV `argocd-operator.v4.2.0`，镜像 `build-harbor.alauda.cn/3rdparty/argoprojlabs/argocd-operator:v4.2.0`）进行交付。Operator-Lifecycle-Manager 从 ClusterServiceVersion 中嵌入的 Deployment 模板渲染 operator pod，位于 `.spec.install.spec.deployments[<deployment-name>].spec.template.spec.containers[<container-name>].resources`；在此集群中，嵌入的 Deployment 名称为 `argocd-operator-controller-manager`，容器名称为 `manager`。

当 controller-manager 容器的 `resources.requests` / `resources.limits` 对于实际工作负载过低时，operator pod 会受到标准的上游 kubelet OOM-kill 和调度器驱逐路径的影响，发生在 kube v1.34.5 上 — operator 的 `manager` 容器的容器资源压力可能表现为 OOMKilled / pod 重启，涉及同一 `core/v1.Container.resources` 字段。

## 解决方案

直接在 CSV 中提升容器的 `resources` 块。OLM 会将对 `.spec.install.spec.deployments[].spec.template.spec.containers[].resources` 的编辑同步回拥有的实时 Deployment，Kubernetes 会自动滚动 operator pod — 无需手动执行 `kubectl rollout restart` 或删除 pod。

一个提升 controller-manager 以摆脱不足配置默认值的示例配置为 `limits.cpu=500m`，`limits.memory=500Mi`，`requests.cpu=300m`，`requests.memory=300Mi`，应用于 ACP kube v1.34.5 上的 `manager` 容器的 `core/v1.Container.resources` 字段。该示例配置是一个起点；根据集群的实际原生应用数量 / repo-server 负载进行调整。

通过 OLM 写入的标签键发现 CSV。OLM 会为每个生成的 CSV 打上 `operators.coreos.com/<package-name>.<install-namespace>=`（空值）；对于 ACP 的 `argocd-operator` 包，这解析为 `operators.coreos.com/argocd-operator.argocd=`：

```bash
kubectl get csv -l operators.coreos.com/argocd-operator.argocd= -A -o name
```

然后就地编辑 CSV，并更新 `.spec.install.spec.deployments[argocd-operator-controller-manager].spec.template.spec.containers[manager].resources` 下的 `manager` 容器的 `resources` 块：

```bash
kubectl edit csv argocd-operator.v4.2.0 -n argocd
```

生成的块（示例配置）：

```yaml
spec:
  install:
    spec:
      deployments:
        - name: argocd-operator-controller-manager
          spec:
            template:
              spec:
                containers:
                  - name: manager
                    resources:
                      limits:
                        cpu: 500m
                        memory: 500Mi
                      requests:
                        cpu: 300m
                        memory: 300Mi
```

一旦保存 CSV 写入，OLM 会将更新后的容器模板同步到实时的 `Deployment/argocd-operator-controller-manager`（该 Deployment 带有指向 CSV `argocd-operator.v4.2.0` 的 `ownerReferences`），apps/v1 控制器会滚动 pod，新 operator pod 会以提升的 `resources` 值启动。

## 诊断步骤

在 CSV 编辑后，确认实时 Deployment 是 OLM 所有，并且其 `manager` 容器的 `resources` 块与 CSV 中嵌入的值匹配 — 匹配意味着 OLM 已将新配置同步到拥有的 Deployment；不匹配则意味着同步尚未完成或有外部修改器在其中。 （将此作为编辑后的验证 — 在编辑之前，CSV 和实时 Deployment 都携带安装时的默认值，并且会轻松匹配。）：

```bash
kubectl -n argocd get deploy argocd-operator-controller-manager \
  -o jsonpath='{.metadata.ownerReferences}'

kubectl -n argocd get deploy argocd-operator-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="manager")].resources}'

kubectl get csv argocd-operator.v4.2.0 -n argocd \
  -o jsonpath='{.spec.install.spec.deployments[?(@.name=="argocd-operator-controller-manager")].spec.template.spec.containers[?(@.name=="manager")].resources}'
```

在 CSV 编辑后，观察滚动更新获取新的容器模板，operator pod 自行重新创建：

```bash
kubectl -n argocd rollout status deploy/argocd-operator-controller-manager
kubectl -n argocd get pod -l control-plane=argocd-operator
```

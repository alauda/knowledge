---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500182
sourceSHA: 2322699236209884fda3135da56198b38e84c681787f6699e4cf42263e53650f
---

# 恢复在 ACP 上卡住的 OLM 订阅

## 问题

在 Alauda 容器平台 (Kubernetes 服务器 `v1.34.5`，OLM 镜像 `registry.alauda.cn:60080/3rdparty/operator-framework/olm:v4.3.1` 在 `cpaas-system` 命名空间中)，由 `Subscription` (`subscriptions.operators.coreos.com`) 驱动的 operator 安装可能会明显卡住，因为 OLM `catalog-operator` 无法在 gRPC 截止时间内枚举来自后端 `CatalogSource` 的 bundles。当这种情况发生时，catalog-operator 会在受影响的 Subscription 的 `.status.conditions[]` 中记录失败，消息格式为 `error using catalogsource <ns>/<name>: error encountered while listing bundles: rpc error: code = DeadlineExceeded desc = context deadline exceeded`。

## 诊断步骤

主要信号存在于 Subscription 本身。使用 `kubectl` 直接读取其条件数组 — 每个条目是上游 OLM 的 `SubscriptionCondition` (`lastTransitionTime`, `message`, `reason`, `status`, `type`)，并逐字携带 catalog-listing 或解析错误：

```bash
kubectl get sub <name> -n <ns> -o jsonpath='{.status.conditions}'
# 或者，为了更容易阅读：
kubectl get sub <name> -n <ns> -o json | jq .status.conditions
```

通过尾随 `cpaas-system` 中 `catalog-operator` Pod 的日志来证实 Subscription 条件。该 Pod 是一个由 `app=catalog-operator` 选择的单副本 Deployment，并提供上游 operator-framework 日志记录器，因此相同的 `DeadlineExceeded` 行也会在这里出现，以及它正在拨打的 `catalogsource.name` / `catalogsource.namespace`：

```bash
kubectl get pod -n cpaas-system -l app=catalog-operator
kubectl logs -n cpaas-system -l app=catalog-operator --tail=200
```

## 解决方案

选择最不具侵入性的修复方法，以清除卡住状态并重新运行 Subscription 解析。以下四个选项按顺序排列，从仅旋转 catalog registry-server 到旋转控制器、修补 Subscription 状态和重新创建 Subscription；一旦 Subscription 的 `.status.conditions[]` 反映出新的健康解析，就停止。

首先，重启受影响的 `CatalogSource` 背后的 registry-server。在 ACP 中，每个 CatalogSource 的 `sourceType: grpc`，其 `.spec.address` 为 `olm-registry-<lib>.cpaas-system.svc:50051`，由 `cpaas-system` 中名为 `olm-registry-<lib>` 的 Deployment 提供服务；滚动该 Deployment 会启动一个新的 registry pod，因此 catalog-operator 的下一个 `ListBundles` 调用将干净地提供服务：

```bash
kubectl rollout restart deploy/olm-registry-<lib> -n cpaas-system
kubectl rollout status  deploy/olm-registry-<lib> -n cpaas-system
```

如果在 registry-server 健康后卡住的状态仍然存在，则重启 OLM 控制器本身，以便它重新拨打每个 CatalogSource 并从头重新评估 Subscription 解析：

```bash
kubectl delete pod -l app=catalog-operator -n cpaas-system
kubectl get pod -n cpaas-system -l app=catalog-operator -w
```

当 catalog-operator 健康但 Subscription 仍然携带过时的 `.status.conditions[]` 条目时，直接修补状态子资源的条件数组。kube-apiserver 会将 JSON-patch 路由到 `/status` 子资源，因此 OLM 会在下次协调时写入新的解析结果：

```bash
kubectl patch sub <name> -n <ns> \
  --subresource=status \
  --type json \
  -p '[{"op":"remove","path":"/status/conditions"}]'
```

作为最后的手段，卸载并重新安装 operator：删除失败的 `Subscription` 及其 `ClusterServiceVersion`，然后使用 `kubectl apply` 重新创建 Subscription，针对现在健康的 `CatalogSource`。新的 Subscription 将以空的 `.status.conditions` 解析并正常进行：

```bash
kubectl delete subscription <name> -n <ns>
kubectl delete csv <csv-name> -n <ns>
kubectl apply -f subscription.yaml
kubectl get sub <name> -n <ns> -o jsonpath='{.status.conditions}'
```

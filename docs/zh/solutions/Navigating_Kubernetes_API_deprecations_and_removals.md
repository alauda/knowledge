---
kind:
  - BestPractices
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500011
sourceSHA: f16967f251181c5abf31c3ef807ee8f9a7b1490b4b803d9f7dbe888332696c7b
---

# 导航 Kubernetes API 的弃用和移除

## 概述

Kubernetes 遵循严格的 API 版本控制政策。每个 beta API（`v1beta1`、`v2beta1` 等）在被标记为弃用后，保证支持九个月或三个 Kubernetes 版本——以较长者为准——然后可以完全从服务器中移除。当移除发生时，任何仍然使用旧版本的工作负载、控制器、工具或管道将停止工作。

上游维护了 [API 弃用政策](https://kubernetes.io/docs/reference/using-api/deprecation-policy/) 和每个版本的 [弃用 API 迁移指南](https://kubernetes.io/docs/reference/using-api/deprecation-guide/) 的规范时间线。管理员应在每次小版本升级时审计其集群中使用的弃用版本，将受影响的清单迁移到新版本，然后在审计清理干净后明确解除升级阻塞。

本文描述了如何在 ACP 集群中识别弃用的 API 使用情况，如何迁移到后续版本，以及集群作为信号暴露的尚未清理的使用情况。

## 解决方案

将每次小版本升级视为 API 审计。以下工作流程适用于任何基于 Kubernetes 的平台：

1. **清点目标版本中所有已移除的 API。** 上游的 [弃用 API 迁移指南](https://kubernetes.io/docs/reference/using-api/deprecation-guide/) 列出了每个小版本中移除的具体 `group/version/kind` 三元组（例如，Kubernetes 1.22 移除了在 1.16 中已弃用的大量 `v1beta1` API）。建立一个目标版本将停止提供的种类列表。

2. **扫描所有存储对象以查找这些种类。** 每个弃用对象有两个维度：`storedVersion`（etcd 保存在磁盘上的内容，通过 `kubectl get --raw /apis/<group>` 返回）和 `served` 版本（客户端和控制器提交的内容）。两者都需要升级：

   ```bash
   # 集群仍然提供哪些版本？
   kubectl api-resources -o wide
   kubectl api-versions

   # 每个资源在 etcd 中存储的版本是什么？
   kubectl get apiservices.apiregistration.k8s.io \
     -o custom-columns=NAME:.metadata.name,AVAILABLE:.status.conditions[?(@.type=="Available")].status
   ```

   对于每个弃用的种类，使用 `kubectl get <kind> -A -o yaml` 并查看返回 YAML 中的 `apiVersion`。任何仍绑定到弃用版本的内容将在下次升级中无法存活。

3. **将清单、图表和自动化重写为后续版本。** 典型的迁移包括：

   - `extensions/v1beta1` Ingress → `networking.k8s.io/v1` Ingress
   - `policy/v1beta1` PodDisruptionBudget → `policy/v1` PodDisruptionBudget
   - `autoscaling/v2beta2` HorizontalPodAutoscaler → `autoscaling/v2`
   - `batch/v1beta1` CronJob → `batch/v1`
   - `apiregistration.k8s.io/v1beta1` APIService → `apiregistration.k8s.io/v1`

   对于 CRD 支持的工作负载，跨整个工具链提升 `apiVersion`：原始清单、Helm 图表、GitOps 应用源、CI 管道固定装置以及任何 admission-webhook 客户端代码。即使有一个生成器仍使用旧版本，下一次 `kubectl apply` 将静默地重新创建一个弃用对象。

4. **重新运行扫描直到清理干净，** 然后继续升级。不要依赖升级后的修复脚本；一旦服务器停止提供旧版本，使用它的现有控制器将开始出错。

5. **尽可能偏好 `apiVersion` 无关的工具。** CRD 上的 `conversion webhooks`、`kustomize` `apiVersion` 补丁和基于运行的 Kubernetes 小版本的 Helm 模板，让您能够在不同版本的集群中推出单一源代码树，而无需为每个服务器版本单独准备清单。

## 诊断步骤

在运行的集群上，有两个信号可以告诉您是否仍在使用弃用的 API：

```bash
# 每个弃用请求都会增加此计数器。迁移工作完成后，非零速率意味着某个控制器或 cronjob 仍在使用旧版本。
kubectl get --raw '/metrics' | grep apiserver_requested_deprecated_apis
```

查询 Prometheus 以获取相同计数器，以查看 *哪个* 资源仍在使用：

```text
sum by (group, version, resource) (
  rate(apiserver_requested_deprecated_apis[5m])
)
```

group/version/resource 标签标识了违规者——通常是尚未升级的控制器或操作员。升级组件（或者，如果是内部开发的，提升其 client-go 依赖）直到计数器降至零。

根据下一个版本的移除列表审计存储资源：

```bash
for api in \
  ingresses.extensions \
  podsecuritypolicies.policy \
  cronjobs.batch \
  horizontalpodautoscalers.autoscaling \
  ; do
  echo "=== $api ==="
  kubectl get "$api" -A -o json 2>/dev/null | jq -r '.items[] | "\(.apiVersion) \(.metadata.namespace)/\(.metadata.name)"' | sort -u
done
```

任何显示弃用 `apiVersion` 的行都是迁移候选者。以后续版本重新应用对象，以重写 etcd 中的存储副本。一旦输出仅包含后续版本，集群就可以安全地进行移除旧版本的升级。

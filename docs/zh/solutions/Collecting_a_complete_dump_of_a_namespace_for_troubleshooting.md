---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500002
sourceSHA: 67b399265d92254a719be3e769c30189ad90c792561069347ae5f15ca886cc60
---

# 使用 kubectl 收集 ACP 上的命名空间资源和 Pod 日志

## 问题

在 Alauda Container Platform 上，收集单个命名空间的完整信息以进行诊断意味着需要捕获两件事：该命名空间中每个命名空间资源的清单 \[ev:c3]，以及每个 Pod 中每个容器的日志 \[ev:c5]。高效地做到这一点——而不需要为每种资源类型发出一个 API 请求或错过崩溃容器的先前日志——依赖于一小段可重复的 `kubectl` 调用，而不是临时的逐对象命令。这个方法将收集范围限制在一个命名空间内（可选地扩展到集群范围的对象以获取特权身份）；跨平台组件的集群范围诊断扫描是一个单独的过程，此处不予涵盖 \[ev:c3]。

## 解决方案

列举支持列出操作的命名空间资源类型，然后在一个请求中转储它们。可列出的命名空间类型集通过 `api-resources` 生成，并将该以逗号连接的列表直接输入到一个 `get` 调用中 \[ev:c3]。将列举的类型合并为一个 `get` 调用可以将转储限制为一个请求，而不是为每种资源类型发出单独的 `get` 请求 \[ev:c4]。

```bash
NS=<namespace>
TYPES=$(kubectl api-resources --namespaced=true --verbs=list -o name | paste -sd, -)
kubectl get "$TYPES" -n "$NS" -o yaml
```

通过列出其 Pods 收集整个命名空间的容器日志，从每个 Pod 的规格中读取每个容器的名称，并按容器提取带时间戳的日志。容器名称来自 `.spec.containers[*].name`，而 `logs --container=<c> --timestamps` 为每个容器输出带有 RFC3339 前缀的行 \[ev:c5]。

```bash
for pod in $(kubectl get pods -n "$NS" -o name); do
  for c in $(kubectl get "$pod" -n "$NS" -o jsonpath='{.spec.containers[*].name}'); do
    kubectl logs "$pod" -n "$NS" --container="$c" --timestamps
  done
done
```

对于已重启的容器，先前终止实例的日志通过 `-p/--previous` 标志单独检索，该标志返回先前运行的日志，而不是当前的日志 \[ev:c6]。

```bash
kubectl logs <pod> -n "$NS" --container=<c> --previous --timestamps
```

## 诊断步骤

在尝试日志转储之前，确认当前身份被允许在命名空间中读取 Pod 日志。自我 RBAC 检查可以在没有反复试验的情况下回答这个问题 \[ev:c7]。

```bash
kubectl auth can-i get pods/log -n "$NS"
```

当身份还持有 cluster-reader 或 cluster-admin 权限时——可以通过对集群范围动词的自我检查来检测——将收集范围扩展到集群范围的对象。在此环境中（Kubernetes `v1.34.5`），`get nodes` 自我检查对这样的身份返回是，并且节点、clusterrolebindings、storageclasses、persistentvolumes 和 csrs 都作为可列出的对象存在于集群中 \[ev:c8]。这些集群范围的类型通常对 cluster-reader/admin 可达；如果您不确定某个特定类型，请在将其添加到转储之前，对其运行相同的 `auth can-i` 检查。

```bash
kubectl auth can-i get nodes
kubectl get nodes,clusterrolebindings,storageclasses,persistentvolumes,csr -o yaml
```

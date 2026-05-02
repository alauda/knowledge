---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500012
sourceSHA: b4356432791edd6a1590c4831e0e3a50d53af6652d71895d5e2439e16fd70ad3
---

# 命名空间因残留的最终处理器而卡在终止状态

## 问题

一个命名空间已被删除，但在 `kubectl get ns` 中仍然可见，状态为 `Terminating`。通常的后续命令在该命名空间中列出没有工作负载资源，但命名空间对象本身拒绝消失：

```bash
kubectl get all -n scheduling
# 没有找到资源。

kubectl describe namespace scheduling
# 状态:  Terminating
```

等待没有帮助——命名空间将保持在 `Terminating` 状态，直到每个仍携带最终处理器的命名空间对象的最终处理器被清除。此状态通常会阻止重新创建同名命名空间，破坏 GitOps 协调循环，并静默保留计入集群预算的配额。

## 根本原因

Kubernetes 中的命名空间删除是协作的：API 服务器仅在其中的每个资源被删除后才会移除命名空间对象。“每个资源”比 `kubectl get all` 打印的内容更广泛——`all` 是一个经过策划的别名，仅列出一小部分类型（Pod、Deployment、Service 及其他少数类型）。由 CRD 定义的自定义资源、证书请求、Webhook 配置、策略对象以及许多其他命名空间类型不在该别名的范围内。

这些隐藏资源的删除本身是异步的，因为 Kubernetes 使用最终处理器来协调拆除。最终处理器是 `metadata.finalizers` 上的一个字符串，阻止 API 服务器实际移除对象；拥有最终处理器的控制器预计会完成其清理工作，然后从列表中删除其条目。一旦列表为空，对象就会被垃圾回收，一旦命名空间不再包含被阻塞的对象，命名空间本身就会完成其终止。

因此，卡在 `Terminating` 状态的命名空间意味着至少有一个最终处理器未被清除。三个常见原因：

- 安装最终处理器的控制器已被卸载或缩放为零，因此没有任何监视者来移除它。
- 控制器正在运行，但无法完成其清理（下游 API 无法访问、凭证丢失、Webhook 超时）。
- 对象是一个自定义资源，其 CRD 本身已被删除；没有 CRD，控制器消失，留下孤立的实例。

## 解决方案

安全的修复方法是找到持有最终处理器的特定资源，识别拥有控制器，并让该控制器完成其工作。强制移除最终处理器应仅保留在已知控制器消失且其残留状态被确认安全删除的情况下。

步骤 1 — 列举集群已知的每个命名空间 API 资源类型：

```bash
kubectl api-resources --namespaced --verbs=list -o name
```

步骤 2 — 列出卡在命名空间中的每个命名空间类型的每个对象，并打印仍然具有最终处理器的对象：

```bash
NS=scheduling
kubectl api-resources --verbs=list --namespaced -o name \
  | xargs -n 1 kubectl get --show-kind --ignore-not-found -n "$NS" \
      -o jsonpath='{range .items[*]}{.kind}/{.metadata.name}: {.metadata.finalizers}{"\n"}{end}' \
  | awk -F: '$2 ~ /finalizer/'
```

每一行非空的输出都是一个阻塞者。类型和名称告诉您哪个控制器应该移除最终处理器。首先修复控制器的视图——例如，如果 `externalsecrets.external-secrets.io/foo: [external-secrets.io/finalizer]` 出现，请验证 External Secrets 操作员是否正在运行、其 Webhook 是否可访问，以及其凭证是否有效。解决控制器的问题可以让它完成自己的工作，命名空间也会自行完成。

步骤 2b — 如果控制器确实消失且已知对象可以安全删除（CRD 已卸载、操作员已移除、没有仍然重要的外部状态），则手动移除最终处理器。仅在您确定没有下游清理被遗漏时执行此操作：

```bash
kubectl patch <kind>/<name> -n "$NS" \
  --type=merge \
  -p '{"metadata":{"finalizers":null}}'
```

重复此操作，直到每个残留对象消失。命名空间随后将在几秒钟内从 `Terminating` 状态转换。

## 诊断步骤

在强制执行任何操作之前，收集证据以便您可以证明移除最终处理器的决定：

检查命名空间对象本身的最终处理器——命名空间规格上的 `kubernetes` 最终处理器意味着 API 服务器仍在等待内容清理，而不是等待外部控制器。如果您在命名空间上看到其他最终处理器（很少见），它们来自自定义准入/命名空间生命周期控制器，只有在验证控制器的意图后才应清除：

```bash
kubectl get ns scheduling -o yaml | grep -A3 finalizers
```

检查是否有任何 CRD 在实例仍然存在时被删除；孤立的 CR 是非常常见的原因：

```bash
kubectl get crd -o name \
  | xargs -I{} sh -c 'kubectl get {} -n scheduling --ignore-not-found -o name 2>/dev/null'
```

查看命名空间中的事件以及拥有操作员的命名空间中的事件——控制器通常会发出协调错误，准确解释它们无法移除其最终处理器的原因：

```bash
kubectl get events -n scheduling --sort-by=.lastTimestamp
kubectl logs -n <operator-namespace> deploy/<operator-deployment> --tail=200
```

对于每个有问题的对象，决定：此最终处理器保护的外部状态是否仍然存在？对于 `PersistentVolume` 最终处理器，答案可能是需要手动去除的真实存储卷；对于 CRD 已被移除的操作员管理资源，其保护的状态通常已经随着 CRD 消失。当有疑问时，请在修补最终处理器之前联系创建该资源的操作员的作者——强制删除仍然存在的外部状态的资源会泄漏该状态。

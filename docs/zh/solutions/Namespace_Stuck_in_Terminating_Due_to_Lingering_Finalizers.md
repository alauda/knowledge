---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500012
sourceSHA: 6bde8b442771fce16ae484017395bad91b554f608d4136a33190bf708b6ec7be
---

## 问题

一个命名空间已被删除，但在 `kubectl get ns` 中仍然可见，状态为 `Terminating`。通常后续命令在命名空间中列出没有工作负载资源，但命名空间对象本身拒绝消失：

```bash
kubectl get all -n scheduling
# 没有找到资源。

kubectl describe namespace scheduling
# 状态:  Terminating
```

等待并没有帮助——命名空间将保持在 `Terminating` 状态，直到每个仍携带最终器的命名空间对象的最终器被清除。此状态通常会阻止重新创建同名的命名空间，破坏 GitOps 协调循环，并静默保留计入集群预算的配额。

## 根本原因

Kubernetes 中的命名空间删除是协作的：API 服务器仅在内部的每个资源被删除后才会移除命名空间对象。“每个资源”比 `kubectl get all` 打印的内容更广泛——`all` 是一个经过策划的别名，仅列出一小部分类型（Pod、Deployment、Service 以及少数其他）。由 CRD 定义的自定义资源、证书请求、Webhook 配置、策略对象以及许多其他命名空间类型不在该别名的覆盖范围内。

这些隐藏资源的删除本身是异步的，因为 Kubernetes 使用最终器来协调拆除。最终器是 `metadata.finalizers` 上的一个字符串，它阻止 API 服务器实际移除对象；拥有最终器的控制器需要完成其清理工作，然后从列表中删除其条目。一旦列表为空，对象就会被垃圾回收，一旦命名空间不再包含被阻塞的对象，命名空间本身就会完成其终止。

因此，处于 `Terminating` 状态的命名空间意味着至少有一个最终器没有被清除。三个常见原因：

- 安装最终器的控制器已被卸载或缩放为零，因此没有任何监视来移除它。
- 控制器正在运行，但无法完成其清理（下游 API 无法访问、凭证丢失、Webhook 超时）。
- 对象是一个自定义资源，其 CRD 本身已被删除；没有 CRD，控制器就消失了，留下孤立的实例。

## 解决方案

安全的修复方法是找到持有最终器的特定资源，识别拥有的控制器，并让该控制器完成其工作。强制移除最终器应仅保留在已知控制器消失且其残留状态被确认安全可丢弃的情况下。

步骤 1 — 列举集群已知的每个命名空间 API 资源类型：

```bash
kubectl api-resources --namespaced --verbs=list -o name
```

步骤 2 — 列出卡住的命名空间内每个命名空间类型的每个对象，并打印仍有最终器的对象：

```bash
NS=scheduling
kubectl api-resources --verbs=list --namespaced -o name \
  | xargs -n 1 kubectl get --show-kind --ignore-not-found -n "$NS" \
      -o jsonpath='{range .items[*]}{.kind}/{.metadata.name}: {.metadata.finalizers}{"\n"}{end}' \
  | awk -F: '$2 ~ /finalizer/'
```

每一行非空的结果都是一个阻塞者。类型和名称告诉你哪个控制器应该移除最终器。首先修复控制器的视图——例如，如果 `externalsecrets.external-secrets.io/foo: [external-secrets.io/finalizer]` 出现，验证 External Secrets 操作员是否正在运行、其 Webhook 是否可访问，以及其凭证是否有效。解决控制器的问题可以让它完成自己的工作，命名空间也会自行完成。

步骤 2b — 如果控制器确实消失且已知对象可以安全丢弃（CRD 已卸载、操作员已移除、没有仍然重要的外部状态），手动移除最终器。仅在确认没有遗漏下游清理时执行此操作：

```bash
kubectl patch <kind>/<name> -n "$NS" \
  --type=merge \
  -p '{"metadata":{"finalizers":null}}'
```

重复此操作，直到每个残留对象消失。命名空间随后将在几秒钟内从 `Terminating` 状态转换出来。

## 诊断步骤

在强制执行任何操作之前，收集证据，以便你可以证明移除最终器的决定：

检查命名空间对象本身的最终器——命名空间规格上的 `kubernetes` 最终器意味着 API 服务器仍在等待内容清理，而不是等待外部控制器。如果你在命名空间上看到其他最终器（很少见），它们来自自定义的入场/命名空间生命周期控制器，只有在验证控制器的意图后才能清除：

```bash
kubectl get ns scheduling -o yaml | grep -A3 finalizers
```

检查是否有任何 CRD 在实例仍然存在时被删除；孤立的 CR 是非常常见的原因：

```bash
kubectl get crd -o name \
  | xargs -I{} sh -c 'kubectl get {} -n scheduling --ignore-not-found -o name 2>/dev/null'
```

查看命名空间中的事件以及拥有操作员的命名空间中的事件——控制器通常会发出协调错误，准确解释它们无法移除最终器的原因：

```bash
kubectl get events -n scheduling --sort-by=.lastTimestamp
kubectl logs -n <operator-namespace> deploy/<operator-deployment> --tail=200
```

对于每个有问题的对象，决定：这个最终器保护的外部状态是否仍然存在？对于 `PersistentVolume` 最终器，答案可能是需要手动去除的真实存储卷；对于已删除 CRD 的操作员管理资源，通常它所保护的状态已经随着 CRD 消失。当不确定时，请在修补最终器之前联系创建资源的操作员的作者——强制删除仍然存在的外部状态的资源会泄漏该状态。

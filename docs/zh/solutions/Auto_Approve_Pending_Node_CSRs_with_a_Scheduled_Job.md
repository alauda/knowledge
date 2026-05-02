---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: 53a8e3c4fb187d970aac84572e97f4751c89d28cc97ce832b76a8712691cddfa
---

## 问题

节点 kubelets 定期提交证书签名请求 (CSRs) 以更新其客户端和服务证书。当负责批准它们的控制器未运行，或当来自工作负载的 CSRs 到达速度超过操作员手动处理的速度时，新节点会停滞在 `NotReady` 状态，现有节点在执行 `kubectl logs`、`kubectl exec` 和 `kubectl port-forward` 时会出现 TLS 错误。通过 `kubectl certificate approve` 进行手动批准在事件发生期间无法扩展且容易出错。

## 根本原因

Kubernetes 设计上不自动批准任意的 CSRs — 不受限制的批准是集群管理员等效的特权。对于 kubelet CSRs，默认的控制器管理器批准符合严格标准的新节点 CSRs（正确的 `system:nodes` 签名者、被认可的节点身份、允许的密钥使用）。任何超出这一狭窄范围的请求都将处于待处理状态，包括：

- Kubelet 服务 CSRs (`kubernetes.io/kubelet-serving`)，默认情况下故意 **不** 自动批准。
- 自定义操作员提交的 CSRs，这些操作员发放自己的客户端证书。
- 节点集群重启期间的批量 CSR 峰值，这可能会瞬间超过控制器的速率预算。

一个狭窄、范围明确的 Job 或 CronJob 来批准符合明确条件的 CSRs 是保持集群健康的务实方法，而不将广泛的签名权限交给每个人。

## 解决方案

运行一个最小权限的 CronJob，以可预测的节奏批准待处理的 CSRs。限制 RBAC，使 Job 只能批准 CSRs，而不能签名或铸造任意证书。

1. **创建一个专用的命名空间和 ServiceAccount。**

   ```bash
   kubectl create namespace csr-approver
   kubectl -n csr-approver create serviceaccount csr-approver
   ```

2. **仅授予所需的动词。** `certificatesigningrequests` 上的 `approve`/`deny` 动词是最低要求；不要授予 `cluster-admin`。

   ```yaml
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRole
   metadata:
     name: csr-approver
   rules:
     - apiGroups: ["certificates.k8s.io"]
       resources: ["certificatesigningrequests"]
       verbs: ["get", "list", "watch"]
     - apiGroups: ["certificates.k8s.io"]
       resources: ["certificatesigningrequests/approval"]
       verbs: ["update"]
     - apiGroups: ["certificates.k8s.io"]
       resources: ["signers"]
       resourceNames:
         - "kubernetes.io/kubelet-serving"
         - "kubernetes.io/kube-apiserver-client-kubelet"
       verbs: ["approve"]
   ---
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRoleBinding
   metadata:
     name: csr-approver
   subjects:
     - kind: ServiceAccount
       name: csr-approver
       namespace: csr-approver
   roleRef:
     apiGroup: rbac.authorization.k8s.io
     kind: ClusterRole
     name: csr-approver
   ```

3. **调度批准者。** 5 分钟的节奏可以快速捕捉服务 CSRs，而不会造成忙循环。通过 `.spec.signerName` 进行过滤，以确保 Job 不会处理用户或第三方的 CSRs。

   ```yaml
   apiVersion: batch/v1
   kind: CronJob
   metadata:
     name: csr-approver
     namespace: csr-approver
   spec:
     schedule: "*/5 * * * *"
     successfulJobsHistoryLimit: 1
     failedJobsHistoryLimit: 3
     concurrencyPolicy: Forbid
     jobTemplate:
       spec:
         backoffLimit: 0
         ttlSecondsAfterFinished: 300
         template:
           spec:
             serviceAccountName: csr-approver
             restartPolicy: Never
             containers:
               - name: approver
                 image: bitnami/kubectl:1.33
                 command:
                   - /bin/sh
                   - -ec
                   - |
                     for name in $(kubectl get csr \
                         -o jsonpath='{range .items[?(@.status.conditions==null)]}{.metadata.name}{"\n"}{end}'); do
                       signer=$(kubectl get csr "$name" -o jsonpath='{.spec.signerName}')
                       case "$signer" in
                         kubernetes.io/kubelet-serving|kubernetes.io/kube-apiserver-client-kubelet)
                           echo "approving $name ($signer)"
                           kubectl certificate approve "$name"
                           ;;
                         *)
                           echo "skipping $name ($signer)"
                           ;;
                       esac
                     done
   ```

4. **限制影响范围。** 一个“批准每个 CSR”的脚本实际上是 `cluster-admin`，因为恶意的 Pod 可以提交一个 CSR，使其获得任意身份。始终按签名者进行过滤，并且理想情况下还要按 CSR 的请求者 (`.spec.username`) 进行过滤，以便仅服务于已知的良好帐户。

5. **审计。** 开启 CSR 审计事件，并确认 Job 执行的每个批准都对应于一个真实的节点。上面的 `ttlSecondsAfterFinished` 确保旧的 Job Pod 被清理；一个单独的 `Succeeded` 阶段的清理程序是多余的。

## 诊断步骤

列出待处理的 CSRs 及其签名者：

```bash
kubectl get csr \
  -o custom-columns='NAME:.metadata.name,SIGNER:.spec.signerName,REQUESTOR:.spec.username,AGE:.metadata.creationTimestamp' \
  | sort -k4
```

仅待处理的条目：

```bash
kubectl get csr -o json \
  | jq -r '.items[] | select(.status.conditions == null)
           | "\(.metadata.name)\t\(.spec.signerName)\t\(.spec.username)"'
```

应用 CronJob 后，观察第一次运行并确认仅批准预期的签名者：

```bash
kubectl -n csr-approver get jobs --watch
kubectl -n csr-approver logs job/$(kubectl -n csr-approver get jobs -o jsonpath='{.items[-1].metadata.name}')
```

检查审计日志以验证 ServiceAccount 使用了 `approval` 子资源而没有其他操作。如果 Job 开始批准不应批准的 CSRs，请移除 `signers` resourceNames 条目并缩小 Job 内的 `case` 过滤 — 两个检查必须通过，批准才能生效。

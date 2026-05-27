---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500248
sourceSHA: 69ad4aae84e1aab0fae5fbdfe9146d7621856ace5b636dd863cb538f11847d93
---

# Kubelet CSR 在签名控制器未发放时卡在已批准状态

## 问题

当节点的 kubelet 客户端证书过期时，kubelet 通过 CertificateSigningRequest API 进行续订，生成的请求会在 `kubectl get csr` 中显示。在 Alauda Container Platform（Kubernetes 服务器 `v1.34.5`）上，CSR API 是标准的上游 `certificates.k8s.io/v1` 组：`csr` 资源是集群范围的，可以直接使用 `kubectl get csr` 列出。

在受影响的状态下，这些请求中的一个或多个保持在 `Approved` 状态，并且从未进展到 `Approved,Issued`。列出请求直接显示了卡住的状态：

```bash
kubectl get csr
```

```text
NAME          AGE   SIGNERNAME                      CONDITION
csr-sqgzp     5m    kubernetes.io/kubelet-serving   Approved
```

## 根本原因

CSR 的 `status.certificate` 字段仅在存在 `Approved` 状态后由签名者填充；在签名未发出时，请求在 `kubectl get csr` 的 CONDITION 列中继续显示为 `Approved`。一旦签名控制器发出证书，同一请求将显示为 `Approved,Issued`。因此，已批准但状态为空的请求表明签名者尚未采取行动。

签名者是 `kube-controller-manager` 中的 `csrsigning` 控制器。控制器管理器以 `--controllers=*,bootstrapsigner,tokencleaner` 运行，其中 `*` 启用默认的 `csrapproving` 和 `csrsigning` 控制器，签名者通过 `--cluster-signing-cert-file` 和 `--cluster-signing-key-file` 连接到 CA；发放的证书使用配置的 `--cluster-signing-duration` 生命周期。当已批准的 CSR 未达到 `Approved,Issued` 时，根本原因是该签名控制器未发放请求的证书，这导致已批准但未发放请求的积压不断增加。

在该积压存在期间，依赖新发放节点证书的下游工作负载可能无法启动，直到其请求被签名。

## 诊断步骤

确认 kubelet 续订请求是否已到达 apiserver，并检查其状态；在稳定状态下，列表为空，因此任何停留在 `Approved` 的请求都是调查的信号：

```bash
kubectl get csr
```

通过列出控制器管理器 Pod 来检查签名者的健康状况。在 Alauda Container Platform 上，`kube-controller-manager` 作为静态 Pod 在 `kube-system` 命名空间中运行，便携式过滤器可以直接显示它：

```bash
kubectl get pods -n kube-system | grep controller
```

```text
kube-controller-manager-192.168.135.152   1/1   Running
```

一个 `Running` 的控制器管理器 Pod 与卡在 `Approved` 状态的 CSR 配对，指向 `csrsigning` 控制器未能发放，而不是 Pod 停止运行。

## 解决方案

识别待处理的 kubelet 请求，然后批准它，以便通知签名控制器发放证书：

```bash
kubectl get csr
kubectl certificate approve <csr-name>
```

批准请求指示证书签名控制器发放证书，使用上述相同的 `csrsigning` 机制；健康的签名者随后将请求从 `Approved` 移动到 `Approved,Issued` 并填充 `status.certificate`。重新运行 `kubectl get csr` 确认状态转换：

```bash
kubectl get csr
```

```text
NAME          AGE   SIGNERNAME                      CONDITION
csr-sqgzp     7m    kubernetes.io/kubelet-serving   Approved,Issued
```

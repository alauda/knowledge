---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500621
sourceSHA: 616cd2ccdb31bf5803dbfaa8c8b054d5039172b2179cc2d17ffa9cf256fe995b
---

# Tempo 管理的 Pod 在 ACP 上因 operator 发布的证书过期而流传 expired-cert TLS 错误

## 问题

在 Alauda Container Platform (kubernetes v1.34.5, ACP 安装包 `bundle-versions-v4.3.0`) 上，由 Tempo operator 管理的堆栈部署的追踪组件在其挂载的 `kubernetes.io/tls` Secrets 中携带的 operator 发布的服务证书超过其 `not-after` 时间戳后，会持续流传 TLS 握手失败。此类 Kubernetes TLS Secret 在其 base64 编码的 `tls.crt` 字段中嵌入一个 x509 证书，其 `not-before` / `not-after` 有效期窗口可以直接从 ACP 上的 Secret 读取，具有相同的上游类型和 PEM 形状。当此类 Pod 内的工作负载在 `not-after` 过期后在 TLS 握手中呈现该证书时，对等方的 golang TLS 堆栈会拒绝握手，并显示由 `crypto/tls` / `crypto/x509` 标准库发出的标准 `x509: certificate has expired or is not yet valid` 错误字符串——在任何发行版上均保持不变。

## 根本原因

长时间运行的服务器进程在进程启动时从挂载的 Secret 中读取其服务证书，但它们本身并不会观察到该 Secret 的就地轮换——它们持续呈现最初加载的证书材料。然而，在 Pod 重新创建时，kubelet 会在卷挂载时从 API 服务器重新读取引用的 Secret，因此新创建的 Pod 会从底层 Secret 对象加载当前（已轮换的）`tls.crt` 内容。过期握手错误本身仍然是 stdlib golang `x509: certificate has expired or is not yet valid` 形式，因此当 ACP 上发生相同条件时，它保持不变。

## 解决方案

触发受影响的追踪组件的 Pod 级别重启，以便 kubelet 在重新创建的 Pods 上重新挂载引用的 Secret，并在挂载时从 API 服务器加载轮换的证书材料。通过一个针对 operator 管理工作负载的标签选择器删除受影响的 Pods 允许拥有控制器重新创建它们，之后新 Pods 在其卷挂载期间从 API 服务器读取当前的 `tls.crt`，并且针对轮换证书的握手错误停止出现。

## 诊断步骤

列举部署追踪堆栈的命名空间中的候选 TLS secrets——`kubernetes.io/tls` 类型的 Secrets 在 ACP 上遵循标准上游形状，因此一个普通的 `kubectl get secret` 列表会显示它们，简单的 `grep tls` 可以缩小列表：

```bash
kubectl get secret -n <tempo-namespace> | grep tls
```

对于每个候选项，转储 Secret 为 YAML 并读取其嵌入的有效期窗口——`not-before` / `not-after` 在编码的证书中存在，并且可以通过相同的 `kubectl get secret -o yaml` 管道在 ACP 上访问，因为 Secret 类型和 PEM 形状与上游 Kubernetes 保持不变：

```bash
kubectl get secret -n <tempo-namespace> <secret-name> -o yaml
```

当有效期窗口在 YAML 中不可直接看到时，使用 `base64 -d | openssl x509 -noout -dates` 解码 `tls.crt` 字段；从证书读取的日期确认当前挂载到 Tempo 管理的 Pods 中的 Secret 是否已过期。交叉检查受影响 Pod 的日志以查找标准 golang TLS 错误字符串——`x509: certificate has expired or is not yet valid` 形式是接收方在条件生效后打印的内容：

```bash
kubectl logs -n <tempo-namespace> <pod-name> | grep -E 'expired|has expired'
```

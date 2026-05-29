---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500589
sourceSHA: 0593e0d5ab980c7053aa6a78b662ca9b8bd420ca8d71e4b8a951733ed04e6c89
---

# ALB 默认 SSL 证书在 PEM 包格式错误时无法加载

## 问题

在 Alauda 容器平台上，平台负载均衡器是 ALB2 实例（`alaudaloadbalancer2.crd.alauda.io`），其 `spec.config.defaultSSLCert` 字段指向一个类型为 `kubernetes.io/tls` 的 Kubernetes Secret，包含 `tls.crt` 和 `tls.key`。在用新生成的通配符或 SAN 证书包替换该默认 TLS Secret 后，使用 ALB 默认 SSL 证书的组件在启动时可能会记录 Go `x509` / `crypto/tls` PEM 解析错误——尽管在文本编辑器中看起来正确，但该证书包在结构上是无效的。数据平面运行在基于 nginx 的引擎上（在 Kubernetes v1.34.5 集群的 `cpaas-system` 命名空间中，`alb-nginx:v4.3.1` 和 `alb2:v4.3.1`），而消费代码路径是 Go 的标准 `encoding/pem` 和 `crypto/tls`，因此任何解析相同 Secret 的 Go 组件都会通过相同的解析器拒绝相同的格式错误输入。

## 根本原因

`kubernetes.io/tls` Secret 中的 PEM 包的 `tls.crt` 预期是按固定顺序连接的证书：首先是叶子（通配符或 SAN）证书，然后是任何中间 CA 证书，最后是根 CA。Go 的 `encoding/pem` 解析器对块框架要求严格：一个块的 `-----BEGIN <type>-----` 和 `-----END <type>-----` 标记如果被压缩到同一行——例如由于复制粘贴而去掉了它们之间的换行——则根本不被识别为 PEM 块，证书或密钥会在解析器的视图中被静默丢弃。文件末尾的非 PEM 字节对最后一个块有相同的影响：当一个 shell 提示意外地被捕获到文件中，使得最后一行变为 `-----END CERTIFICATE-----[user@host ~]$` 而不是单独的 `-----END CERTIFICATE-----` 时，终止标记不再匹配，加载器会拒绝该输入。在多块包中，连续的 PEM 块之间应恰好用一个空行分隔，文件末尾不得有空行。

## 解决方案

重建 Secret，使 `tls.crt` 持有通配符或 SAN 叶子证书，然后是任何中间 CA，最后是根 CA，顺序如上；`tls.key` 必须持有与之匹配的私钥，格式为可识别的 `-----BEGIN ... PRIVATE KEY-----` 块（例如 PKCS#1 RSA 密钥的 `RSA PRIVATE KEY`，或 PKCS#8 密钥的 `PRIVATE KEY`）。每个块的 `-----BEGIN`/`-----END` 标记必须单独占一行，块之间必须恰好用一个空行分隔，文件末尾不得有 `-----END CERTIFICATE-----` 后的多余字节。

在 ALB 的命名空间中重新创建 Secret，并将 `spec.config.defaultSSLCert` 指向它。手中有清理后的文件（`tls.crt` 和 `tls.key`）：

```bash
kubectl -n cpaas-system create secret tls <secret-name> \
  --cert=tls.crt --key=tls.key \
  --dry-run=client -o yaml | kubectl apply -f -
```

该 Secret 包含类型为 `kubernetes.io/tls` 的 `tls.crt` 和 `tls.key`；ALB2 CR 通过 `spec.config.defaultSSLCert` 以 `namespace/name` 的形式引用它（例如 `cpaas-system/<secret-name>`），该引用形状在运行 `alb2:v4.3.1` 和 `alb-nginx:v4.3.1` 的实时 ALB 实例上得到了验证。

## 诊断步骤

从 Secret 中提取当前的 `tls.crt` 并检查其框架。第一行必须是 `-----BEGIN CERTIFICATE-----`，最后一行非空行必须是 `-----END CERTIFICATE-----`，且没有多余的提示字节；在同一行上压缩的 BEGIN/END 标记是最常见的缺陷：

```bash
kubectl -n cpaas-system get secret <secret-name> \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > /tmp/tls.crt
head -1 /tmp/tls.crt
tail -1 /tmp/tls.crt
grep -c '^-----BEGIN CERTIFICATE-----$' /tmp/tls.crt
grep -c '^-----END CERTIFICATE-----$' /tmp/tls.crt
```

两个 `grep -c` 的计数必须相等，并且必须与包中的证书数量（叶子 + 中间 + 根）匹配；仅有叶子的自签名包计数为 1，而叶子加一个中间加根的计数为 3。连续的块之间必须恰好用一个空行分隔，文件末尾不得有空行。

验证私钥块。`tls.key` 负载的第一行必须是以 `-----BEGIN ... PRIVATE KEY-----` 结尾的标记，且以 `PRIVATE KEY` 结束——这是 Go 的 `crypto/tls` 加载器在定位密钥块时匹配的确切子字符串；一个仅包含 `CERTIFICATE` 块而没有 `PRIVATE KEY` 块的密钥输入文件会导致 PEM 解析器的“查找以 PRIVATE KEY 结尾的 PEM 块”失败：

```bash
kubectl -n cpaas-system get secret <secret-name> \
  -o jsonpath='{.data.tls\.key}' | base64 -d > /tmp/tls.key
head -1 /tmp/tls.key
tail -1 /tmp/tls.key
```

一旦框架清晰，且 `tls.key` 包含与叶子证书的密钥形状匹配的以 `PRIVATE KEY` 结尾的块（在验证的 Secret 上为 RSA），使用 `kubectl create secret tls --dry-run=client -o yaml | kubectl apply -f -` 重新创建 Secret，并确认 ALB2 CR 的 `spec.config.defaultSSLCert` 仍然解析为 `<namespace>/<secret-name>`。

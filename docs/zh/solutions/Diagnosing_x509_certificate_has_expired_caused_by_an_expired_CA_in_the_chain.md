---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500267
sourceSHA: 1f34977eeb14116d236259ffbcdfded4ee92ccac09d8ba750f634437ce0624e0
---

# 诊断因链中过期CA导致的"x509证书已过期"问题

## 问题

即使叶子（服务器）证书仍在有效期内，TLS客户端仍报告`certificate has expired`。在Alauda Container Platform节点（kube-apiserver Server v1.34.5）上，故障表现为`x509: certificate has expired or is not yet valid: current time ... is after 2021-01-01`，这是来自Go的`crypto/x509`，或者在TLS告警`certificate expired (557)`后表现为curl退出代码60和`SSL certificate problem: certificate has expired`；在每种情况下，错误都归因于链，而不是仍然有效的叶子证书。这个措辞具有误导性，因为客户端连接的叶子证书并不是过期的证书——而是信任路径中更高层的CA。

## 根本原因

x509链验证要求链中的每个证书都必须当前有效，因此即使叶子证书尚未达到其`notAfter`日期，过期的中间CA或根CA也会导致验证失败。具体症状是服务器仅呈现叶子证书，而本地机器依赖于完成链的中间CA或根CA已过期、无效或缺失。在`openssl verify`和`openssl s_client`下，这表现为`verify error:num=10:certificate has expired`（`X509_V_ERR_CERTIFICATE_HAS_EXPIRED`），在非零深度（深度1，CA）报告，而深度0（叶子）则验证通过。

## 解决方案

由于链验证要求路径中的每个证书都必须当前有效，因此只有当整个链——叶子及每个中间和根证书——都有效时，故障才会消除；路径中的过期CA会保持错误，即使叶子仍在其有效期内。因此，解决方案首先是诊断：使用以下步骤识别呈现链中哪个证书已过期，然后确保提供该证书的源呈现或信任一个完全有效的链。

对于存储在Kubernetes TLS秘密中的服务证书（Alauda Container Platform提供cert-manager，服务证书秘密如`base-api-cert`位于`cpaas-system`命名空间），从秘密中提取证书并直接检查其日期。读取秘密中的`tls.crt`条目，进行base64解码，并输入`openssl x509 -dates`，该命令打印证书的`notBefore`/`notAfter`，以便操作员确认其是否已过期：

```bash
kubectl get secret <tls-secret> -n <namespace> \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | \
  openssl x509 -dates -subject -noout
```

由于`openssl x509`仅解析多证书PEM中的第一个证书，因此打印的日期仅反映一个证书；要检查捆绑中的每个证书的日期，首先通过将`openssl crl2pkcs7`的输出管道传输到`openssl pkcs7 -print_certs`来枚举完整集合，然后检查每个证书：

```bash
openssl crl2pkcs7 -nocrl -certfile <bundle.pem> | \
  openssl pkcs7 -print_certs -noout
```

## 诊断步骤

检查服务器呈现的每个深度的验证结果，以找到过期证书在链中的位置。`openssl s_client -connect <host>:<port> -showcerts`打印`verify error:num=10:certificate has expired`，并根据发生的深度进行标记，因此非零深度可以精确定位哪个CA——而不是深度0的叶子——是过期证书：

```bash
openssl s_client -connect <host>:<port> -showcerts
```

区分服务器实际发送的内容与本地信任存储提供的内容。服务器呈现的证书在`openssl s_client`输出中的`Certificate chain`索引（`0`，`1`，...）下出现；参与验证但不在该索引列表中的证书是由本地信任存储提供的，而不是由服务器提供的。

确定要检查哪些本地信任存储文件。`curl -v`打印客户端使用的CAfile和CApath，命名本地信任存储的位置，以搜索过期CA：

```bash
curl -v https://<host>/
```

排除路径中的TLS终止中介。如果`curl --noproxy '*' -v <url>`成功，而代理请求因`certificate has expired`失败，则中间网络设备——TLS终止代理或负载均衡器——正在呈现其自己的过期证书：

```bash
curl --noproxy '*' -v https://<host>/
```

一旦找到候选证书，使用`openssl x509 -dates -subject -noout`（或`-enddate`）确认其日期，该命令打印其`notBefore`/`notAfter`和主题，以便在续订之前确认过期的CA。

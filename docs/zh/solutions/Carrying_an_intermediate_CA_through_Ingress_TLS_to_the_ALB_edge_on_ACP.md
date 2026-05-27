---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500187
sourceSHA: 0a52789cbe26b2838928d52db15c346465ad82005fce6780be94a3d78c2bc881
---

# 通过 Ingress TLS 将中间 CA 传递到 ALB 边缘的 ACP

## 问题

在 Alauda 容器平台（Kubernetes `v1.34.5`，ALB2 `v4.3.1` 在 `cpaas-system` 中运行，IngressClass 为 `global-alb2`，控制器为 `cpaas.io/alb2`）上，基于 `kubernetes.io/tls` Secret 的 HTTPS Ingress 在 ALB 边缘终止，ALB 向客户端呈现的证书链完全由 Secret 的 `tls.crt` 和 `tls.key` 决定。当颁发 CA 是中间 CA 时，仅信任根 CA 的客户端会看到链验证错误，因为边缘默认不将 Secret 中的其他密钥附加到提供的链中。

## 根本原因

`networking.k8s.io/v1` Ingress API 仅在每个 `spec.tls[*]` 条目下公开 `hosts` 和 `secretName`；在 Ingress 层没有 `caCertificate`、`caBundle` 或类似字段可以传递中间 CA。ACP 上的相同结构意味着 Ingress 对象本身没有承载 CA 材料的载体——任何 CA 包必须在引用的 Secret 内部传递。`kubectl create secret tls` 命令仅显示 `--cert` 和 `--key` 用于证书材料，因此仅使用 CLI 无法将单独的 CA 条目放入 Secret。在服务端，ALB 前端资源仅公开一个用于 HTTPS 的 `certificate_name` 引用，并且没有单独的 CA-bundle 字段，这将导致引用的 Secret 中的 `ca.crt` 键附加到提供的链中。

## 解决方案

通过将中间 CA PEM 连接到叶证书文件中，将中间 CA 传递给客户端，以便在创建 Secret 之前，Secret 的 `tls.crt` 包含完整链（先是叶证书，然后是中间证书）；这符合上游 Ingress 合同，并且是 ALB 边缘作为证书链提供的内容。

构建完整链 PEM 并使用 `kubectl` 创建 Secret（请注意，CLI 仅接受证书和密钥路径）：

```bash
cat leaf.crt intermediate.crt > fullchain.crt

kubectl -n <app-namespace> create secret tls my-tls \
  --cert=fullchain.crt \
  --key=leaf.key
```

如果 Secret 中还需要 `ca.crt` 条目（例如，对于挂载 Secret 并读取 `ca.crt` 以供其自己的信任存储的工作负载），请将 Secret 作为 YAML 清单编写，将 `ca.crt` 放在 `.data` 下，与 `tls.crt` 和 `tls.key` 一起，然后应用它；这是填充 `ca.crt` 的唯一途径，因为 `kubectl create secret tls` 标志表面没有等效选项：

```yaml
apiVersion: v1
kind: Secret
type: kubernetes.io/tls
metadata:
  name: my-tls
  namespace: <app-namespace>
data:
  tls.crt: <base64 of leaf+intermediate PEM>
  tls.key: <base64 of private key PEM>
  ca.crt: <base64 of CA PEM>
```

在 Ingress 中引用 Secret，位于 `spec.tls[*].secretName` 下；那里仅接受 `hosts` 和 `secretName`，因此不需要或没有其他 Ingress 侧字段来承载 CA：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: <app-namespace>
spec:
  ingressClassName: global-alb2
  tls:
    - hosts:
        - app.example.com
      secretName: my-tls
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-app
                port:
                  number: 8080
```

由于 `cpaas-system` 中的 ALB 前端仅携带用于 HTTPS 的 `certificate_name`，并且没有单独的 CA-bundle 字段，因此 Secret 的 `tls.crt` 中的完整链是提供的链——仅在其信任存储中包含根 CA 的客户端可以通过嵌入的中间 CA 构建链。

## 诊断步骤

在调试客户端信任错误之前，检查 Secret 实际携带的内容；`.data` 下存在的键是平台看到的，只有 `tls.crt` + `tls.key` 参与 ALB 边缘呈现的内容：

```bash
kubectl -n <app-namespace> get secret my-tls \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl crl2pkcs7 -nocrl \
  -certfile /dev/stdin | openssl pkcs7 -print_certs -noout
```

输出应列出叶证书后跟中间证书；如果只有单个证书，则表示链未连接到 `tls.crt` 中，提供的链仅为叶证书。从客户端的角度确认相同，通过获取 ALB 在 Ingress 主机名上提供的链：

```bash
echo | openssl s_client -connect app.example.com:443 -servername app.example.com -showcerts 2>/dev/null | \
  openssl crl2pkcs7 -nocrl -certfile /dev/stdin | openssl pkcs7 -print_certs -noout
```

如果在重建 `tls.crt` 后提供的链仍然仅为叶证书，请验证 Ingress 是否通过 `spec.tls[*].secretName` 指向更新的 Secret（这是 Ingress 侧 TLS 字段中唯一的字段，除了 `hosts`），并重新创建 Secret，以便 ALB 获取新的 `tls.crt` 内容。

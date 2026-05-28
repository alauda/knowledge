---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500402
sourceSHA: a00ecebb8b179cc0264566befbdeac8d508566dd63899e867bf179233cc02a1f
---

# HTTP/2 连接合并导致浏览器请求错误的工作负载在 ALB 后面

## 问题

在运行 `alauda-alb2` chart `v4.3.1`（镜像 `registry.alauda.cn:60080/acp/alb2:v4.3.1` 和 `registry.alauda.cn:60080/acp/alb-nginx:v4.3.1`）的 Alauda Container Platform（Kubernetes `v1.34.5`）集群中，两个或多个应用程序在不同的主机名下通过相同的 ALB 发布，并共享一个通配符 TLS 证书（例如，`*.apps.example.com` 的 SAN 覆盖了 `a.apps.example.com` 和 `b.apps.example.com`）。在浏览器成功加载第一个应用程序后，后续导航到同一通配符覆盖的其他主机名要么呈现第一个应用程序的内容，要么返回 `页面未找到` 错误，而不是预期的工作负载。

当每个应用程序在一个新的、隔离的浏览器会话中打开时，或者当 Chrome 使用 `--disable-http2` 标志启动时，这个流程可以正常工作——每个主机名都会呈现其各自的预期内容。这种间歇性的浏览器端行为，限于共享通配符证书的主机名，是 HTTP/2 连接合并的可见指纹。

## 根本原因

RFC 7540 §9.1.1（“连接重用”）允许已经打开安全 HTTP/2 连接的客户端重用该连接进行任何后续请求，只要其 URI 权限由原始连接上呈现的证书覆盖。重用的条件是协商的协议为 HTTP/2——HTTP/1.1 没有等效的重用语义，因此合并表面仅在 TLS ALPN 交换期间同意 `h2` 后存在。

根据 RFC 6125 §6.4.3，通配符 SubjectAltName 如 `*.apps.example.com` 对于 `apps.example.com` 下的每个单标签主机都是有效的。从浏览器的角度来看，原始证书因此对 `a.apps.example.com` 和 `b.apps.example.com` 都是“有效的”，因此对第二个主机名的导航被发送到第一个请求的 SNI 选择的上游的现有 HTTP/2 流，而不是 DNS 对第二个主机名的解析所指向的工作负载。

ALB 数据平面在其 `https` 前端终止 TLS，并与客户端协商 HTTP/2（运行的 ALB nginx 配置设置 `http2_max_concurrent_streams 128`），因此任何使用与另一个应用程序相同的通配符证书发布的 ALB 前端应用程序都可以是合并流的源或目标。

## 解决方案

为每个需要独立访问的 HTTP/2 应用程序绑定一个非通配符的、每个应用程序特定的证书。一旦每个主机名使用不同的证书提供，浏览器的重用前提条件（“证书对请求的 URI 有效”）在主机名之间不再成立，第二次导航强制建立新的 TLS 连接——因此新的 SNI 选择和新的上游——而不是重用第一个流。

在 ACP 中，这种绑定在两个地方表达，具体取决于哪个入口对象发布应用程序。对于 `Ingress` 对象，将 `spec.tls[].secretName` 设置为包含与此 Ingress 发布的主机名完全匹配的证书的 TLS `Secret`（不使用通配符）。对于 ALB `Rule`（`rules.crd.alauda.io`），将 `spec.certificate_name` 设置为 `https` 前端的每个主机证书，以便 ALB 向与此规则的主机匹配的客户端呈现该特定证书。

绑定主机名特定证书的 `Ingress` 示例片段：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
 name: app-a
 namespace: team-a
spec:
 tls:
 - hosts:
 - a.apps.example.com
 secretName: app-a-tls # cert SAN = a.apps.example.com (not a wildcard)
 rules:
 - host: a.apps.example.com
 http:
 paths:
 - path: /
 pathType: Prefix
 backend:
 service:
 name: app-a
 port:
 number: 80
```

对每个主机名重复使用不同的 `Secret`（`app-b-tls` 用于 `b.apps.example.com` 等）。`Secret` 本身是标准的 Kubernetes `kubernetes.io/tls` 秘密：

```bash
kubectl -n team-a create secret tls app-a-tls \
 --cert=./a.apps.example.com.crt \
 --key=./a.apps.example.com.key
```

对于通过 ALB 规则而不是 `Ingress` 发布的应用程序，使用 `Rule` CR 的 `spec.certificate_name` 将每个规则指向其自己的每个主机证书，位于 `https` 前端：

```yaml
apiVersion: crd.alauda.io/v1
kind: Rule
metadata:
 name: app-a-rule
 namespace: team-a
spec:
 certificate_name: team-a_app-a-tls # underscore-separated <namespace>_<secret>, matches ALB-rendered convention
 # ... domain, backend, etc.
```

重新绑定后，从新的浏览器标签页重新打开每个应用程序——第二次导航现在触发新的 TLS 握手（因此新的基于 SNI 的上游选择），而不是重用现有的 HTTP/2 流。

作为替代缓解措施，可以关闭集群范围内的 ALB HTTP/2 切换，以便数据平面永远不会向客户端提供 `h2` ALPN。因为只有在协商 HTTP/2 后才可能发生合并，从 ALB `https` 前端移除 HTTP/2 完全消除了前提条件，并使单个通配符证书在主机名之间可用。ALB2 CR（`alaudaloadbalancer2.crd.alauda.io`）在 `spec.config` 上公开了此切换的配置表面；在应用之前，请查阅 ALB CRD 的文档配置形状，以获取此 chart 版本上确切的字段形式，因为该切换是影响由同一 ALB 前端的每个应用程序的集群范围更改。

## 诊断步骤

通过在同一浏览器会话中按顺序打开受影响的 URL 来确定性地重现故障：加载 `https://a.apps.example.com`，然后导航到 `https://b.apps.example.com`。第二个主机名将呈现第一个应用程序的内容或其自己的 UI，而不是 `页面未找到`。

然后在客户端上重复相同的序列，禁用 HTTP/2。对于 Chrome，这意味着使用 `--disable-http2` 标志启动；对于 `curl`，这意味着在请求中强制使用 HTTP/1.1。下面的 `<alb-vip>` 占位符是 `cpaas-system` 中 ALB `Service` 的外部地址（例如 `kubectl get svc -n cpaas-system <alb-svc> -o jsonpath='{.status.loadBalancer.ingress[0].ip}'`）。如果每个主机名现在呈现其各自的预期内容，则故障是 HTTP/2 连接合并——通配符证书加上协商的 `h2` 连接是导致一个主机名的请求到达另一个主机名上游的唯一机制：

```bash
# 强制使用 HTTP/1.1 — 无 h2 ALPN，因此没有合并表面
curl -v --http1.1 --resolve a.apps.example.com:443:<alb-vip> \
 https://a.apps.example.com/
curl -v --http1.1 --resolve b.apps.example.com:443:<alb-vip> \
 https://b.apps.example.com/
```

通过检查 ALB 在两个主机名的 `https` 前端呈现的证书，确认共享证书前提条件，并检查 SAN 列表是否为覆盖两个主机名的通配符：

```bash
openssl s_client -connect <alb-vip>:443 -servername a.apps.example.com </dev/null 2>/dev/null \
 | openssl x509 -noout -text \
 | grep -A1 'Subject Alternative Name'
openssl s_client -connect <alb-vip>:443 -servername b.apps.example.com </dev/null 2>/dev/null \
 | openssl x509 -noout -text \
 | grep -A1 'Subject Alternative Name'
```

如果两个握手返回相同的通配符 SAN（例如 `DNS:*.apps.example.com`）并且正在使用 HTTP/2，则合并前提条件得到满足——将受影响的应用程序切换到每个主机证书，如解决方案中所述。

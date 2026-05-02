---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500007
sourceSHA: a0ee339d6af94e1e393efedaf759a678855077febf0023a48bafe21119413bea
---

## 概述

在集群中运行的应用程序越来越需要 TLS 以支持服务间的流量：网格边车、面向用户的网关、使用 `sslmode=verify-full` 的数据库驱动程序，以及禁止在 Pod 之间使用明文的合规性驱动政策。操作员希望这一过程是自动化的——每个服务颁发的证书，在到期前进行轮换，并且可以被其他工作负载信任，而无需手动分发 CA 包。

ACP 通过 **cert-manager** 实现这一目标。cert-manager 拥有 `Certificate` CRD 以及一组描述证书来源的 `Issuer` / `ClusterIssuer` 资源（内部 CA、HashiCorp Vault、ACME 端点等）。单个 `Certificate` 对象会变成一个包含 `tls.crt` / `tls.key` / `ca.crt` 的 `Secret`，应用程序将其挂载。

## 解决方案

工作流程是：选择一个颁发者，然后让 `Certificate` 资源驱动每个服务证书。

### 创建集群范围的内部 CA 颁发者

对于内部服务间的 TLS，集群内自签名 CA 是最简单的模式。它镜像了平台管理的“服务提供证书”操作员所做的事情，并为每个工作负载提供一个可以信任的 CA，而无需访问外部基础设施。

```yaml
# 1. 一次性自签名颁发者，仅用于生成 CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-bootstrap
spec:
  selfSigned: {}
---
# 2. 由引导颁发者签名的长期根证书
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: cluster-internal-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: cluster-internal-ca
  subject:
    organizations: [internal]
  duration: 87600h0m0s        # 10 年
  privateKey:
    algorithm: ECDSA
    size: 256
  secretName: cluster-internal-ca
  issuerRef:
    name: selfsigned-bootstrap
    kind: ClusterIssuer
---
# 3. 日常颁发者：使用上述根 CA 签署工作负载证书
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: cluster-internal
spec:
  ca:
    secretName: cluster-internal-ca
```

每个集群应用一次。每个后续的工作负载证书都引用 `cluster-internal`。

### 为服务颁发证书

在服务旁边创建一个 `Certificate`。DNS 名称应与集群内服务的地址匹配：

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: app-tls
  namespace: team-a
spec:
  secretName: app-tls                  # 生成的 Secret 包含 tls.crt / tls.key / ca.crt
  duration: 2160h0m0s                  # 90 天
  renewBefore: 720h0m0s                # 在到期前 30 天进行轮换
  dnsNames:
    - app.team-a.svc
    - app.team-a.svc.cluster.local
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: cluster-internal
    kind: ClusterIssuer
```

几秒钟内，cert-manager 会协调生成一个包含叶证书、私钥和颁发 CA 的 `Secret/app-tls`。轮换将在到期前的 `renewBefore` 自动进行；没有人工干预。

### 将证书挂载到 Pod 中

```yaml
spec:
  volumes:
    - name: tls
      secret:
        secretName: app-tls
        defaultMode: 0400
  containers:
    - name: app
      volumeMounts:
        - name: tls
          mountPath: /etc/tls
          readOnly: true
      env:
        - name: TLS_CERT
          value: /etc/tls/tls.crt
        - name: TLS_KEY
          value: /etc/tls/tls.key
```

如果您的运行时不支持热重载 TLS 材料，可以将挂载与像 `reloader` 这样的边车配对——它会监视 Secret 并在更改时执行滚动重启——而不是猜测 Pod 的缓存会保留旧证书多久。

### 让客户端信任 CA

只需分发一次 CA，所有需要与服务通信的工作负载都可以在没有额外配置的情况下验证其证书。

```bash
# 导出集群内 CA 包
kubectl -n cert-manager get secret cluster-internal-ca -o jsonpath='{.data.ca\.crt}' \
  | base64 -d > cluster-internal-ca.crt

# 作为 ConfigMap 分发到每个需要信任它的命名空间
kubectl -n team-a create configmap cluster-internal-ca \
  --from-file=ca.crt=cluster-internal-ca.crt
```

客户端挂载 ConfigMap，并将其 HTTP/SQL/gRPC 客户端指向该文件作为其信任锚。

### 为外部服务做计划

对于暴露在集群外的服务（公共 API、与第三方的 mTLS），将 `cluster-internal` ClusterIssuer 替换为基于 ACME 的颁发者（Let's Encrypt、ZeroSSL）或外部 PKI 桥。工作负载侧的 `Certificate` 对象保持不变——这也是 cert-manager 值得标准化的主要原因，而不是一次性证书脚本。

## 诊断步骤

检查 cert-manager 是否健康：

```bash
kubectl -n cert-manager get pod
kubectl get clusterissuer
kubectl get certificate -A
```

如果证书卡在 `Issuing` 状态：

```bash
kubectl -n team-a describe certificate app-tls
kubectl -n team-a get certificaterequest
kubectl -n cert-manager logs deploy/cert-manager --tail=200
```

确认生成的 Secret 包含所有三个密钥，并且 CA 链接到您的根 CA：

```bash
kubectl -n team-a get secret app-tls -o jsonpath='{.data.tls\.crt}' | base64 -d \
  | openssl x509 -noout -subject -issuer -dates
kubectl -n team-a get secret app-tls -o jsonpath='{.data.ca\.crt}'  | base64 -d \
  | openssl x509 -noout -subject
```

验证客户端是否能够使用分发的 CA 包实际验证证书：

```bash
kubectl -n team-a run curl --rm -it --image=curlimages/curl:8.10.1 \
  --restart=Never -- \
  sh -c 'curl --cacert /etc/ssl/ca.crt https://app.team-a.svc/healthz -v'
```

如果验证失败并出现 `self-signed certificate in certificate chain`，则 Pod 正在使用主机的默认信任存储，而不是您的 CA 包；确认客户端正在读取正确的 `--cacert` 路径，并且 ConfigMap 已正确挂载。

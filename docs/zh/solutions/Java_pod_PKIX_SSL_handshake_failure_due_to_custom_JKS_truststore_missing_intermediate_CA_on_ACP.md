---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500459
sourceSHA: 7b4f00583abf11d40d4936294104cacb50efe1d063b45e4cebe4387ec3de50e9
---

# Java pod PKIX SSL 握手失败，因自定义 JKS 信任库缺少中间 CA

## 问题

在 Alauda 容器平台上（在 ACP 基础安装包 `v4.3.5` 和 Kubernetes `v1.34.5` 上验证），一个 Java 工作负载 pod 无法与外部 HTTPS 端点进行出站 TLS 握手，JVM 堆栈跟踪显示 `javax.net.ssl.SSLHandshakeException`，并包裹 `sun.security.provider.certpath.SunCertPathBuilderException`，错误信息为 `unable to find valid certification path to requested target`。当 JVM 的活动 TrustStore 中没有信任锚能够链到对等方的服务器证书时，JDK 的默认 PKIX 证书路径构建器会发出此信息，并且在任何 JVM 上的表述都是相同的，无论调度器如何。

同一个 pod 可以通过容器内部的 `curl -v` 访问相同的端点，因此 DNS 解析、出站流量和任何 HTTP(S) 代理跳转都不是故障表面——故障仅限于 JVM 的 TrustStore 配置。相关的 JVM 是通过系统属性 `-Djavax.net.ssl.trustStore=<path>` 启动的（通常通过 `JAVA_TOOL_OPTIONS` 或 `JAVA_OPTS` 传递），这指示 JSSE 使用该文件作为对等证书验证的唯一密钥库，并忽略 JRE 的默认 `cacerts` 和操作系统 CA 包。ACP 不会注入 JVM 或重写此属性——JSSE 在容器的 JRE 内部启动时读取该值。

## 根本原因

`-Djavax.net.ssl.trustStore` 引用的自定义 JKS 文件不包含验证目标端点服务器证书所需的完整 CA 链。具体而言，JKS 缺少签署服务器证书的中间 CA 证书和/或相应的公共根 CA——例如，由 `DigiCert TLS RSA SHA256 2020 CA1` 中间 CA 提供服务的端点需要同时存在中间 CA 和根 CA 作为受信任的条目，当服务器在握手时未提供完整链时。

由于 JSSE 仅查询 `-Djavax.net.ssl.trustStore` 指定的密钥库，并忽略 JRE 打包的 `cacerts` 和节点的操作系统信任包，因此在此自定义 JKS 中缺失的 CA 不会被平台或基础镜像提供的任何内容弥补。JVM 无法构建回已知信任锚的链，PKIX 验证因 `unable to find valid certification path to requested target` 消息而中止。

## 解决方案

将缺失的公共 CA 证书——根 CA，以及在服务器未提供完整链时的中间 CA——添加到 JVM 使用的 JKS 文件中，然后将更新后的 JKS 重新交付到 pod 中，并重启工作负载，以便 JVM 在启动时重新读取 TrustStore。

JKS 文件通过作为卷挂载的 Kubernetes Secret 交付到 pod 中；Secret 的 `data.<jks-key>` 条目保存二进制 JKS（base64 编码），pod 通过 `spec.volumes[].secret.secretName` 引用它，并使用与 `-Djavax.net.ssl.trustStore` 传递的路径匹配的 `spec.containers[].volumeMounts[].mountPath`。这是 ACP 上标准的 Kubernetes Secret 作为卷的原语——不需要特定于平台的挂载形状。因此，更新 JKS 意味着用新的 JKS 文件内容重写 Secret 的 `data.<jks-key>` 条目。

从 Secret 中读取当前 JKS 到具有 `kubectl` 和 JDK 的工作站上的本地工作副本。`kubectl get secret ... -o jsonpath` 形式返回所选数据键的 base64 编码值，使用 `base64 -d` 解码为磁盘上的二进制 JKS：

```bash
kubectl get secret <secret-name> -n <namespace> \
    -o jsonpath='{.data.<jks-key>}' | base64 -d > truststore.jks
```

使用标准 JDK `keytool -import` 调用将缺失的根 CA 和（如有需要）缺失的中间 CA 附加到本地 JKS。标志 `-alias`、`-file`、`-keystore`、`-storepass` 和 `-noprompt` 是标准 JDK CLI，并在集群内外表现相同：

```bash
keytool -import -trustcacerts -noprompt \
    -alias digicert-global-root \
    -file digicert-global-root.pem \
    -keystore truststore.jks \
    -storepass <storepass>

keytool -import -trustcacerts -noprompt \
    -alias digicert-intermediate \
    -file digicert-intermediate.pem \
    -keystore truststore.jks \
    -storepass <storepass>
```

在将文件推回 Secret 之前，确认新别名已存在于 JKS 中：

```bash
keytool -list -v -keystore truststore.jks -storepass <storepass> \
    | grep -iE 'Alias name|Owner|SHA-?256'
```

用更新后的 JKS 文件重写 Secret 的 `data.<jks-key>` 条目。在 ACP 上，便携的形式是使用 `kubectl create secret generic --dry-run=client -o yaml` 渲染新的 Secret 清单，并使用 `kubectl replace` 应用它，这样在构建清单以包含其他键时，可以原子性地交换数据键，而不删除其他键：

```bash
kubectl create secret generic <secret-name> \
    --from-file=<jks-key>=truststore.jks \
    --dry-run=client -o yaml \
    | kubectl replace -n <namespace> -f -
```

重启 Java 工作负载 pod，以便 JVM 在启动时重新读取 TrustStore。JVM 在初始化期间仅加载 `-Djavax.net.ssl.trustStore` 指定的文件，因此正在运行的 pod 在其 JVM 进程重启之前不会获取新内容；对于由 Deployment 管理的工作负载，删除 pod（或滚动 Deployment）就足够了，因为控制器会重新生成它，并且 Secret 卷会重新投影更新的内容：

```bash
kubectl delete pod <java-pod-name> -n <namespace>
# 或，对于由 Deployment 管理的工作负载：
kubectl rollout restart deployment/<deployment-name> -n <namespace>
```

在新 pod 处于运行状态后，重复原始的出站 TLS 调用；JVM 现在在其活动 TrustStore 中找到缺失的 CA，PKIX 完成而没有 `unable to find valid certification path to requested target` 错误。

## 诊断步骤

首先确认故障仅限于 JVM 的 TrustStore，而不是网络连接。从同一 pod 内部，运行 `curl -v` 访问失败的端点，并与 Java 客户端行为进行比较；当 `curl` 完成 TLS 握手而 Java 应用程序仍然引发 PKIX `unable to find valid certification path to requested target` 时，故障在 JVM 端，而不是网络路径：

```bash
kubectl exec -it -n <namespace> <java-pod-name> -- \
    curl -v https://<external-endpoint>/
```

识别 JSSE 实际使用的 JKS 文件路径。JVM 在启动时记录其系统属性，通过 grep pod 的 stdout 查找字面标记 `-Djavax.net.ssl.trustStore` 可以揭示 JSSE 正在读取的路径（通常在 OpenJDK 启动时发出的 `Picked up JAVA_TOOL_OPTIONS:` 横幅中可见）：

```bash
kubectl logs -n <namespace> <java-pod-name> \
    | grep -i 'javax.net.ssl.trustStore'
```

通过读取 pod 的 `spec.volumes[]` 和 `spec.containers[].volumeMounts[]` 进行交叉检查，确保路径解析为一个由 Secret 支持的卷；与 JKS 路径匹配的 `mountPath` 表示承载密钥库的 Secret：

```bash
kubectl get pod <java-pod-name> -n <namespace> -o yaml \
    | grep -E 'secretName:|mountPath:|name:' -A1
```

列出当前被 JVM 信任的密钥库条目。使用 `kubectl exec -it` 进入 pod 的容器（这是相同操作的通用 Kubernetes 动词），然后在上述识别的 JKS 路径上运行 `keytool -list -v`，并过滤以查找相关的 CA——例如，目标端点的服务器证书链到的公共根 CA 或中间 CA：

```bash
kubectl exec -it -n <namespace> <java-pod-name> -- /bin/sh
# 在容器内部：
keytool -list -v -keystore <jks-path> -storepass <storepass> \
    | grep -iE 'Alias name|Owner|Issuer' \
    | grep -i '<CA-name-fragment>'
```

如果预期的根 CA 或中间 CA 未出现在 JKS 列表中，则诊断得到确认：活动 TrustStore 不包含所需的信任锚以链到对等证书，解决方案（导入缺失的 CA，替换 Secret，重启 pod）适用。

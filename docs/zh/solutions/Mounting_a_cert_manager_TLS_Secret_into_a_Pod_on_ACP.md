---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x
id: KB260500159
sourceSHA: ef8563bb9723b410bb24682f73afe843f8db2d66fe56e13f2cac2e316d1148ab
---

# 在 ACP 中将 cert-manager TLS Secret 挂载到 Pod

## 问题

在运行 Kubernetes v1.34.5 的 Alauda Container Platform 上，使用 cert-manager 控制器镜像 `registry.alauda.cn:60080/3rdparty/cert-manager-controller:v1.17.18-v4.3.1`（命名空间 `cert-manager`），一个工作负载需要使用存储在 `kubernetes.io/tls` Secret 中的服务器证书和私钥来提供 TLS 服务。标准的组成是一个 cert-manager `Certificate`，其 `spec.secretName` 指定目标 Secret 的名称，以及一个将该 Secret 挂载为只读卷的 Pod（或 Deployment），以便应用程序从已知目录读取 `tls.crt` 和 `tls.key`。

## 解决方案

声明一个 cert-manager `Certificate`，并让其 `spec.secretName` 字段指定目标 Secret；控制器生成一个类型为 `kubernetes.io/tls` 的 Secret，其中填充了颁发的私钥和签名证书，使用常规的 `tls.crt` / `tls.key` 键。集群中现有的 Secrets 已经遵循这种结构——例如，`acp-storage-operator` 命名空间中的 `acp-storage-operator-service-cert` 具有类型 `kubernetes.io/tls`，并暴露工作负载所期望的两个键形式。

定义一个 Issuer（或使用现有的 `ClusterIssuer`），然后创建指向它的 `Certificate`。一旦请求被签名，Secret 就会生成，具有规范的 TLS 布局：

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: app-server-tls
  namespace: my-app
spec:
  secretName: app-server-tls
  duration: 2160h
  renewBefore: 360h
  commonName: app.my-app.svc
  dnsNames:
    - app.my-app.svc
    - app.my-app.svc.cluster.local
  issuerRef:
    name: my-issuer
    kind: Issuer
    group: cert-manager.io
```

通过声明一个引用 `secretName` 的 `secret` 卷，并使用 `volumeMount` 将密钥放置在容器内的可预测目录中，将生成的 Secret 以只读方式挂载到工作负载中。然后，应用程序从该挂载路径读取 `tls.crt` 和 `tls.key`，并直接提供 TLS 服务：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-server
  namespace: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: app-server
  template:
    metadata:
      labels:
        app: app-server
    spec:
      containers:
        - name: app-server
          image: <your-app-image>
          ports:
            - containerPort: 8443
          volumeMounts:
            - name: tls
              mountPath: /etc/tls
              readOnly: true
      volumes:
        - name: tls
          secret:
            secretName: app-server-tls
```

然后，应用程序被配置为从 `/etc/tls/tls.crt` 加载其服务器证书，从 `/etc/tls/tls.key` 加载其私钥。当 cert-manager 轮换证书时，它会重写相同的 Secret，kubelet 会在不重启 Pod 的情况下刷新挂载路径中的投影文件——但只有磁盘上的文件会自动更新。运行的进程是否实际提供新证书取决于应用程序：一个监视文件并热重载（或每个连接重新读取它们）的进程会自行获取轮换，而一个在启动时只读取一次 `tls.crt` / `tls.key` 的进程则会在内存中继续使用旧证书，直到它被重启。对于没有热重载的应用程序，计划在每次轮换后重启或滚动工作负载。还有两个进一步的注意事项：kubelet 刷新不是瞬时的——投影 Secret 卷在 kubelet 同步间隔加上缓存传播延迟后更新，因此预计在 Secret 更改和文件更新之间有大约一分钟的堆积量——并且通过 `subPath` 挂载的 Secret 完全**不会**接收更新，因此如果依赖于就地轮换，请挂载整个卷（如上所示），而不是 `subPath`。

## 诊断步骤

确认目标 Secret 以预期的 `kubernetes.io/tls` 类型生成，并且包含两个标准键。Secret 名称必须与 `Certificate.spec.secretName` 匹配；其 `type` 列必须显示为 `kubernetes.io/tls`，数据部分必须列出 `tls.crt` 和 `tls.key`：

```bash
kubectl -n my-app get secret app-server-tls
kubectl -n my-app get secret app-server-tls -o jsonpath='{.type}'
kubectl -n my-app get secret app-server-tls -o jsonpath='{.data}' | tr ',' '\n'
```

如果 Secret 缺失，请检查 `Certificate` 对象——控制器在其 `status.conditions[]` 中记录进度，Secret 仅在请求被签名后创建：

```bash
kubectl -n my-app get certificate app-server-tls
kubectl -n my-app describe certificate app-server-tls
```

一旦 Pod 运行，验证密钥是否投影到预期目录，并且文件模式是否可被容器的用户读取：

```bash
kubectl -n my-app exec deploy/app-server -- ls -l /etc/tls
```

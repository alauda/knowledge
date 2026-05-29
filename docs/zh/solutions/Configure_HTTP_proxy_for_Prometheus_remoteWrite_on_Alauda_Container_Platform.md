---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500531
sourceSHA: ed81313d756fabbc7dc20bfae593c1389383245db9f0a89da0e1155dfb94d3be
---

# 在 Alauda 容器平台上为 Prometheus remoteWrite 配置 HTTP 代理

## 问题

在 Alauda 容器平台 (ACP 安装包 `v4.3.4`) 中，kube-prometheus chart（helm chart 版本 `v4.3.3`，标签 `chart=prometheus-0.0.50`）渲染了集群内监控的 Prometheus CR `cpaas-system/kube-prometheus-0`，其 `spec.remoteWrite[]` 直接携带了上游 prometheus-operator 的 `RemoteWriteSpec` 架构。所提供的 `prometheus-operator` 版本为 `v0.91.0`，驱动的 Prometheus 容器为 `prometheus:v3.11.3` (>= v2.43.0)，因此每个 `remoteWrite[]` 条目上都有两个不同的代理控制字段：一个是字面量的 `oauth2.proxyUrl`，另一个是环境驱动的 `oauth2.proxyFromEnvironment` / `oauth2.noProxy` 对。通过 HTTP 转发代理路由 remote-write 流量的操作员需要明确的规则来决定设置哪个字段，以及每个字段在流量实际通过代理之前需要哪些额外的配置。

## 根本原因

这两个字段编码了指定代理的不同方式。`oauth2.proxyUrl` 是一个 CRD 级别的 `string`，其描述为“proxyUrl 定义要使用的 HTTP 代理服务器”——该架构接受作为字面字符串的显式代理 URL，且该字段本身不进行环境插值。`oauth2.proxyFromEnvironment` 是一个较新的布尔值——其 CRD 描述将其命名为读取容器环境中的 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 的切换开关，并且同样的描述明确指出“它需要 Prometheus >= v2.43.0”的前提条件，而兄弟字段 `proxyUrl` 并不需要，确认了 `proxyFromEnvironment` 是两个字段中较新的一个，并且在其引入之前的 prometheus-operator 版本中仅有字面量的 `proxyUrl` 可用。根据同一 CRD 描述，当 `proxyFromEnvironment` 为 true 时，该字段指示 Prometheus 容器查阅 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 环境变量，因此它依赖于这些变量在容器环境中实际存在。

ACP 上的默认 kube-prometheus 渲染并未将任何代理环境变量注入到 Prometheus 容器中——容器中唯一存在的环境变量是 `GOGC=50`。因此，在默认 chart 上启用 `proxyFromEnvironment` 会导致解析器没有任何可读取的内容，且没有代理应用于 remote-write 请求。

## 解决方案

根据代理是否应在 CR 中固定或由容器环境驱动，选择两个代理控制字段中的一个。选项 A (`oauth2.proxyUrl`) 将代理地址作为字面值保留在 CR 中；选项 B (`oauth2.proxyFromEnvironment`) 将代理解析推迟到 Prometheus 容器自己的环境，因此需要环境实际携带这些变量。

**选项 A — 通过 `oauth2.proxyUrl` 使用字面 URL。** 当 remote-write 代理是一个单一、稳定的 URL，且应与端点一起存在于 CR 中时，在 `remoteWrite[]` 条目上设置 `oauth2.proxyUrl`。该值作为字面代理 URL 应用于这些 remote-write 请求，没有环境间接：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: kube-prometheus-0
  namespace: cpaas-system
spec:
  remoteWrite:
    - url: https://remote.example.com/api/v1/write
      oauth2:
        clientId:
          secret:
            name: rw-oauth2
            key: client_id
        clientSecret:
          name: rw-oauth2
          key: client_secret
        tokenUrl: https://auth.example.com/oauth2/token
        proxyUrl: http://proxy.example.com:3128
```

Prometheus CR 是从 `ClusterPluginInstance/prometheus` (`spec.config.components.prometheus.*`) 中协调出来的——通过该表面应用编辑，以便 chart 重新渲染时不会还原。提交更改之前，使用服务器端干运行进行验证：

```bash
kubectl -n cpaas-system apply --dry-run=server -f kube-prometheus-0.yaml
```

成功的接纳返回 `prometheus.monitoring.coreos.com/kube-prometheus-0 configured (server dry run)`，确认 CRD 接受字面 `oauth2.proxyUrl` 以及 OAuth2 块的其余部分。

**选项 B — 通过 `oauth2.proxyFromEnvironment` 使用环境驱动。** 当所需的路由是“使用 Prometheus 容器配置的任何 HTTP 代理”（例如，共享集群的出站代理约定到所有 remote-write 端点），设置 `oauth2.proxyFromEnvironment: true`，并在适用时设置 `oauth2.noProxy` 排除列表（以逗号分隔；同样的 `Prometheus >= v2.43.0` 要求，所提供的 `v3.11.3` 镜像满足该要求）。根据 CRD 描述，该字段指示 Prometheus 容器从其自身环境中读取 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: kube-prometheus-0
  namespace: cpaas-system
spec:
  remoteWrite:
    - url: https://remote.example.com/api/v1/write
      oauth2:
        clientId:
          secret:
            name: rw-oauth2
            key: client_id
        clientSecret:
          name: rw-oauth2
          key: client_secret
        tokenUrl: https://auth.example.com/oauth2/token
        proxyFromEnvironment: true
        noProxy: "cluster.local,.svc,10.0.0.0/8"
```

选项 B 在默认 chart 上是无操作的，除非 `HTTP_PROXY` / `HTTPS_PROXY` 也被放入 Prometheus 容器环境中。将该字段与 `Prometheus.spec.containers[]` 重写结合，添加代理环境到 `prometheus` 容器——这是环境驱动模式在流量实际穿越代理之前所需的额外配置：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: kube-prometheus-0
  namespace: cpaas-system
spec:
  containers:
    - name: prometheus
      env:
        - name: HTTP_PROXY
          value: http://proxy.example.com:3128
        - name: HTTPS_PROXY
          value: http://proxy.example.com:3128
        - name: NO_PROXY
          value: cluster.local,.svc,10.0.0.0/8
```

Prometheus CRD 接受一个 `containers[]` 重写块，以将环境变量注入到 `prometheus` 容器中——如果没有该注入，`proxyFromEnvironment` 在默认 chart 上没有代理环境可供查询，该容器环境仅携带 `GOGC=50`。

## 诊断步骤

确认所选字段已到达 Prometheus CR——两个字段都位于同一个 `RemoteWriteSpec.oauth2` 块中，apiserver 接受它们共存（一个 CR 同时携带 `proxyUrl`、`oauth2.proxyFromEnvironment: true` 和 `oauth2.noProxy` 在所提供的 CRD 上干净接纳）：

```bash
kubectl -n cpaas-system get prometheus kube-prometheus-0 \
  -o jsonpath='{.spec.remoteWrite[*].oauth2}'
```

使用 `oauth2.proxyFromEnvironment` 时，在依赖 `proxyFromEnvironment` 之前验证容器环境块包含预期的 `HTTP_PROXY` / `HTTPS_PROXY` 条目——默认 chart 仅在容器环境中留下 `GOGC=50`，因此该字段在 `containers[]` 重写被协调之前没有任何可读取的内容：

```bash
kubectl -n cpaas-system get pod -l app.kubernetes.io/name=prometheus \
  -o jsonpath='{.items[0].spec.containers[?(@.name=="prometheus")].env}'
```

该命令的默认 chart 输出仅显示 `GOGC=50`；一旦上述 `containers[]` 重写被协调，`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 应该与其一起出现。

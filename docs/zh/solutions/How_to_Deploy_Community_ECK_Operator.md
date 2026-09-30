---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB260900055
sourceSHA: 5e15231f88bf8996ea4eaffa1fba9f86e656617bd0c35ec0553464507bccab1f
---

# 如何使用 Kubernetes 上的 Elastic Cloud 部署 Elasticsearch 和 Kibana (ECK)

## 概述

本指南将引导您在 Alauda 容器平台 (ACP) 上使用 [Kubernetes 上的 Elastic Cloud (ECK)](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s) 部署 Elasticsearch 和 Kibana，这是由 Elastic 发布的 Kubernetes operator。您将从 Elastic 自己的 YAML 清单中安装 ECK，将 Elastic 的容器镜像镜像到您的集群可以拉取的注册表中，然后创建 `Elasticsearch` 和 `Kibana` 资源。

**验证版本**（在 ACP 4.4 / Kubernetes 1.35，amd64 上验证；请查看上游文档以获取更新的版本）：

| 组件          | 版本   |
| :----------- | :------ |
| ECK operator  | `3.4.1` |
| Elasticsearch | `9.5.4` |
| Kibana        | `9.5.4` |

根据 Elastic 的 [支持版本](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s) 页面，ECK 支持 Kubernetes 1.31–1.36 和 Elastic Stack 8.x 和 9.x。本指南仅在 9.5.4 上进行了验证。

> **注意 — 许可**
> ECK 和 Elastic Stack 容器镜像由 Elastic 根据其自己的许可条款分发。本指南仅指向 Elastic 发布的清单和镜像；它不对其进行重新打包。在使用之前，请查看 Elastic 的 [许可信息](https://www.elastic.co/pricing/faq/licensing)。

有关背景信息，请参见：

- [ECK 文档](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s)
- [ECK 发布说明](https://www.elastic.co/docs/release-notes/cloud-on-k8s)
- [在隔离环境中安装 ECK](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/air-gapped-install)

## 先决条件

- 一个具有 `cluster-admin` 访问权限的 ACP 4.x 集群。ECK 安装集群范围的对象（CRDs、ClusterRoles 和 `ValidatingWebhookConfiguration`）。
- 已配置 `kubectl` 以连接目标集群。
- 一个具有动态 PVC 供应的 `StorageClass`。
- 一个您的集群节点可以拉取的私有容器注册表，以及推送到该注册表的凭据。在 ACP 上，您可以使用平台注册表（见步骤 1）。
- 一台可以访问 `download.elastic.co` 和 `docker.elastic.co` 的工作站，并安装了 [`skopeo`](https://github.com/containers/skopeo)。

一次性导出这些变量，并在整个指南中重复使用：

```bash
export ECK_VERSION=3.4.1
export STACK_VERSION=9.5.4
export NS=<your-namespace>                # 例如 elastic-demo — Elasticsearch 和 Kibana 运行的地方
export ES_NAME=<your-cluster-name>        # 例如 quickstart — 资源由此派生 (<name>-es-http, <name>-es-elastic-user, ...)
export STORAGE_CLASS=<your-storageclass>  # 例如 TopoLVM StorageClass
export REGISTRY_SERVER=<registry-host>    # 仅主机[:端口]，例如 registry.example.com:11443
export PRIVATE_REGISTRY=<registry-host>/<project>   # 主机加项目路径，例如 registry.example.com:11443/elastic
```

`REGISTRY_SERVER` 是注册表 **主机**（用于凭据）。`PRIVATE_REGISTRY` 是主机 **加项目路径**（用于镜像引用）。请保持它们分开。

ECK operator 本身安装到 `elastic-system` 命名空间中，这是 Elastic 的 `operator.yaml` 中硬编码的。

## 步骤 1：将所需镜像镜像到您的私有注册表

ACP 集群节点通常无法从 `docker.elastic.co` 拉取。将这三个镜像复制到您的注册表中。

> **重要 — 保持存储库路径**
> ECK 构建 Elasticsearch 和 Kibana 镜像名称为 `<registry>/elasticsearch/elasticsearch:<version>` 和 `<registry>/kibana/kibana:<version>`。请在 `$PRIVATE_REGISTRY` 下准确地在这些子路径下镜像镜像。否则，步骤 3 中 operator 的注册表覆盖将指向不存在的镜像。

```bash
skopeo copy --all docker://docker.elastic.co/eck/eck-operator:${ECK_VERSION} \
  docker://${PRIVATE_REGISTRY}/eck/eck-operator:${ECK_VERSION}
skopeo copy --all docker://docker.elastic.co/elasticsearch/elasticsearch:${STACK_VERSION} \
  docker://${PRIVATE_REGISTRY}/elasticsearch/elasticsearch:${STACK_VERSION}
skopeo copy --all docker://docker.elastic.co/kibana/kibana:${STACK_VERSION} \
  docker://${PRIVATE_REGISTRY}/kibana/kibana:${STACK_VERSION}
```

`--all` 复制上游多架构索引中的每个架构（amd64 和 arm64），因此相同的镜像可以服务于混合架构集群。Elasticsearch 镜像较大（每个架构约 0.9 GiB 压缩），因此在慢速链接上请留出足够的时间。

### 使用 ACP 平台注册表

在 ACP 上，您可以使用 `kubectl` 查找平台注册表地址和推送凭据：

```bash
# 平台注册表的注册表主机:端口
kubectl -n kube-public get configmap global-info -o jsonpath='{.data.registryAddress}'; echo

# 推送凭据（请勿将其粘贴到共享终端或工单中）
REG_USER=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.username}' | base64 -d)
REG_PASS=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.password}' | base64 -d)
```

将 `REGISTRY_SERVER` 设置为上面返回的地址，并为 `PRIVATE_REGISTRY` 选择一个项目路径（例如 `${REGISTRY_SERVER}/elastic`）。平台注册表使用自签名证书，因此在每个 `skopeo copy` 中添加 `--dest-creds` 和 `--dest-tls-verify=false`：

```bash
skopeo copy --all --dest-creds "${REG_USER}:${REG_PASS}" --dest-tls-verify=false \
  docker://docker.elastic.co/eck/eck-operator:${ECK_VERSION} \
  docker://${PRIVATE_REGISTRY}/eck/eck-operator:${ECK_VERSION}
# ...重复 elasticsearch/elasticsearch 和 kibana/kibana 的操作
```

确认每个镜像的摘要与上游的一致：

```bash
skopeo inspect --format '{{.Digest}}' docker://docker.elastic.co/eck/eck-operator:${ECK_VERSION}
skopeo inspect --tls-verify=false --creds "${REG_USER}:${REG_PASS}" --format '{{.Digest}}' \
  docker://${PRIVATE_REGISTRY}/eck/eck-operator:${ECK_VERSION}
```

## 步骤 2：拉取的注册表凭据（仅当您的注册表需要登录时）

如果您的集群节点可以在没有凭据的情况下从 `$PRIVATE_REGISTRY` 拉取，请跳过此步骤。在本指南的验证中，节点匿名拉取了镜像，因此未使用拉取密钥。

> **在此验证中未验证**
> 以下步骤遵循 Elastic 的 [隔离安装](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/air-gapped-install) 文档。Alauda 尚未在 ACP 上测试它们。

如果您的注册表需要登录，请在 operator 命名空间和工作负载命名空间中创建拉取密钥。如果它们尚不存在，请先创建命名空间。

```bash
for ns in elastic-system "$NS"; do
  kubectl -n "$ns" create secret docker-registry registry-pull \
    --docker-server="$REGISTRY_SERVER" \
    --docker-username="<registry-username>" \
    --docker-password="<registry-password>"
done
```

然后执行以下操作：

- 在步骤 3 之后，将密钥附加到 operator：
  `kubectl -n elastic-system patch statefulset elastic-operator --type merge -p '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"registry-pull"}]}}}}'`
- 在步骤 5 中，将密钥添加到两个自定义资源中。对于 `Elasticsearch` 资源，在每个 `nodeSets` 条目下添加 `podTemplate.spec.imagePullSecrets`。对于 `Kibana` 资源，添加 `spec.podTemplate.spec.imagePullSecrets`：

  ```yaml
  podTemplate:
    spec:
      imagePullSecrets:
      - name: registry-pull
  ```

## 步骤 3：安装 ECK

从 Elastic 下载固定的清单：

```bash
curl -fLO https://download.elastic.co/downloads/eck/${ECK_VERSION}/crds.yaml
curl -fLO https://download.elastic.co/downloads/eck/${ECK_VERSION}/operator.yaml
```

在 **两个** 位置重写 `operator.yaml`：

```bash
sed -e "s#docker.elastic.co/eck/eck-operator:${ECK_VERSION}#${PRIVATE_REGISTRY}/eck/eck-operator:${ECK_VERSION}#" \
    -e "s#container-registry: docker.elastic.co#container-registry: ${PRIVATE_REGISTRY}#" \
    operator.yaml > operator-mirrored.yaml

# 期望正好这两行发生变化
diff operator.yaml operator-mirrored.yaml
```

1. **operator 镜像** 在 `elastic-operator` StatefulSet 中。
2. **`container-registry`** 在 `elastic-operator` ConfigMap 的 `eck.yaml` 键中。这是 operator 部署的每个 Elastic Stack 镜像的默认注册表（这是 Elastic 的隔离指南中描述的 `--container-registry` 标志的配置文件形式）。在此更改后，ECK 将自动部署 `${PRIVATE_REGISTRY}/elasticsearch/elasticsearch:<version>` 和 `${PRIVATE_REGISTRY}/kibana/kibana:<version>`。因此，步骤 5 中的 `Elasticsearch` 和 `Kibana` 资源 **不需要 `spec.image` 字段**。

安装 CRDs，然后安装 operator：

```bash
kubectl create -f crds.yaml
kubectl apply -f operator-mirrored.yaml
```

等待 operator 准备就绪：

```bash
kubectl -n elastic-system wait --for=condition=Ready pod/elastic-operator-0 --timeout=180s
kubectl -n elastic-system get pod elastic-operator-0
```

预期输出（在验证中，operator 在 `apply` 后约 15 秒准备就绪）：

```text
NAME                 READY   STATUS    RESTARTS   AGE
elastic-operator-0   1/1     Running   0          20s
```

operator 自身运行验证 webhook。确认 webhook 服务具有端点：

```bash
kubectl -n elastic-system get endpointslice -l kubernetes.io/service-name=elastic-webhook-server
```

## 步骤 4：命名空间 Pod 安全性

在 ACP 4.4 上不需要 Pod 安全性准入标签。默认情况下，ECK 在其创建的 pods 上设置受限兼容的安全上下文。该上下文包括 `seccompProfile: RuntimeDefault`、`runAsNonRoot`、`allowPrivilegeEscalation: false`，所有能力被丢弃，并且初始化容器上的根文件系统为只读。在验证中，`elastic-system` 和工作负载命名空间在没有任何 `pod-security.kubernetes.io/*` 标签的情况下使用，每个 pod 都被接受。

创建工作负载命名空间：

```bash
kubectl create namespace "$NS"
```

如果您的集群强制执行更严格的自定义策略，请使用 `kubectl -n "$NS" get pod <pod> -o yaml` 检查渲染的 pods，并相应调整。

## 步骤 5：创建 Elasticsearch 和 Kibana

### 5a. Elasticsearch

这个单节点示例遵循 Elastic 的快速入门，具有明确的持久存储：

```bash
cat <<EOF | kubectl apply -f -
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: ${ES_NAME}
  namespace: ${NS}
spec:
  version: ${STACK_VERSION}
  nodeSets:
  - name: default
    count: 1
    config:
      node.store.allow_mmap: false
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data   # 保持此名称；ECK 通过此名称挂载数据卷
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: ${STORAGE_CLASS}
        resources:
          requests:
            storage: 5Gi
EOF
```

`node.store.allow_mmap: false` 来自 Elastic 的快速入门。它避免了节点上需要 `vm.max_map_count >= 262144`。在验证集群中，节点已经有 `vm.max_map_count = 262144`，因此在此不需要此设置。对于生产环境，请提高 `vm.max_map_count` 并删除该设置；请参见 Elastic 的 [虚拟内存](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/virtual-memory) 页面。

### 5b. Kibana

```bash
cat <<EOF | kubectl apply -f -
apiVersion: kibana.k8s.elastic.co/v1
kind: Kibana
metadata:
  name: ${ES_NAME}
  namespace: ${NS}
spec:
  version: ${STACK_VERSION}
  count: 1
  elasticsearchRef:
    name: ${ES_NAME}
EOF
```

### 5c. 等待两者准备就绪

```bash
kubectl -n "$NS" get elasticsearch,kibana
```

准备就绪时的预期输出（在验证中，约 2 分钟后镜像变得可拉取）：

```text
NAME                                                    HEALTH   NODES   VERSION   PHASE   AGE
elasticsearch.elasticsearch.k8s.elastic.co/quickstart   green    1       9.5.4     Ready   3m

NAME                                      HEALTH   NODES   VERSION   AGE
kibana.kibana.k8s.elastic.co/quickstart   green    1       9.5.4     3m
```

pods 为 `<name>-es-default-0` 和 `<name>-kb-<hash>`。PVC 为 `elasticsearch-data-<name>-es-default-0`。

## 步骤 6：验证 Elasticsearch

ECK 创建 `elastic` 超级用户并将其密码存储在 Secret `<name>-es-elastic-user` 中。将其读入 shell 变量中，并且不要打印它：

```bash
PASSWORD=$(kubectl -n "$NS" get secret "${ES_NAME}-es-elastic-user" -o jsonpath='{.data.elastic}' | base64 -d)
ES_POD="${ES_NAME}-es-default-0"
ES_URL="https://${ES_NAME}-es-http:9200"
```

从集群内部查询集群。使用 `-k` 是因为 ECK 默认使用自签名 CA 提供 HTTPS。

```bash
kubectl -n "$NS" exec "$ES_POD" -c elasticsearch -- curl -sk -u "elastic:${PASSWORD}" "$ES_URL"
```

响应包括：

```text
  "cluster_name" : "quickstart",
    "number" : "9.5.4",
  "tagline" : "You Know, for Search"
```

创建一个测试索引，索引一个文档，并搜索它。索引的创建使用 `"number_of_replicas": 0`，因为单节点集群无法放置副本分片。由于默认情况下有 1 个副本，因此索引，因此集群健康状态保持为 `yellow`。

```bash
kubectl -n "$NS" exec "$ES_POD" -c elasticsearch -- curl -sk -u "elastic:${PASSWORD}" \
  -XPUT "$ES_URL/demo-index" -H 'Content-Type: application/json' \
  -d '{"settings":{"number_of_replicas":0}}'

kubectl -n "$NS" exec "$ES_POD" -c elasticsearch -- curl -sk -u "elastic:${PASSWORD}" \
  -XPUT "$ES_URL/demo-index/_doc/1?refresh=true" -H 'Content-Type: application/json' \
  -d '{"msg":"hello from ACP"}'

kubectl -n "$NS" exec "$ES_POD" -c elasticsearch -- curl -sk -u "elastic:${PASSWORD}" \
  "$ES_URL/demo-index/_search?q=msg:hello&filter_path=hits.total"
```

预期搜索结果：

```json
{"hits":{"total":{"value":1,"relation":"eq"}}}
```

完成后清除变量：`unset PASSWORD`。

## 卸载

按此顺序删除所有内容。删除 `Elasticsearch` 和 `Kibana` 资源时，operator 必须仍在运行。

```bash
# 1. Elastic Stack 资源
kubectl -n "$NS" delete kibana "$ES_NAME"
kubectl -n "$NS" delete elasticsearch "$ES_NAME"
kubectl -n "$NS" get pod        # 等待 Elasticsearch 和 Kibana pods 消失

# 2. 数据卷（这会永久删除 Elasticsearch 数据；
#    --all 假设 $NS 专用于此部署，如本指南所示）
kubectl -n "$NS" get pvc
kubectl -n "$NS" delete pvc --all

# 3. 工作负载命名空间
kubectl delete namespace "$NS"

# 4. 在删除 operator 之前，确认没有其他命名空间仍在使用 ECK
for r in $(kubectl get crd -o name | grep k8s.elastic.co | cut -d/ -f2); do kubectl get "$r" -A --no-headers; done

# 5. operator（还会删除 elastic-system 命名空间、ClusterRoles 和 webhook），然后是 CRDs
kubectl delete -f operator-mirrored.yaml
kubectl delete -f crds.yaml
```

确认没有剩余内容：

```bash
kubectl get namespace "$NS" elastic-system      # 两者：未找到
kubectl get crd | grep -c k8s.elastic.co        # 0
```

最后，如果您不再需要它们，请从注册表中删除镜像。

另请参见 Elastic 的 [卸载指南](https://www.elastic.co/docs/deploy-manage/uninstall/uninstall-elastic-cloud-on-kubernetes)。

## 限制

- **Alauda 验证：** 本指南中的基线在 ACP 4.4 / Kubernetes 1.35（amd64）上于 2026-09-30 进行了端到端验证。运行涵盖了镜像到平台注册表、两个 `operator.yaml` 重写，以及 operator 及其 webhook 达到 Ready。它还涵盖了在 TopoLVM StorageClass 上运行的单节点 Elasticsearch 9.5.4 和 Kibana 9.5.4，均达到 `green`，集群内 HTTPS 查询、索引和搜索往返，以及上述卸载序列。
- **未由 Alauda 验证：** 这些可能有效，但尚未在 ACP 上测试。将 Elastic 的文档视为权威，并在您自己的环境中进行验证。

### Alauda 验证

| 领域                                                                | 结果                                                   |
| :------------------------------------------------------------------ | :------------------------------------------------------- |
| 从镜像镜像安装 ECK 3.4.1（CRDs + operator，webhook）               | Operator 正在运行，webhook 端点已准备好                 |
| 通过 `container-registry` 进行注册表覆盖（CR 中没有 `spec.image`） | Pods 拉取了镜像的 Elasticsearch 和 Kibana 镜像         |
| Pod 安全性                                                        | 在没有命名空间标签的情况下被接受                        |
| 在 TopoLVM 上的单节点 Elasticsearch 9.5.4 及 PVC                   | `green` / `Ready`                                        |
| 通过 `elasticsearchRef` 连接的 Kibana 9.5.4                       | `green`                                                  |
| 作为 `elastic` 的集群内 HTTPS 访问，索引 + 搜索                    | 搜索返回 1 个命中                                        |
| 卸载（CRs → PVCs → 命名空间 → operator → CRDs）                    | 没有 ECK 对象、命名空间或卷剩余                          |

### 未由 Alauda 验证

| 领域                                                                               | 上游参考                                                                                     |
| :--------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------- |
| 需要拉取密钥的注册表（步骤 2）                                                       | [隔离安装](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/air-gapped-install) |
| 多节点 / 生产规模的 Elasticsearch 拓扑                                             | [ECK 文档](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s)                     |
| 从集群外部访问 Kibana 或 Elasticsearch（服务类型、Ingress）                         | [ECK 文档](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s)                     |
| arm64 和混合架构集群                                                                | [ECK 文档](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s)                     |
| Ceph RBD 或其他 StorageClasses                                                       | —                                                                                              |
| ECK operator 升级和 Elastic Stack 版本升级                                         | [升级 ECK](https://www.elastic.co/docs/deploy-manage/upgrade/orchestrator/upgrade-cloud-on-k8s) |
| 设置 `vm.max_map_count` 并在没有 `node.store.allow_mmap: false` 的情况下运行       | [虚拟内存](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/virtual-memory)         |

### 支持模型

ECK 和 Elastic Stack 是 Elastic 产品。有关 operator 或 Elastic Stack 缺陷，请参考 Elastic 的文档和支持渠道。本指南涵盖在 ACP 上运行它们。

## 故障排除

| 症状                                                     | 可能原因                                                                                                                  | 修复                                                                                                                                                                                                                                                                           |
| :-------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pods 卡在 `Init:ErrImagePull` / `Init:ImagePullBackOff` | 镜像尚未在 `$PRIVATE_REGISTRY` 下的 `elasticsearch/elasticsearch` 或 `kibana/kibana` 中，或者注册表需要登录             | 完成/验证镜像（步骤 1），并检查 `kubectl -n "$NS" get pod <pod> -o jsonpath='{.spec.containers[0].image}'` 中的镜像路径；对于需要身份验证的注册表，请参见步骤 2。修复后，删除 pod 以立即重试，而不是等待拉取回退。 |
| 集群健康状态为 `yellow` 在单节点上                     | 索引有无法放置在一个节点上的副本                                                                                       | 在单节点集群上创建索引时使用 `"number_of_replicas": 0`，或添加节点                                                                                                                                                                                           |
| PVC 保持 `Pending`                                       | `storageClassName` 缺失或错误；`WaitForFirstConsumer` 类别仅在 pod 被调度时绑定                                         | 检查 `kubectl get sc` 和 `Elasticsearch` 资源的 `volumeClaimTemplates`                                                                                                                                                                                         |

## 参考

- [Kubernetes 上的 Elastic Cloud](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s)
- [使用 YAML 清单安装 ECK](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/install-using-yaml-manifest-quickstart)
- [部署 Elasticsearch 集群](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/elasticsearch-deployment-quickstart)
- [部署 Kibana 实例](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/kibana-instance-quickstart)
- [隔离安装](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/air-gapped-install)
- [ECK 发布说明](https://www.elastic.co/docs/release-notes/cloud-on-k8s)
- [Elastic 许可](https://www.elastic.co/pricing/faq/licensing)

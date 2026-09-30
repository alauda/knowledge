---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
---

# 如何使用 Elastic Cloud on Kubernetes (ECK) 部署 Elasticsearch 和 Kibana

## 概述

本文介绍如何在 Alauda Container Platform (ACP) 上使用 Elastic 发布的 Kubernetes Operator —— [Elastic Cloud on Kubernetes (ECK)](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s) 部署 Elasticsearch 和 Kibana。您将使用 Elastic 官方的 YAML 清单安装 ECK，把 Elastic 的容器镜像同步到集群可以拉取的镜像仓库，然后创建 `Elasticsearch` 和 `Kibana` 资源。

**已验证版本**（在 ACP 4.4 / Kubernetes 1.35、amd64 上验证；更新版本请参考上游文档）：

| 组件 | 版本 |
| :--- | :--- |
| ECK operator | `3.4.1` |
| Elasticsearch | `9.5.4` |
| Kibana | `9.5.4` |

根据 Elastic 的[支持版本](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s)页面，ECK 支持 Kubernetes 1.31–1.36 以及 Elastic Stack 8.x 和 9.x。本文仅使用 9.5.4 进行了验证。

> **说明 —— 许可**
> ECK 及 Elastic Stack 容器镜像由 Elastic 按其自身的许可条款分发。本文仅引用 Elastic 发布的清单和镜像，不对其进行重新打包。使用前请阅读 Elastic 的[许可信息](https://www.elastic.co/pricing/faq/licensing)。

背景资料：

- [ECK 文档](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s)
- [ECK 发行说明](https://www.elastic.co/docs/release-notes/cloud-on-k8s)
- [在离线（air-gapped）环境中安装 ECK](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/air-gapped-install)

## 前提条件

- 一个具有 `cluster-admin` 权限的 ACP 4.x 集群。ECK 会安装集群级对象（CRD、ClusterRole 和一个 `ValidatingWebhookConfiguration`）。
- 已配置好指向目标集群的 `kubectl`。
- 一个支持动态 PVC 供给的 `StorageClass`。
- 一个集群节点可以拉取镜像的私有镜像仓库，以及向其推送镜像的凭据。在 ACP 上可以使用平台镜像仓库（见步骤 1）。
- 一台可以访问 `download.elastic.co` 和 `docker.elastic.co` 的工作机，并已安装 [`skopeo`](https://github.com/containers/skopeo)。

先导出以下变量，后续步骤都会用到：

```bash
export ECK_VERSION=3.4.1
export STACK_VERSION=9.5.4
export NS=<your-namespace>                # e.g. elastic-demo — where Elasticsearch and Kibana run
export ES_NAME=<your-cluster-name>        # e.g. quickstart — resources derive from it (<name>-es-http, <name>-es-elastic-user, ...)
export STORAGE_CLASS=<your-storageclass>  # e.g. a TopoLVM StorageClass
export REGISTRY_SERVER=<registry-host>    # host[:port] only, e.g. registry.example.com:11443
export PRIVATE_REGISTRY=<registry-host>/<project>   # host plus a project path, e.g. registry.example.com:11443/elastic
```

`REGISTRY_SERVER` 是镜像仓库的**主机地址**（用于凭据）；`PRIVATE_REGISTRY` 是**主机地址加项目路径**（用于镜像引用）。请分开设置这两个变量。

ECK operator 本身安装在 `elastic-system` 命名空间中，该命名空间在 Elastic 的 `operator.yaml` 中是写死的。

## 步骤 1：将所需镜像同步到私有镜像仓库

ACP 集群节点通常无法从 `docker.elastic.co` 拉取镜像。请把以下三个镜像复制到您的镜像仓库。

> **重要 —— 保留仓库路径**
> ECK 按 `<registry>/elasticsearch/elasticsearch:<version>` 和 `<registry>/kibana/kibana:<version>` 的格式拼出 Elasticsearch 和 Kibana 的镜像名。请把镜像同步到 `$PRIVATE_REGISTRY` 下完全相同的子路径中，否则步骤 3 中 operator 的镜像仓库覆盖会指向不存在的镜像。

```bash
skopeo copy --all docker://docker.elastic.co/eck/eck-operator:${ECK_VERSION} \
  docker://${PRIVATE_REGISTRY}/eck/eck-operator:${ECK_VERSION}
skopeo copy --all docker://docker.elastic.co/elasticsearch/elasticsearch:${STACK_VERSION} \
  docker://${PRIVATE_REGISTRY}/elasticsearch/elasticsearch:${STACK_VERSION}
skopeo copy --all docker://docker.elastic.co/kibana/kibana:${STACK_VERSION} \
  docker://${PRIVATE_REGISTRY}/kibana/kibana:${STACK_VERSION}
```

`--all` 会复制上游多架构索引中的所有架构（amd64 和 arm64），因此同一份镜像也可用于混合架构集群。Elasticsearch 镜像较大（每个架构压缩后约 0.9 GiB），网络较慢时请预留足够的时间。

### 使用 ACP 平台镜像仓库

在 ACP 上，可以用 `kubectl` 查询平台镜像仓库地址和推送凭据：

```bash
# Registry host:port of the platform registry
kubectl -n kube-public get configmap global-info -o jsonpath='{.data.registryAddress}'; echo

# Push credentials (do not paste them into shared terminals or tickets)
REG_USER=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.username}' | base64 -d)
REG_PASS=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.password}' | base64 -d)
```

将 `REGISTRY_SERVER` 设置为上面返回的地址，并为 `PRIVATE_REGISTRY` 选择一个项目路径（例如 `${REGISTRY_SERVER}/elastic`）。平台镜像仓库使用自签名证书，因此每条 `skopeo copy` 命令都需要加上 `--dest-creds` 和 `--dest-tls-verify=false`：

```bash
skopeo copy --all --dest-creds "${REG_USER}:${REG_PASS}" --dest-tls-verify=false \
  docker://docker.elastic.co/eck/eck-operator:${ECK_VERSION} \
  docker://${PRIVATE_REGISTRY}/eck/eck-operator:${ECK_VERSION}
# ...repeat for elasticsearch/elasticsearch and kibana/kibana as above
```

确认同步后的镜像 digest 与上游一致：

```bash
skopeo inspect --format '{{.Digest}}' docker://docker.elastic.co/eck/eck-operator:${ECK_VERSION}
skopeo inspect --tls-verify=false --creds "${REG_USER}:${REG_PASS}" --format '{{.Digest}}' \
  docker://${PRIVATE_REGISTRY}/eck/eck-operator:${ECK_VERSION}
```

## 步骤 2：拉取镜像的仓库凭据（仅当镜像仓库需要登录时）

如果集群节点无需凭据即可从 `$PRIVATE_REGISTRY` 拉取镜像，请跳过此步骤。本文所依据的验证中，节点以匿名方式拉取了同步的镜像，因此没有使用拉取密钥。

> **本次验证未覆盖**
> 以下步骤参照 Elastic 的[离线安装](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/air-gapped-install)文档编写，Alauda 尚未在 ACP 上测试。

如果镜像仓库需要登录，请在 operator 命名空间和工作负载命名空间中各创建一个拉取密钥。如果命名空间尚不存在，请先创建。

```bash
for ns in elastic-system "$NS"; do
  kubectl -n "$ns" create secret docker-registry registry-pull \
    --docker-server="$REGISTRY_SERVER" \
    --docker-username="<registry-username>" \
    --docker-password="<registry-password>"
done
```

然后执行以下操作：

- 完成步骤 3 后，把密钥挂到 operator 上：
  `kubectl -n elastic-system patch statefulset elastic-operator --type merge -p '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"registry-pull"}]}}}}'`
- 在步骤 5 中，为两个自定义资源添加该密钥。`Elasticsearch` 资源需在 `nodeSets` 的每个条目下添加 `podTemplate.spec.imagePullSecrets`；`Kibana` 资源需添加 `spec.podTemplate.spec.imagePullSecrets`：

  ```yaml
  podTemplate:
    spec:
      imagePullSecrets:
      - name: registry-pull
  ```

## 步骤 3：安装 ECK

从 Elastic 下载固定版本的清单：

```bash
curl -fLO https://download.elastic.co/downloads/eck/${ECK_VERSION}/crds.yaml
curl -fLO https://download.elastic.co/downloads/eck/${ECK_VERSION}/operator.yaml
```

在 `operator.yaml` 中修改**两**处：

```bash
sed -e "s#docker.elastic.co/eck/eck-operator:${ECK_VERSION}#${PRIVATE_REGISTRY}/eck/eck-operator:${ECK_VERSION}#" \
    -e "s#container-registry: docker.elastic.co#container-registry: ${PRIVATE_REGISTRY}#" \
    operator.yaml > operator-mirrored.yaml

# Expect exactly these two changed lines
diff operator.yaml operator-mirrored.yaml
```

1. **operator 镜像**：`elastic-operator` StatefulSet 中的镜像。
2. **`container-registry`**：`elastic-operator` ConfigMap 中 `eck.yaml` 键里的配置项。它是 operator 部署所有 Elastic Stack 镜像时使用的默认镜像仓库（即 Elastic 离线安装文档中 `--container-registry` 参数的配置文件形式）。修改后，ECK 会自动部署 `${PRIVATE_REGISTRY}/elasticsearch/elasticsearch:<version>` 和 `${PRIVATE_REGISTRY}/kibana/kibana:<version>`。因此，步骤 5 中的 `Elasticsearch` 和 `Kibana` 资源**无需设置 `spec.image` 字段**。

先安装 CRD，再安装 operator：

```bash
kubectl create -f crds.yaml
kubectl apply -f operator-mirrored.yaml
```

等待 operator 就绪：

```bash
kubectl -n elastic-system wait --for=condition=Ready pod/elastic-operator-0 --timeout=180s
kubectl -n elastic-system get pod elastic-operator-0
```

预期输出（验证中，operator 在 `apply` 后约 15 秒就绪）：

```text
NAME                 READY   STATUS    RESTARTS   AGE
elastic-operator-0   1/1     Running   0          20s
```

operator 自身提供校验 webhook。确认 webhook Service 已有 endpoint：

```bash
kubectl -n elastic-system get endpointslice -l kubernetes.io/service-name=elastic-webhook-server
```

## 步骤 4：命名空间 Pod 安全

在 ACP 4.4 上无需任何 Pod Security Admission 标签。ECK 默认会为其创建的 Pod 设置兼容 restricted 的安全上下文，包括 `seccompProfile: RuntimeDefault`、`runAsNonRoot`、`allowPrivilegeEscalation: false`、移除所有 capabilities，以及 init 容器使用只读根文件系统。验证中，`elastic-system` 和工作负载命名空间都没有设置任何 `pod-security.kubernetes.io/*` 标签，所有 Pod 均被准入。

创建工作负载命名空间：

```bash
kubectl create namespace "$NS"
```

如果集群实施了更严格的自定义策略，请用 `kubectl -n "$NS" get pod <pod> -o yaml` 查看生成的 Pod 并相应调整。

## 步骤 5：创建 Elasticsearch 和 Kibana

### 5a. Elasticsearch

这个单节点示例参照 Elastic 的 quickstart，并显式配置了持久化存储：

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
        name: elasticsearch-data   # keep this name; ECK mounts the data volume by it
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: ${STORAGE_CLASS}
        resources:
          requests:
            storage: 5Gi
EOF
```

`node.store.allow_mmap: false` 来自 Elastic 的 quickstart，可避免要求节点上 `vm.max_map_count >= 262144`。验证集群的节点上 `vm.max_map_count` 已经是 `262144`，所以在该集群上这个设置并非必需。生产环境建议调高 `vm.max_map_count` 并去掉该设置，参见 Elastic 的[虚拟内存](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/virtual-memory)页面。

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

### 5c. 等待两者就绪

```bash
kubectl -n "$NS" get elasticsearch,kibana
```

就绪后的预期输出（验证中，镜像可拉取后约 2 分钟就绪）：

```text
NAME                                                    HEALTH   NODES   VERSION   PHASE   AGE
elasticsearch.elasticsearch.k8s.elastic.co/quickstart   green    1       9.5.4     Ready   3m

NAME                                      HEALTH   NODES   VERSION   AGE
kibana.kibana.k8s.elastic.co/quickstart   green    1       9.5.4     3m
```

Pod 名称为 `<name>-es-default-0` 和 `<name>-kb-<hash>`，PVC 名称为 `elasticsearch-data-<name>-es-default-0`。

## 步骤 6：验证 Elasticsearch

ECK 会创建 `elastic` 超级用户，并把其密码保存在 Secret `<name>-es-elastic-user` 中。将密码读入 shell 变量，不要打印出来：

```bash
PASSWORD=$(kubectl -n "$NS" get secret "${ES_NAME}-es-elastic-user" -o jsonpath='{.data.elastic}' | base64 -d)
ES_POD="${ES_NAME}-es-default-0"
ES_URL="https://${ES_NAME}-es-http:9200"
```

在集群内部访问 Elasticsearch。由于 ECK 默认使用自签名 CA 提供 HTTPS 服务，这里使用 `-k`。

```bash
kubectl -n "$NS" exec "$ES_POD" -c elasticsearch -- curl -sk -u "elastic:${PASSWORD}" "$ES_URL"
```

响应中包含：

```text
  "cluster_name" : "quickstart",
    "number" : "9.5.4",
  "tagline" : "You Know, for Search"
```

创建一个测试索引，写入一条文档并搜索。索引创建时设置 `"number_of_replicas": 0`，因为单节点集群无法分配副本分片；如果使用默认的 1 个副本，该索引以及集群健康状态会一直是 `yellow`。

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

预期的搜索结果：

```json
{"hits":{"total":{"value":1,"relation":"eq"}}}
```

完成后清除该变量：`unset PASSWORD`。

## 卸载

请按以下顺序删除。删除 `Elasticsearch` 和 `Kibana` 资源时，operator 必须仍在运行。

```bash
# 1. The Elastic Stack resources
kubectl -n "$NS" delete kibana "$ES_NAME"
kubectl -n "$NS" delete elasticsearch "$ES_NAME"
kubectl -n "$NS" get pod        # wait until the Elasticsearch and Kibana pods are gone

# 2. The data volumes (this permanently deletes the Elasticsearch data;
#    --all assumes $NS is dedicated to this deployment, as in this guide)
kubectl -n "$NS" get pvc
kubectl -n "$NS" delete pvc --all

# 3. The workload namespace
kubectl delete namespace "$NS"

# 4. Before removing the operator, confirm that no other namespace still uses ECK
for r in $(kubectl get crd -o name | grep k8s.elastic.co | cut -d/ -f2); do kubectl get "$r" -A --no-headers; done

# 5. The operator (also removes the elastic-system namespace, ClusterRoles and the webhook), then the CRDs
kubectl delete -f operator-mirrored.yaml
kubectl delete -f crds.yaml
```

确认没有残留：

```bash
kubectl get namespace "$NS" elastic-system      # both: NotFound
kubectl get crd | grep -c k8s.elastic.co        # 0
```

最后，如果不再需要，请从镜像仓库中删除已同步的镜像。

另请参阅 Elastic 的[卸载指南](https://www.elastic.co/docs/deploy-manage/uninstall/uninstall-elastic-cloud-on-kubernetes)。

## 限制

- **Alauda 已验证：**本文的基础流程已于 2026-09-30 在 ACP 4.4 / Kubernetes 1.35（amd64）上完成端到端验证。验证内容包括：将镜像同步到平台镜像仓库、对 `operator.yaml` 的两处修改、operator 及其 webhook 就绪；以及使用 TopoLVM StorageClass 的单节点 Elasticsearch 9.5.4 和 Kibana 9.5.4 均达到 `green`、集群内 HTTPS 访问、索引与搜索的往返测试，以及上述卸载流程。
- **Alauda 未验证：**以下功能可能可用，但尚未在 ACP 上测试。请以 Elastic 的文档为准，并在您自己的环境中验证。

### Alauda 已验证

| 范围 | 结果 |
| :--- | :--- |
| 使用同步的镜像安装 ECK 3.4.1（CRD + operator、webhook） | operator 处于 Running，webhook endpoint 就绪 |
| 通过 `container-registry` 覆盖镜像仓库（CR 中无 `spec.image`） | Pod 拉取了同步的 Elasticsearch 和 Kibana 镜像 |
| Pod 安全 | 无需命名空间标签即被准入 |
| 使用 TopoLVM 上 PVC 的单节点 Elasticsearch 9.5.4 | `green` / `Ready` |
| 通过 `elasticsearchRef` 连接的 Kibana 9.5.4 | `green` |
| 以 `elastic` 用户在集群内进行 HTTPS 访问，写入与搜索 | 搜索返回 1 条结果 |
| 卸载（CR → PVC → 命名空间 → operator → CRD） | 无 ECK 对象、命名空间或存储卷残留 |

### Alauda 未验证

| 范围 | 上游参考 |
| :--- | :--- |
| 需要拉取密钥的镜像仓库（步骤 2） | [离线安装](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/air-gapped-install) |
| 多节点 / 生产规模的 Elasticsearch 拓扑 | [ECK 文档](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s) |
| 从集群外部访问 Kibana 或 Elasticsearch（Service 类型、Ingress） | [ECK 文档](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s) |
| arm64 及混合架构集群 | [ECK 文档](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s) |
| Ceph RBD 或其他 StorageClass | — |
| ECK operator 升级及 Elastic Stack 版本升级 | [升级 ECK](https://www.elastic.co/docs/deploy-manage/upgrade/orchestrator/upgrade-cloud-on-k8s) |
| 设置 `vm.max_map_count` 并去掉 `node.store.allow_mmap: false` 运行 | [虚拟内存](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/virtual-memory) |

### 支持模式

ECK 和 Elastic Stack 是 Elastic 的产品。operator 或 Elastic Stack 本身的缺陷，请参考 Elastic 的文档和支持渠道。本文仅说明如何在 ACP 上运行它们。

## 故障排查

| 现象 | 可能原因 | 处理方法 |
| :--- | :--- | :--- |
| Pod 停留在 `Init:ErrImagePull` / `Init:ImagePullBackOff` | 镜像（尚）不在 `$PRIVATE_REGISTRY` 的 `elasticsearch/elasticsearch` 或 `kibana/kibana` 路径下，或镜像仓库需要登录 | 完成并核对镜像同步（步骤 1），用 `kubectl -n "$NS" get pod <pod> -o jsonpath='{.spec.containers[0].image}'` 检查镜像路径；需要认证的镜像仓库请参见步骤 2。修复后删除该 Pod 即可立即重试，无需等待拉取退避 |
| 单节点集群健康状态为 `yellow` | 某个索引的副本无法分配在单个节点上 | 单节点集群上创建索引时设置 `"number_of_replicas": 0`，或增加节点 |
| PVC 一直处于 `Pending` | `storageClassName` 缺失或错误；`WaitForFirstConsumer` 类型的存储类只有在 Pod 调度后才会绑定 | 检查 `kubectl get sc` 以及 `Elasticsearch` 资源的 `volumeClaimTemplates` |

## 参考资料

- [Elastic Cloud on Kubernetes](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s)
- [使用 YAML 清单安装 ECK](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/install-using-yaml-manifest-quickstart)
- [部署 Elasticsearch 集群](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/elasticsearch-deployment-quickstart)
- [部署 Kibana 实例](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/kibana-instance-quickstart)
- [离线安装](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/air-gapped-install)
- [ECK 发行说明](https://www.elastic.co/docs/release-notes/cloud-on-k8s)
- [Elastic 许可](https://www.elastic.co/pricing/faq/licensing)

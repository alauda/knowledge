---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3,4.4'
id: KB261000005
sourceSHA: 11210f711dd1af8a0b028a2dd1ebe12109d0741e4d99300d88bd50268263d0bd
---

<!--
  Authoring model (oss-operator-factory): this guide is authored ONCE by hand. On later
  External Secrets Operator releases, only the slots fenced with `factory:auto:*` markers below are
  updated by the factory pipeline (version, supported versions, known limitations).
  Do NOT hand-edit inside a factory:auto block — those are regenerated from component.yaml /
  release evidence. Prose outside the markers is human-owned and preserved across releases.
-->

# External Secrets Operator — 安装指南

## 概述

**External Secrets Operator** (ESO) 是开源的
[External Secrets Operator](https://external-secrets.io/)，一个CNCF项目，列在Alauda Cloud
市场上，并可以从ACP OperatorHub中安装。该包是社区发布，其代码和镜像未被修改。

ESO 从外部秘密存储中读取秘密，并将其写入普通的Kubernetes Secrets，然后保持同步。应用程序继续使用Kubernetes Secret；值本身存储在您的安全团队已经运行的存储中：

- **HashiCorp Vault**、AWS Secrets Manager / Parameter Store、Google Secret Manager、Azure Key Vault，
  以及许多其他提供商。
- **另一个Kubernetes命名空间或集群**，通过`kubernetes`提供者。

您通过两个资源描述同步：

| 资源                                                              | 说明                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `SecretStore`（一个命名空间）/ `ClusterSecretStore`（整个集群） | **从哪里**读取，以及如何进行身份验证                          |
| `ExternalSecret`                                                  | **读取什么**，以及将其写入哪个Kubernetes Secret             |

### 支持的版本

<!-- factory:auto:supported-versions BEGIN -->

| 项目                               | 版本                   |
| ---------------------------------- | ---------------------- |
| ACP                                | 4.1, 4.2, 4.3, 4.4     |
| 架构                              | amd64 (x86_64), arm64 |
| 网络                              | IPv4                   |
| External Secrets Operator (bundle) | v0.14.4                |
| External Secrets Operator          | 0.14.4                 |
| 从...升级                         | 0.10.7 (amd64)         |
| 许可证                            | Apache-2.0             |

<!-- factory:auto:supported-versions END -->

## 先决条件

- 一个支持的版本的ACP集群，并且具有`cluster-admin`访问权限。
- 集群的OperatorHub中可用的**External Secrets Operator**插件。如果尚未上传，管理员可以使用`violet` CLI推送它：
  ```bash
  violet push external-secrets-operator.<version>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- 针对目标集群配置的`kubectl`。
- **每个集群只能有一个ESO。** 如果集群已经运行来自市场的ESO 0.10.7，请不要安装第二个副本 — 请[升级它](#upgrade-from-0107)。

## 安装Operator

1. 在ACP控制台中，转到**管理员 > 市场 > OperatorHub**，选择目标集群，找到**External Secrets Operator**，然后点击**安装**。
2. 保持默认通道（`alpha`；`stable`携带相同版本）和**集群**安装模式（所有命名空间）。对于**安装位置**，建议的命名空间是**`external-secrets`**。
3. 确认安装。

安装Operator并不会立即启动ESO。ESO本身是通过`OperatorConfig`资源部署的 — 每个集群一个，在Operator的命名空间中：

```yaml
apiVersion: operator.external-secrets.io/v1alpha1
kind: OperatorConfig
metadata:
  name: cluster
  namespace: external-secrets
spec: {}
```

```bash
kubectl apply -f operatorconfig.yaml
```

`spec: {}`保持出厂默认值，这是推荐的起始点：它们通过Pod安全`restricted`配置，并固定插件携带的镜像，因此它们也可以在隔离集群中工作。

### 验证安装

```bash
kubectl -n external-secrets get csv | grep external-secrets-operator
kubectl -n external-secrets get operatorconfigs.operator.external-secrets.io cluster \
  -o jsonpath='{.status.conditions[?(@.type=="Deployed")].status}{"\n"}'
kubectl -n external-secrets get deploy
```

始终使用完整名称`operatorconfigs.operator.external-secrets.io`：ACP上的其他组件（例如Ceph CSI驱动程序）也定义了一个名为`OperatorConfig`的类型，而裸`kubectl get operatorconfig`可能会显示其中一个。

预期结果：

- 条目`external-secrets-operator.v0.14.4`达到阶段`Succeeded`；
- `OperatorConfig`报告`True`；
- 四个部署已准备就绪：Operator（`external-secrets-operator-controller-manager`）和ESO本身（`cluster-external-secrets`、`cluster-external-secrets-webhook`、`cluster-external-secrets-cert-controller`）。

ESO服务整个集群：您在应用程序的命名空间中创建`SecretStore`和`ExternalSecret`资源，而不是在`external-secrets`中。

## 快速开始：从另一个命名空间复制一个Secret

此示例不需要外部系统：它使用ESO的`kubernetes`提供者从一个命名空间（`eso-source`）读取一个Secret，并将其写入另一个（`eso-demo`）。这是查看ESO端到端工作的最快方法。

### 1. 一个源Secret，以及一个可以读取它的身份

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: eso-source
---
apiVersion: v1
kind: Namespace
metadata:
  name: eso-demo
---
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: eso-source
type: Opaque
stringData:
  password: change-me
---
# ESO用于读取eso-source的身份：eso-demo中的ServiceAccount ...
apiVersion: v1
kind: ServiceAccount
metadata:
  name: eso-reader
  namespace: eso-demo
---
# ... 被允许读取eso-source中的Secrets，且没有其他权限。
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: eso-reader
  namespace: eso-source
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: eso-reader
  namespace: eso-source
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: eso-reader
subjects:
  - kind: ServiceAccount
    name: eso-reader
    namespace: eso-demo
```

### 2. 存储和ExternalSecret

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: source-namespace
  namespace: eso-demo
spec:
  provider:
    kubernetes:
      remoteNamespace: eso-source
      server:
        url: https://kubernetes.default.svc
        caProvider:
          type: ConfigMap
          name: kube-root-ca.crt
          key: ca.crt
      auth:
        serviceAccount:
          name: eso-reader
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: eso-demo
spec:
  refreshInterval: 1m
  secretStoreRef:
    kind: SecretStore
    name: source-namespace
  target:
    name: db-credentials
    creationPolicy: Owner
  data:
    - secretKey: password
      remoteRef:
        key: db-credentials
        property: password
```

### 3. 检查结果

```bash
kubectl -n eso-demo get secretstore source-namespace
kubectl -n eso-demo get externalsecret db-credentials
kubectl -n eso-demo get secret db-credentials -o jsonpath='{.data.password}' | base64 -d; echo
```

预期结果：存储显示`Valid`和`Ready=True`，ExternalSecret显示`SecretSynced`和`Ready=True`，最后一条命令打印`change-me`。

更改源后，副本将在`refreshInterval`内跟随：

```bash
kubectl -n eso-source create secret generic db-credentials \
  --from-literal=password=rotated --dry-run=client -o yaml | kubectl apply -f -
```

## 从HashiCorp Vault读取秘密

对于每个外部存储，模式是相同的：一个带有该提供者身份验证的`SecretStore`，以及命名密钥的`ExternalSecret`。此示例从Vault读取KV版本2的秘密，使用Kubernetes身份验证方法进行身份验证，因此在集群中不存储Vault令牌。

### 在Vault端

使用Vault管理员令牌（`VAULT_ADDR`指向您的Vault）运行以下命令：

```bash
# 让Vault验证来自此集群的Kubernetes ServiceAccount令牌。
vault auth enable kubernetes
vault write auth/kubernetes/config kubernetes_host=https://<cluster-api-server>:6443

# 对一个路径的只读访问。
vault policy write eso-read - <<'EOF'
path "secret/data/app/*" { capabilities = ["read"] }
EOF

# 将该策略绑定到一个命名空间中的一个ServiceAccount。
vault write auth/kubernetes/role/eso-demo \
  bound_service_account_names=eso-vault \
  bound_service_account_namespaces=eso-demo \
  policies=eso-read ttl=10m

# 要读取的秘密。
vault kv put -mount=secret app/db password=change-me
```

Vault调用集群的TokenReview API来验证ESO呈现的ServiceAccount令牌。如果Vault在集群外部运行，请参阅Vault文档中的
[Kubernetes身份验证](https://developer.hashicorp.com/vault/docs/auth/kubernetes)以获取您的设置所需的审核令牌和CA选项。

### 在集群端

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: eso-vault
  namespace: eso-demo
---
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault
  namespace: eso-demo
spec:
  provider:
    vault:
      server: https://vault.example.com:8200
      path: secret
      version: v2
      auth:
        kubernetes:
          mountPath: kubernetes
          role: eso-demo
          serviceAccountRef:
            name: eso-vault
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-db
  namespace: eso-demo
spec:
  refreshInterval: 1m
  secretStoreRef:
    kind: SecretStore
    name: vault
  target:
    name: app-db
    creationPolicy: Owner
  data:
    - secretKey: password
      remoteRef:
        key: app/db
        property: password
```

将`server`替换为您的Vault地址。如果Vault的证书未由公共CA签名，请在`spec.provider.vault.caProvider`下添加其CA（一个包含CA证书的ConfigMap或Secret）。

以与快速开始相同的方式检查：存储达到`Ready=True`，ExternalSecret达到`SecretSynced`，Secret `app-db`持有来自Vault的值。

如果Vault随后拒绝ESO（例如角色被删除），ExternalSecret将变为`Ready=False`，原因是`SecretSyncedError`，而Kubernetes Secret **保持其最后的值** — 它不会被清空或删除。一旦恢复访问，它将赶上。

## 从0.10.7升级

从市场安装的**External Secrets Operator 0.10.7**的集群就地升级：
0.14.4作为同一市场条目的下一个版本发布，位于`alpha`和`stable`通道上。

- 现有的`OperatorConfig`及其设置的每个值都将保留；新的Operator接管相同的ESO安装并进行升级。
- 现有的`SecretStore`、`ClusterSecretStore`和`ExternalSecret`资源将继续工作，并且它们管理的Kubernetes Secrets在升级期间**不会被删除或清空**。
- ESO Pods会重启一次。

要升级：

1. 在ACP控制台中，打开**管理员 > 市场 > OperatorHub**，选择集群，打开**External Secrets Operator**并批准待处理的升级到0.14.4。或者，使用`kubectl`，在安装了0.10.7的命名空间中：
   ```bash
   kubectl -n <operator-namespace> get installplan
   kubectl -n <operator-namespace> patch installplan <name> --type merge -p '{"spec":{"approved":true}}'
   ```
2. 验证：
   ```bash
   kubectl -n <operator-namespace> get csv | grep external-secrets-operator
   kubectl get externalsecrets -A
   ```
   预期结果：`external-secrets-operator.v0.14.4`达到`Succeeded`，0.10.7条目消失，ExternalSecrets仍然是`SecretSynced`。

### 升级集群的变化

- **添加四种新资源类型**：`ClusterGenerator`、`GeneratorState`、`Grafana`和`QuayAccessToken`生成器。现有的API版本不变。
- **Operator的指标端点移动**：从普通HTTP的8080端口移动到HTTPS的8443端口，并使用Kubernetes RBAC授权。更新任何读取Operator指标的抓取配置。
- **格式错误的引用行为与0.10.7相同**：具有无效引用的`SecretStore`或`ExternalSecret`被接受，并在ESO处理时在其状态中报告错误（`Ready=False`），而不是在创建时被拒绝。

## 已知限制

<!-- factory:auto:known-limitations BEGIN -->

- **每个集群只能有一个ESO。** 创建一个`OperatorConfig`，并且不要与此Operator一起从其他来源安装ESO。
- **仅支持从0.10.7升级到amd64**，因为0.10.7仅为amd64发布。新安装可以在amd64和arm64上工作。
- **0.14.4超出了上游支持窗口**：ESO项目仅维护其最新的小版本发布。
- **Bitwarden Secrets Manager**提供者不可用：其SDK服务器组件被禁用，因为其镜像不是插件的一部分。
- 在安装或升级后，短时间内通过旧的`v1alpha1` API读取`ExternalSecret`可能会失败，直到ESO的转换webhook拥有其证书。`v1beta1`不受影响。

<!-- factory:auto:known-limitations END -->

## 卸载

1. 删除您不再需要的`ExternalSecret`、`SecretStore`和`ClusterSecretStore`资源。使用`creationPolicy: Owner`创建的Kubernetes Secret将与其ExternalSecret一起删除 — 如果应用程序仍然需要Secret，请保留ExternalSecret。
2. 删除`OperatorConfig`，这将移除ESO本身：
   ```bash
   kubectl -n external-secrets delete operatorconfigs.operator.external-secrets.io cluster
   ```
3. 从OperatorHub中卸载**External Secrets Operator**。

资源定义（CRDs）在卸载后仍保留在集群中，以便移除Operator时不会意外删除您的ExternalSecrets或它们拥有的Secrets。仅在确定没有这些类型的资源剩余时才删除它们：

```bash
kubectl get crd -o name | grep -E 'external-secrets\.io$'
```

## 常见问题解答

**如果外部存储不可访问，Kubernetes Secret会被删除吗？**
不会。ExternalSecret报告`Ready=False`，原因是`SecretSyncedError`，Secret保持其最后同步的值，直到存储再次可访问。

**存储中的更改多快会到达Secret？**
在ExternalSecret的`refreshInterval`（示例中为`1m`）内。设置`refreshInterval: 0`以一次性同步并不再刷新。

**多个命名空间可以共享一个存储吗？**
可以：使用`ClusterSecretStore`而不是`SecretStore`。它具有相同的`spec.provider`，任何命名空间中的`ExternalSecret`都可以通过`secretStoreRef.kind: ClusterSecretStore`引用它。

**提供者和选项的完整列表在哪里？**
在此版本的上游文档中：<https://external-secrets.io/v0.14.4/>。

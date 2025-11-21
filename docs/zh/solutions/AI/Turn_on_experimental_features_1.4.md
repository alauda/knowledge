---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 1.4
id: KB1763720171-AC5D
sourceSHA: 13b91cfc6fb279b4a98edd599dbf601f2ed838aa3dad66902f55f622b5cb44ad
---

# 在 Alauda AI 1.4 中启用实验性功能

> **注意：**
> 某些 Alauda AI 的插件仅支持 x86_64(amd64) CPU 架构，实验性功能目前不支持其他 CPU 架构，如 arm64。

## 先决条件

- 已安装 ACP 和 AML。
- 部署 Istio（版本 >= 1.22，非 CNI 模式）。您也可以利用 ASM 来部署 Istio。
- 准备一个运行中的 MySQL 服务。请注意，“Kubeflow Pipeline” 插件仅支持 MySQL 版本 == 5.7，因此您可以选择以下部署方法：
  - **选项 1：** 使用 ACP 数据服务部署一个 MySQL MGR 实例（MySQL 版本 >= 8.0），并在下面的“AmlCluster”配置中使用此服务。“Kubeflow Pipeline”可以选择使用内置的 MySQL 服务（Kubeflow pipeline 不支持 MySQL 版本 >= 8.0）。
  - **选项 2：** 使用 ACP 数据服务部署一个 MySQL PXC 实例（MySQL 版本 == 5.7），并在“AmlCluster”配置和“Kubeflow Pipeline”中使用此服务。
  - 连接到其他现有的 MySQL 服务。
- 为 MLFlow 准备一个 PostgreSQL 服务。
- **可选：** 为“Kubeflow Pipeline”准备一个 MinIO 对象存储服务。或者您可以选择使用内置的单实例 MinIO 服务（不支持 HA）。

## 为 istio 设置 oauth2-proxy 设置：

在 `global` 集群中运行以下命令以首先获取 CA 证书：

```bash
crt=$(kubectl get secret -n cpaas-system dex.tls -o jsonpath='{.data.tls\.crt}')
echo -n $crt | base64 -d
```

前往“管理员 - 集群 - 资源”，在上方标题中选择 `global` 集群，然后找到并编辑资源“ServiceMesh”，在“spec”部分下添加以下内容（对于 servicemesh v2，请寻求帮助）。

注意：如果在部署其他应用程序时 `spec.values.pilot.jwksResolverExtraRootCA` 已经设置，您可以仅为 Kubeflow 设置 `spec.meshConfig.extensionProviders`。请 **不要** 删除 `spec.meshConfig.extensionProviders` 中已存在的配置。

<details>

<summary>ServiceMesh</summary>

```yaml
overlays:
  - kind: IstioOperator
    patches:
      - path: spec.values.pilot.env.PILOT_JWT_PUB_KEY_REFRESH_INTERVAL
        value: 1m
      - path: spec.values.pilot.jwksResolverExtraRootCA
        value: |
          -----BEGIN CERTIFICATE-----
          MIIDKzCCAhOgAwIBAgIRAK9C9PuDXtYFvybudWQkN4UwDQYJKoZIhvcNAQELBQAw
          EDEOMAwGA1UEChMFY3BhYXMwHhcNMjUwMzEwMDkxODAzWhcNMzUwMzA4MDkxODAz
          WjASMRAwDgYDVQQKEwdrdWJlLWNhMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB
          CgKCAQEAmChGjtwWOPvj0Ca3TkuPxxx6jg4oDTAPqyowT2pcaVeNhFwoMmCCkFXm
          7brFKXCc7IE1kHq5dbRCn+UwCA46g7zvz8b7SY/0qRymwTlYqRILDZacwWHUSJSD
          cDyK297V+Ig5oIno6fTa2FWSJBqyxqivZ3lzf1XpsiwSPPXol+LclUne0fDiM98C
          dBQWKDYadwlcluuPUHULthA3OjcKGpmyV7cyTHPcRjBSmkAmuL0bQhbWhkB8G9oe
          4cp2joo/qVsSzeUepkHeTD9PPk1AZ59FE8DDgL0FRREE7vou6g7fbOZL98pC4ldg
          ZIY/EB5v38uR6J25uzLPFSf75vbwHwIDAQABo34wfDAOBgNVHQ8BAf8EBAMCBaAw
          DAYDVR0TAQH/BAIwADAfBgNVHSMEGDAWgBQk8E8JWyAANbALLaeAxZ17adgq/TA7
          BgNVHREENDAyggVjcGFhc4ILZXhhbXBsZS5jb22HBH8AAAGHEAAAAAAAAAAAAAAA
          AAAAAAGHBMCoq/MwDQYJKoZIhvcNAQELBQADggEBAIXo0V2jMeRd4cw5p3FWoFno
          VWno7Cy7ENvVjgfQymcWbGi6fXWvkDBUPCmqv5bosUVyAOJ/p92g861nCAo3jxoZ
          voCTDN4xU+t0xs2hMTKHsSB7v3n18rBtqcVpUvm1it/NyeOU4HiYfPTPkRVugGf4
          gtYknrU6Skt9BkiNy+2Jcsb6V3mAJ5GQzbT0qPL1vKWkBB9oCbjMwJggsW+TdKgY
          KJuII0m6JNDUlKLCazLL8OvXq84Nu+cJ6QaNOT0gBRIWSPA+UbAsibbFnf0VOeeU
          WforZLredR6GKc2qMdKdcW4G+8fRSWcx0gEIRquoQH1P7yIEJ3xOGoxQfIRVpls=
          -----END CERTIFICATE-----
      - path: spec.meshConfig.extensionProviders
        value:
          envoyExtAuthzHttp:
            headersToDownstreamOnDeny:
              - content-type
              - set-cookie
            headersToUpstreamOnAllow:
              - authorization
              - path
              - x-auth-request-user
              - x-auth-request-email
              - x-auth-request-access-token
            includeAdditionalHeadersInCheck:
              X-Auth-Request-Redirect: http://%REQ(Host)%%REQ(:PATH)%
            includeRequestHeadersInCheck:
              - authorization
              - cookie
              - accept
            port: "80"
            service: oauth2-proxy.kubeflow-oauth2-proxy.svc.cluster.local
          name: oauth2-proxy-kubeflow
```

</details>

## 部署插件

从 <https://cloud.alauda.cn> 或 <https://cloud.alauda.io> 下载以下插件工件，并将这些插件推送到 ACP 平台。

- Workspace：AML 工作区的后端控制器。
- KubeflowBase：Kubeflow 的基础组件。安装此插件后，AML 导航栏中应出现“Kubeflow”菜单项。
- Kubeflow Pipeline：支持开发、运行、监控 kubeflow 流水线。（默认使用 argo 作为 kubeflow 流水线后端）。
- Kubeflow Training Operator：管理各种深度学习框架的训练作业，如 PytorchJob、TensorflowJob、MPIJob。
- MLFlow：用于跟踪训练实验的 MLFlow 跟踪服务器。安装此插件后，AML 导航栏中应出现“MLFlow”菜单项。
- Volcano：使用各种调度程序插件（包括 Gang-Scheduling、Binpack 等）调度训练作业。

```bash
# 注意：替换您的平台地址、用户名、密码和集群名称。
violet push --platform-address="https://192.168.171.123" \
  --platform-username="admin@cpaas.io" \
  --platform-password="<platform_password>" \
  <your downloaded plugin package file>
```

前往“管理员 - 市场 - 上传软件包”，然后切换到“集群插件”选项卡，找到已上传的插件，并验证这些插件的版本是否正确同步。

然后前往“管理员 - 市场 - 集群插件”，找到这些插件，点击右侧的“...”按钮，然后点击“安装”。如果插件需要一些设置，请填写表单，然后点击“安装”将“集群插件”安装到当前集群中。

> **注意：** 这些集群插件可以安装在单个集群上。如果您需要在不同的集群中使用它们，可能需要在另一个集群中再次安装它们。

> **注意：** 在安装 Kubeflow Training Operator 插件时，如果您想启用 volcano 调度功能，您需要在安装 Kubeflow Training Operator 之前安装 volcano 插件。

### 设置 KubeflowBase 插件时的注意事项

#### 创建 istio ingress 网关作为 kubeflow 的 Web 入口

在 Alauda Service Mesh 的“管理员”视图下创建一个 istio ingress 网关实例。使用 NodePort 访问网关服务。然后找到网关的 pod，并复制标签，如“istio: wy-kubeflow-gw-kubeflow-gw”，在安装 KubeflowBase 时填写表单。

#### 设置 dex 重定向 URI

在 `global` 集群中运行 `kubectl -n cpaas-system edit configmap dex-configmap`，并在 `redirectURI` 中添加字段：

```yaml
redirectURIs:
- ...
# 添加以下配置行。注意：重定向地址必须与步骤 3 中的 oidcRedirectURL 一致：
- https://192.168.139.133:30665/oauth2/callback
```

#### 创建 Kubeflow 用户并绑定到命名空间

在首次登录 Kubeflow 之前，您需要将 ACP 用户绑定到命名空间。在以下示例中，您可以创建命名空间 `kubeflow-admin-cpaas-io` 并将用户 `admin@cpaas.io` 绑定为其所有者。

> **注意：** 如果在部署 AML 时此配置资源已经部署，您可以跳过此步骤。

```yaml
apiVersion: kubeflow.org/v1beta1
kind: Profile
metadata:
  name: kubeflow-admin-cpaas-io
spec:
  owner:
    kind: User
    name: "admin@cpaas.io"
```

#### 修复无法选择 kubeflow-admin-cpaas-io 命名空间的问题

如果您已经部署了 AML，创建了 kubeflow-admin-cpaas-io 命名空间，并在上一步中创建了 Profile 资源，但仍然无法选择命名空间，请参考以下资源为您的帐户创建角色绑定。

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: user-admin-cpaas-io-clusterrole-admin
  namespace: kubeflow-admin-cpaas-io
  annotations:
    role: admin
    user: "admin@cpaas.io"
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kubeflow-admin
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: User
    name: "admin@cpaas.io"
---
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: user-admin-cpaas-io-clusterrole-admin
  namespace: kubeflow-admin-cpaas-io
  annotations:
    role: admin
    user: "admin@cpaas.io"
spec:
  rules:
    - from:
        - source:
            ## 有关更多信息，请参见 KFAM 代码：
            ## https://github.com/kubeflow/kubeflow/blob/v1.8.0/components/access-management/kfam/bindings.go#L79-L110
            principals:
              ## kubeflow 笔记本所需
              ## 模板： "cluster.local/ns/<ISTIO_GATEWAY_NAMESPACE>/sa/<ISTIO_GATEWAY_SERVICE_ACCOUNT>"
              - "cluster.local/ns/istio-system/sa/istio-ingressgateway-service-account"
 
              ## kubeflow 流水线所需
              ## 模板： "cluster.local/ns/<KUBEFLOW_NAMESPACE>/sa/<KFP_UI_SERVICE_ACCOUNT>"
              - "cluster.local/ns/kubeflow/sa/ml-pipeline-ui"
      when:
        - key: request.headers[kubeflow-userid]
          values:
            - "admin@cpaas.io"
```

### 设置 Kubeflow Pipeline 插件时的注意事项

在安装 Kubeflow 流水线插件时填写表单时，您可以使用外部 MySQL 服务或 Minio 服务，或选择使用内置服务。请注意：

- 内置的 MySQL 和 Minio 服务是单 pod 服务，可能会遭受单点故障。
- 使用外部 MySQL 服务时，MySQL 服务必须为“MySQL 5.7”版本。如果没有这样的服务，请使用内置的 MySQL。

### 设置 MLFlow 插件时的注意事项

您需要设置一个 PostgreSQL 服务，并填写 pgHost、pgPort、pgUsername、pgPassword 值。MySQL 不再支持（在 mlflow >= v3.1.1 后）。

### 上传镜像

您需要上传一些 AML 将用于某些实验性功能的镜像。下载以下镜像并上传到当前 ACP 镜像注册表：

```
build-harbor.alauda.cn/mlops/llm-trainer:v1.4.3
build-harbor.alauda.cn/mlops/buildkit-gitlfs:v0.13-rootless-aml
build-harbor.alauda.cn/mlops/buildkit:v0.15.2-aml
```

> **重要：** 上传 [build-harbor.alauda.cn/mlops/llm-trainer:v1.4.3](http://build-harbor.alauda.cn/mlops/llm-trainer:v1.4.3) 后，您需要通过运行以下命令检查 Alauda AI 正在使用的实际镜像地址和标签：`kubectl -n kubeflow get cm aml-image-builder-config -o yaml  | grep llm-trainer`，然后添加在 configmap 中使用的标签并指向上传的镜像，例如 `nerdctl tag your.registry.com/mlops/llm-trainer:v1.4.3 your.registry.com/mlops/llm-trainer:v1.4.2-rc.1.ge47ab59d`。

## 在 AML UI 上启用实验性功能

前往“市场 - OperatorHub - Alauda AI”，进入“All Instances”选项卡，找到“资源类型：AmlCluster，名称 default”这一行，点击右侧的“...”按钮并选择更新，然后切换到右上角的“YAML”模式并编辑 YAML 文件以包含以下设置。

```yaml
spec:
  values:
    experimentalFeatures:
      datasets: true # 开启数据集
      imageBuilder: true # 开启镜像构建器
      tuneModels: true # 开启微调和训练
    global:
      mysql:
        database: aml # 数据库名称
        host: 10.4.158.198 # 数据集主机
        passwordSecretRef:
          name: aml-mysql-root-token  # kubectl create secret generic aml-mysql-root-token --from-literal="password=<mysql_root_password>" -n cpaas-system
          namespace: cpaas-system
        port: 3306 # 数据库端口
        user: root # 数据库用户
```

前往“市场 - OperatorHub - Alauda AI”，进入“All Instances”选项卡，找到“资源类型：Aml，名称 default-aml”这一行，点击右侧的“...”按钮并选择更新，然后切换到右上角的“YAML”模式并编辑 YAML 文件以包含以下设置。

```yaml
spec:
  values:
    amlService:
      trainingPVCSize: 10Gi
      trainingPVCStorageClass: sc-topolvm
      notebookStorageClass: sc-topolvm
```

通过运行以下命令重启 aml-api-deploy 组件：`kubectl -n kubeflow rollout restart deploy aml-api-deploy`

如果您使用微调和训练功能，请更新相应命名空间下的 `aml-image-builder-config` configmap：

```yaml
apiVersion: v1
data:
  ...
  MODEL_REPO_BUILDER_DB_DB: aml # 数据库名称
  MODEL_REPO_BUILDER_DB_HOST: mysql.kubeflow # 数据库主机
  MODEL_REPO_BUILDER_DB_PORT: "3306" # 数据库端口
  MODEL_REPO_BUILDER_DB_USER: root # 数据库用户
kind: ConfigMap
metadata:
  name: aml-image-builder-config
  namespace: {your-ns}
```

以及 `aml-image-builder-secret` 密钥：

```yaml
apiVersion: v1
data:
  ...
  MODEL_REPO_BUILDER_DB_PASSWORD: ""  # 数据库密码
kind: Secret
metadata:
  name: aml-image-builder-secret
  namespace: {your-ns}
type: Opaque
```

### 关闭实验性功能并卸载插件

1. 要关闭实验性功能，前往“市场 - OperatorHub - Alauda AI”，进入“All Instances”选项卡，找到“资源类型：AmlCluster，名称 default-aml”这一行，点击右侧的“...”按钮并选择更新，然后切换到右上角的“YAML”模式并删除之前添加的以下行：

```yaml
spec:
  values:
    # 删除以下行
    experimentalFeatures:
      datasets: true
      imageBuilder: true
      tuneModels: true
```

2. 要卸载为 Alauda AI 安装的插件，前往“管理员” - “市场” - “集群插件”，找到以下插件，如果已经安装，您可以点击右侧的“...”并点击“卸载”。请注意，您应按以下列出的顺序删除这些插件：

3. MLFlow

4. Kubeflow Training Operator

5. Kubeflow Pipelines

6. Kubeflow Base

7. 在大多数情况下，您不需要卸载 volcano 插件，因为它只是一个基本的“低级”组件，不会影响其他组件。保留 volcano 安装，您将能够在想要重新安装 Alauda AI 时恢复微调、训练作业状态。不过，您仍然可以在“集群插件”下卸载 volcano，风险自负。

### 从 Alauda AI 1.3（1.3\~1.4）升级到实验性功能

在将 AML 从 1.3 升级到 1.4 后，如果之前的 1.3 安装是以实验性功能部署的，您需要遵循以下步骤卸载之前版本的插件并将其升级到 Alauda AI 1.4 的插件。

> **警告：** 此操作将删除旧版本的 Kubeflow、volcano 和 MLFlow 以及使用这些组件创建的实例，包括笔记本、tensorboards、mlflow 实验记录（这可能导致“微调”作业中的跟踪图表丢失）。如果您需要备份数据并在新版本中恢复，请查看以下步骤以获取详细信息。

#### 备份笔记本、tensorboards、mlflow 和 MySQL 使用的数据

1. 笔记本
2. 只需保留用户命名空间下之前创建的 PVC。请勿在更新期间或用户命名空间中删除它们。
3. **注意：** 如果您有之前运行的笔记本并安装了额外的依赖项，如使用 `pip install`，当在新版本中重新创建笔记本时，这些依赖项将丢失，您需要重新安装它们。
4. Tensorboards
   1. 同上，保留 PVC 和用户命名空间。
5. MLFlow
   1. **注意：** Alauda AI 1.4 的 mlflow 将更改为使用 PostgreSQL 作为跟踪服务器数据库。如果数据很重要，您必须执行以下步骤备份 mlflow 数据。
   2. 您可以使用此工具 <https://github.com/mlflow/mlflow-export-import> 从 mlflow 跟踪服务器导出当前数据，然后导入到新版本中。
   3. **注意：** Alauda AI 1.3 附带 mlflow 2.6.0，而 Alauda AI 1.4 升级到 v3.1.1。因此，请确保导出的数据可以导入到此新版本中。
6. 如果您已经执行了“在 Alauda AI 1.3 中启用所有功能”的步骤，您将拥有一个 MySQL 数据库实例。如果此 MySQL 实例是某个独立服务（未通过 Alauda AI 或 kubeflow 插件安装），您可以重用此实例并在升级后保留记录。为确保数据不会丢失，您需要手动备份数据库（例如 <https://stackoverflow.com/questions/8725646/backing-up-mysql-db-from-the-command-line>）或使用 Alauda 数据服务提供的功能。

#### 删除笔记本、Tensorboard 实例（可选）

您可以选择删除现有的笔记本和 Tensorboard 实例。然后在升级后重新创建它们。

> **注意：** 如果您选择保留笔记本和 Tensorboards 实例，升级后，这些“旧”实例可能无法正常工作。您可以自行承担风险。

#### 等待所有微调和训练作业完成

如果集群中仍有微调、训练作业正在运行，您需要等待它们完成。在升级过程中请勿创建新作业。

> **注意：** 在卸载之前的“kubeflow 插件”后，所有 volcano 作业（简称 vcjob）资源将被删除。因此，作业状态、pod 日志将被删除。但由于微调作业已完成，作业记录将保存在 MySQL 数据库中。如果您已备份 MySQL 数据库，或只是重用相同的独立 MySQL 实例，所有作业记录在升级后应可用。

但请注意，实际的“作业” k8s 资源在删除后丢失。

#### 将 Alauda AI 从 1.3 升级到 1.4

在完成上述备份、删除步骤后，您可以进行一般升级，将 Alauda AI 从 1.3 升级到 1.4。

#### 卸载 kubeflow chart 插件

在“Alauda Container Platform”中 - 选择安装了 Alauda AI 1.3 的 kubeflow 的命名空间 - “应用程序” - “应用程序”，找到 Kubeflow 插件部署，选择“...” - “删除”。等待完成。

#### 按以下顺序安装 Alauda AI 1.4 的插件

请从本文件的开头获取有关安装 Alauda AI 1.4 插件的更多详细信息。

1. kfbase: Kubeflow Base
2. kfp: Kubeflow Pipelines
3. volcano
4. kftraining: Kubeflow Training Operator
5. MLFlow

#### 检查实验性功能开关和 MySQL 连接

检查“管理员 - 集群 - 资源”下的“AmlCluster”资源（在顶部栏中选择当前集群）。检查资源 YAML 代码是否已经包含在 [启用实验性功能](#turn-on-experimental-features-on-aml-ui) 中提到的设置。如果您使用相同的 MySQL 实例，请检查微调作业记录是否仍然可用。如果没有，您可能需要去 MySQL 实例检查数据是否可用或恢复数据库备份。

如果在之前的 Alauda AI 1.3 安装中未启用实验性功能，您需要从头开始查看文档以启用实验性功能。

前往“管理员 - 集群 - 资源”，选择 **CURRENT** 集群，然后更新“AmlCluster”资源：“default”，检查以下字段是否为最新：

```yaml
spec:
  values:
    experimentalFeatures:
      datasets: true # 开启数据集
      imageBuilder: true # 开启镜像构建器
      tuneModels: true # 开启微调和训练
    global:
      mysql:
        database: aml # 数据库名称
        host: 10.4.158.198 # 数据集主机
        passwordSecretRef:
          name: aml-mysql-root-token  # kubectl create secret generic aml-mysql-root-token --from-literal="password=07Apples@" -n cpaas-system
          namespace: cpaas-system
        port: 3306 # 数据库端口
        user: root # 数据库用户
```

#### 创建 Kubeflow Profile 以启用用户命名空间访问 Kubeflow 组件（例如：笔记本）

前往 [创建 Kubeflow 用户](#create-kubeflow-user-and-bind-to-a-namespace) 为 kubeflow 用户创建配置文件，以访问 kubeflow 组件。

如果配置文件已经创建且未删除，则在安装新 kubeflow 插件后应可用。

如果您有之前未删除的笔记本实例，您仍然可以从“Alauda AI” - “高级” - “Kubeflow” - “笔记本”访问之前的笔记本实例。

#### 测试实验性功能是否正常工作

1. 以 Alauda AI 用户身份登录（具有命名空间授权），检查左侧导航栏是否有以下入口：
2. 数据集
3. 模型优化
4. 高级：
   1. Kubeflow
   2. MLFlow
5. 检查数据集是否可以缓存和预览
6. 创建一个简单的微调作业，查看作业是否可以成功运行
7. 为现有模型创建一个简单的镜像构建作业
8. 检查笔记本实例（如果有）是否可以从“高级” - “Kubeflow” - “笔记本”访问
9. 检查是否可以访问 mlflow web ui

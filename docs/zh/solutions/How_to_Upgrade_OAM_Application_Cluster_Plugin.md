---
products:
  - Alauda Container Platform
kind:
  - Solution
ProductsVersion:
  - 4.2
id: none
sourceSHA: 624c8833ab25ad2698f522e03e197973aecc2fd2ad84a928cc1b760779e2ac46
---

# 如何升级 OAM 应用集群插件

## 概述

本文档提供了在 ACP 管理的集群中升级 **OAM 应用** 集群插件的说明。它特别适用于当您的 ACP 平台版本从 **4.2 之前的版本升级到 4.2 或更高版本** 时。

## 先决条件

在进行集群插件升级之前，请确保满足以下条件：

- **插件已安装**：目标集群中已安装 OAM 应用插件。
- **ACP 平台已升级**：ACP 平台本身必须已成功升级到 4.2 或更高版本。
- **集群健康**：目标集群必须处于健康状态。请验证所有核心组件和节点正常运行。
- **管理员权限**：您必须在 ACP 中拥有必要的管理员权限（例如，集群管理员），以执行集群级插件的升级操作。

## 升级操作步骤

按照以下步骤升级 OAM 应用集群插件：

### 步骤 1：升级前检查与准备

1. 登录到 ACP Web 控制台。
2. 导航到 **管理员** 页面。
3. 点击 **Marketplace** > **集群插件** 打开集群插件管理页面。
4. 找到 **Alauda Container Platform Application Management for KubeVela** 插件，并确保其处于 **已安装** 状态。

### 步骤 2：关键手动配置更新

**重要：升级前需要手动操作**

在升级插件之前，您必须手动更新 `metis` 的 MutatingWebhookConfiguration 和 ValidatingWebhookConfiguration 资源，以删除特定的 webhook 配置，这将与新插件版本发生冲突。

**此操作的原因**：

在之前的 ACP 版本（4.2 之前），OAM 应用变更和验证的 webhook 配置由平台直接管理。在 ACP 4.2 中，此功能已迁移到集群插件的新版本中。如果不从旧资源中删除此 webhook 配置，将会导致冲突，因为重复的 webhook 将尝试处理相同的资源，可能导致准入错误或意外行为。

#### 2.1 更新 MutatingWebhookConfiguration

1. 备份当前配置（推荐）：
   ```bash
   kubectl get mutatingwebhookconfiguration metis-mutation -o yaml > metis-mutation-backup.yaml
   ```
   恢复说明：如果在升级后出现问题并需要恢复到之前的状态，请使用：
   ```bash
   kubectl apply -f metis-mutation-backup.yaml
   ```
2. 编辑配置以删除名为 `oamapp.cpaas.io` 的 webhook：
   ```bash
   kubectl edit mutatingwebhookconfiguration metis-mutation
   ```
3. 在编辑器中，找到名称为 `oamapp.cpaas.io` 的 webhook 条目，并删除整个 webhook 块（从 - admissionReviewVersions: 到 timeoutSeconds: 10）。要删除的块如下所示：
   ```yaml
   - admissionReviewVersions:
       - v1
       - v1beta1
       clientConfig:
       caBundle: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURCekNDQWUrZ0F3SUJBZ0lSQU95N05ON2RCK3owYnVuRGdHdVhpSmt3RFFZSktvWklodmNOQVFFTEJRQXcKQURBZUZ3MHlOVEV3TWpjd09EVTJORE5hRncwek5URXdNalV3T0RVMk5ETmFNQUF3Z2dFaU1BMEdDU3FHU0liMwpEUUVCQVFVQUE0SUJEd0F3Z2dFS0FvSUJBUURGd1o5bGJhNU51Mmk1em5EZGEyMFhvV0ZIUlJnTjgwWVA2aE5nClg2QjVlek85TVc1T2dUQ2JWaURzUzdCMWRaeU55ZjdwaVBvcHFaV0EvMmt1L3k1OU56K01hZk9VS05XSXhjUTEKN3MxOXFHZUxHZDQ1WnJzZXRTZ1o3L2pCQ3ZVdnNCbGRaNjgrdG15YTZaWGVna3E5cm9PQ0VPbU5waEFZT2dCYQp0Ymw2UGxySmt2MW16d2QvNklCSXdWc3RCVS9tZkdFTlNJMEpyY25CcGsrUWNOYmxpTXpLb0F4Nk82TmJDVEkzCmh0TmNqb3Z2b1M1NjFMUTlnQVduNjhzQTZ1Zkg3WmVsYzI4MDVNa2pzeC9SV3djeEw5dVk4Uk5QTUM5N3FYQmoKVXRtaE0rL2tqQW1OWERqRXl2Nkh5dU5TblQ0ODhwbVN6OXRmY0pRdjg0Z3pWQUpCQWdNQkFBR2pmREI2TUE0RwpBMVVkRHdFQi93UUVBd0lGb0RBTUJnTlZIUk1CQWY4RUFqQUFNRm9HQTFVZEVRRUIvd1JRTUU2Q0htMWxkR2x6CkxYZGxZbWh2YjJzdVkzQmhZWE10YzNsemRHVnRMbk4yWTRJc2JXVjBhWE10ZDJWaWFHOXZheTVqY0dGaGN5MXoKZVhOMFpXMHVjM1pqTG1Oc2RYTjBaWEl1Ykc5allXd3dEUVlKS29aSWh2Y05BUUVMQlFBRGdnRUJBSXZSOVBFaApIRERabDQzU005UnpBQjEybHFEdk1UQVVsOU0wWjJoQUw3MTUrUFl6R1pySXpVKy81SHVKN0U1bFB4ekEyR01VCkRSOWQwZ2g0NnNja2ZQS0VzRG9yMWYybEVicVd2aDVFMTloanIycCtRMXNOTnE0ZDFZR0RoLytQMkVLUjhOOFgKN0x2RklGOU0ySjN6QWlwUlBRR0NDMkY0dkR0TnNCODBqVFBieDdmMWVPYXZMR3NGU2ltNmZBaHFwVEJXRStPVAo4VVNYdHpjdys0bDI0aGovSTUvOTl5dlJlSXRrVmhQY3NzVktHU2dmb3d1TEkxRVdrWEZXMXFDUDdxSzZzM3RUCnREVjJiV0k3RG9RYmZDNmlhVzB3MGZ0OHZVa01HQnV3QUdqakU3WWtGSkpNV1FlTDdrU1dhMnB5dXdUZWt1aGsKbmc3Qm13SU00SXVUcUZNPQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==
       service:
           name: metis-webhook
           namespace: cpaas-system
           path: /oam/app-mutate
           port: 443
       failurePolicy: Fail
       matchPolicy: Equivalent
       name: oamapp.cpaas.io
       namespaceSelector: {}
       objectSelector: {}
       reinvocationPolicy: Never
       rules:
       - apiGroups:
           - core.oam.dev
           apiVersions:
           - v1beta1
           operations:
           - CREATE
           - UPDATE
           resources:
           - applications
           scope: "*"
       sideEffects: NoneOnDryRun
       timeoutSeconds: 10
   ```
4. 保存更改并退出编辑器。
5. 验证 webhook 是否已被移除：
   ```bash
   kubectl get mutatingwebhookconfiguration metis-mutation -o yaml | grep -A5 "name: oamapp.cpaas.io"
   # 预期：无输出（未找到 webhook）
   ```

#### 2.2 更新 ValidatingWebhookConfiguration

1. 备份当前配置（推荐）：
   ```bash
   kubectl get validatingwebhookconfiguration metis-validation -o yaml > metis-validation-backup.yaml
   ```
   恢复说明：如果在升级后出现问题并需要恢复到之前的状态，请使用：
   ```bash
   kubectl apply -f metis-validation-backup.yaml
   ```
2. 编辑配置以删除名为 `oamapp.cpaas.io` 的 webhook：
   ```bash
   kubectl edit validatingwebhookconfiguration metis-validation
   ```
3. 在编辑器中，找到名称为 `oamapp.cpaas.io` 的 webhook 条目，并删除整个 webhook 块（从 - admissionReviewVersions: 到 timeoutSeconds: 10）。要删除的块如下所示：
   ```yaml
   - admissionReviewVersions:
       - v1
       - v1beta1
       clientConfig:
       caBundle: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURCekNDQWUrZ0F3SUJBZ0lSQU95N05ON2RCK3owYnVuRGdHdVhpSmt3RFFZSktvWklodmNOQVFFTEJRQXcKQURBZUZ3MHlOVEV3TWpjd09EVTJORE5hRncwek5URXdNalV3T0RVMk5ETmFNQUF3Z2dFaU1BMEdDU3FHU0liMwpEUUVCQVFVQUE0SUJEd0F3Z2dFS0FvSUJBUURGd1o5bGJhNU51Mmk1em5EZGEyMFhvV0ZIUlJnTjgwWVA2aE5nClg2QjVlek85TVc1T2dUQ2JWaURzUzdCMWRaeU55ZjdwaVBvcHFaV0EvMmt1L3k1OU56K01hZk9VS05XSXhjUTEKN3MxOXFHZUxHZDQ1WnJzZXRTZ1o3L2pCQ3ZVdnNCbGRaNjgrdG15YTZaWGVna3E5cm9PQ0VPbU5waEFZT2dCYQp0Ymw2UGxySmt2MW16d2QvNklCSXdWc3RCVS9tZkdFTlNJMEpyY25CcGsrUWNOYmxpTXpLb0F4Nk82TmJDVEkzCmh0TmNqb3Z2b1M1NjFMUTlnQVduNjhzQTZ1Zkg3WmVsYzI4MDVNa2pzeC9SV3djeEw5dVk4Uk5QTUM5N3FYQmoKVXRtaE0rL2tqQW1OWERqRXl2Nkh5dU5TblQ0ODhwbVN6OXRmY0pRdjg0Z3pWQUpCQWdNQkFBR2pmREI2TUE0RwpBMVVkRHdFQi93UUVBd0lGb0RBTUJnTlZIUk1CQWY4RUFqQUFNRm9HQTFVZEVRRUIvd1JRTUU2Q0htMWxkR2x6CkxYZGxZbWh2YjJzdVkzQmhZWE10YzNsemRHVnRMbk4yWTRJc2JXVjBhWE10ZDJWaWFHOXZheTVqY0dGaGN5MXoKZVhOMFpXMHVjM1pqTG1Oc2RYTjBaWEl1Ykc5allXd3dEUVlKS29aSWh2Y05BUUVMQlFBRGdnRUJBSXZSOVBFaApIRERabDQzU005UnpBQjEybHFEdk1UQVVsOU0wWjJoQUw3MTUrUFl6R1pySXpVKy81SHVKN0U1bFB4ekEyR01VCkRSOWQwZ2g0NnNja2ZQS0VzRG9yMWYybEVicVd2aDVFMTloanIycCtRMXNOTnE0ZDFZR0RoLytQMkVLUjhOOFgKN0x2RklGOU0ySjN6QWlwUlBRR0NDMkY0dkR0TnNCODBqVFBieDdmMWVPYXZMR3NGU2ltNmZBaHFwVEJXRStPVAo4VVNYdHpjdys0bDI0aGovSTUvOTl5dlJlSXRrVmhQY3NzVktHU2dmb3d1TEkxRVdrWEZXMXFDUDdxSzZzM3RUCnREVjJiV0k3RG9RYmZDNmlhVzB3MGZ0OHZVa01HQnV3QUdqakU3WWtGSkpNV1FlTDdrU1dhMnB5dXdUZWt1aGsKbmc3Qm13SU00SXVUcUZNPQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==
       service:
           name: metis-webhook
           namespace: cpaas-system
           path: /oam/app-validate
           port: 443
       failurePolicy: Fail
       matchPolicy: Equivalent
       name: oamapp.cpaas.io
       namespaceSelector: {}
       objectSelector: {}
       rules:
       - apiGroups:
           - core.oam.dev
           apiVersions:
           - v1beta1
           operations:
           - CREATE
           - UPDATE
           resources:
           - applications
           scope: "*"
       sideEffects: NoneOnDryRun
       timeoutSeconds: 10
   ```
4. 保存更改并退出编辑器。
5. 验证 webhook 是否已被移除：
   ```bash
   kubectl get validatingwebhookconfiguration metis-validation -o yaml | grep -A5 "name: oamapp.cpaas.io"
   # 预期：无输出（未找到 webhook）
   ```

### 步骤 3：上架并升级插件

#### 3.1 获取上架工具

导航到 `管理员` -> `Marketplace` -> `上架软件包` 下载名为 `violet` 的上架工具。下载后，授予二进制文件执行权限：
```bash
chmod +x violet
```

#### 3.2 上架插件

1. 下载 OAM 应用插件安装文件：`oam-application.ALL.v4.2.x.tgz`（将 x 替换为具体版本号）。

2. 使用 `violet` 命令发布到平台仓库：
   ```bash
   violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password=<platform-admin-password> oam-application.ALL.v4.2.x.tgz
   ```
   **参数说明**：
   - `--platform-address`：ACP 平台地址。
   - `--platform-username`：ACP 平台管理员用户名。
   - `--platform-password`：ACP 平台管理员密码。

#### 3.3 升级插件

1. 导航到 **Alauda Container Platform Application Management for KubeVela** 插件的详情页面，路径为 `管理员` → `Marketplace` → `集群插件`。您应该看到可用的新插件版本。
2. 点击 **升级** 在插件详情页面进行升级。
3. 确认升级操作。
4. 升级过程可能需要几分钟。请耐心等待升级完成。

### 步骤 4：升级后验证

升级完成后，请验证以下内容：

1. 插件显示为 **已安装** 状态，并带有新版本号。
2. 检查与 OAM 应用插件相关的所有 pod 是否在运行：
   ```bash
   kubectl get pods -n cpaas-system | grep oam
   # 所有相关 pod 应该具有 **Running** 状态。
   ```
3. 测试 OAM 应用操作：
   - 创建一个简单的 OAM 应用以验证变更和验证 webhook 是否正常工作。
   - 更新现有的 OAM 应用。

### 结论

通过仔细遵循本指南，您已成功升级 **OAM 应用集群插件**，以确保与 ACP 4.2+ 的最佳性能和兼容性。新插件版本现在管理 OAM 应用的变更和验证 webhook，提供更好的集成和维护能力。

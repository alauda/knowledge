---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500841
sourceSHA: c26ac5aa42e62a3041082d050170a02476e1b9f8e1204a5c64ed67cd9e47f8f9
---

# 通过 KedaController CR 调整 ACP 上 KEDA operator pod 的大小

## 问题

KEDA operator pod (`keda-operator` 部署，由 KEDA `OperatorBundle` 进行协调) 的 CPU 和内存请求/限制需要提高——例如，以处理更多的 `ScaledObject`/`ScaledJob` CR，或在负载下避免 OOMKills。直接编辑 `keda-operator` 部署并不稳定，因为 operator 自身的控制器会不断将部署规格协调回 `KedaController` CR 所声明的内容。

## 解决方案

编辑 `KedaController` CR 实例，并在 `spec.operator` 下添加 `resources` 块。ACP 将 KEDA 作为 `keda` `OperatorBundle`（默认通道 `stable`，当前 CSV `keda.v2.16.0`，仓库 `middleware/keda-bundle`）提供，在 `cpaas-system` `custom` 目录中。`KedaController` CRD (`kedacontrollers.keda.sh/v1alpha1`，由 CSV 拥有) 是 operator 协调到 `keda-operator`、`keda-metrics-apiserver` 和 `keda-admission-webhooks` 部署的对象。

```yaml
apiVersion: keda.sh/v1alpha1
kind: KedaController
metadata:
  name: keda
  namespace: keda
spec:
  operator:
    resources:
      requests:
        cpu: "1"
        memory: 1Gi
      limits:
        cpu: "1"
        memory: 2Gi
```

在更新 `KedaController` 后，operator 会在下次协调时将 `keda-operator` 部署滚动到新的资源值。

其他两个 KEDA 组件 pod 也可以使用相同的结构，每个都接受标准的 Kubernetes `ResourceRequirements` 对象（`limits` / `requests`）：

- `spec.metricsServer.resources` — 调整 `keda-metrics-apiserver` 部署的大小（支持由 `ScaledObject` 驱动的 HPA 的 `external.metrics.k8s.io` 提供者）。
- `spec.admissionWebhooks.resources` — 调整 `keda-admission-webhooks` 部署的大小。

> **版本说明。** 促使此解决方案的文章描述了两个不同的 KEDA 版本：`2.9.X`（字段路径 `spec.operator.resourcesKedaOperator`）和 `2.11.X`（字段路径 `spec.operator.resources`）。ACP 仅提供 KEDA `2.16.0`；在 `2.16.0` 中，字段为 `spec.operator.resources`（与 2.11.X 风格路径匹配）。`resourcesKedaOperator` 字段名称在 `2.16.0` `KedaController` CRD 中不存在——应用带有 `spec.operator.resourcesKedaOperator` 的 CR 将被 apiserver 架构验证静默丢弃。在 ACP 上使用 `spec.operator.resources`。

## 诊断步骤

确认目录中有 `keda` 包，并查看当前的 CSV 版本。

```bash
kubectl get packagemanifest -A | grep -i keda
kubectl get packagemanifest keda -n cpaas-system \
  -o jsonpath='{.status.channels[*].currentCSV} {.status.defaultChannel}{"\n"}'
```

在经过验证的安装中，包为 `cpaas-system keda <catalog>`，`currentCSV` 为 `keda.v2.16.0`，默认通道为 `stable`。

确认 `KedaController` CRD 已注册（它由 KEDA CSV 拥有——一旦订阅该包即存在）。预期输出：`v1alpha1`。

```bash
kubectl get crd kedacontrollers.keda.sh \
  -o jsonpath='{.spec.versions[*].name}{"\n"}'
```

检查实时 CRD 架构以确认字段路径，然后再应用——在 KEDA `2.16.0` 中字段为 `spec.operator.resources`；每个 `explain` 应描述一个标准的 `ResourceRequirements` 对象（`limits`、`requests`、`claims`）。

```bash
kubectl explain kedacontroller.spec.operator.resources
kubectl explain kedacontroller.spec.metricsServer.resources
kubectl explain kedacontroller.spec.admissionWebhooks.resources
```

确认 `KedaController` 实例和编辑 CR 后生成的 `keda-operator` 部署规格。

```bash
kubectl -n keda get kedacontroller keda \
  -o jsonpath='{.spec.operator.resources}{"\n"}'
kubectl -n keda get deploy keda-operator \
  -o jsonpath='{.spec.template.spec.containers[*].resources}{"\n"}'
```

部署中的值应与 `KedaController` CR 下的 `spec.operator.resources` 中设置的值匹配。如果它们不匹配，请查看 operator 安装命名空间中的 KEDA operator pod 日志以获取协调错误。

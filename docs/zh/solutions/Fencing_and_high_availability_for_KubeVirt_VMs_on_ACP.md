---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500411
sourceSHA: 2cd005ad68b66697d2e6adbd602280b57c28ac80415e51742f4e5fe5e44b0547
---

# ACP 上 KubeVirt 虚拟机的围栏和高可用性

## 问题

在安装了 `kubevirt-operator` 包（CSV `kubevirt-hyperconverged-operator.v4.3.5`，HCO operator `v1.7.0-alauda.1`，KubeVirt `v1.7.0-alauda.2`，在 `kubevirt` 命名空间中的 HyperConverged 单例）并运行 Kubernetes 服务器 `v1.34.5` 的 Alauda 容器平台上，位于突然变得不可达的节点上的 `VirtualMachine` 不会在存活的节点上自动恢复，除非提前设置三件事——请求 virt-controller 重新创建 VMI 的重启策略、在节点排空时的驱逐策略，以及允许卡住的卷分离的节点级修复路径，以便新的 VMI 可以在其他地方挂载它们。每个部分都存在于不同的资源中，并在 ACP 上单独交付，因此高可用性故事必须组装，而不是通过单个开关启用。

本文其余部分的环境锚点：从 `installer-v4.3.0-online` 安装的集群，Kubernetes 服务器 `v1.34.5`，`kubevirt-hyperconverged-operator.v4.3.5`，`node-healthcheck-operator.v0.9.13`，以及 `self-node-remediation-operator.v0.10.23`——后两个作为 `PackageManifest` 对象在平台目录中提供，并且可以安装，但默认情况下未订阅。

## 根本原因

KubeVirt 的 `VirtualMachine` 具有两个独立的字段，共同决定恢复行为。第一个是 VM 上的 `.spec.runStrategy`（类型 `string`）——CRD 将较旧的 `.spec.running` 布尔值标记为弃用，并将 `runStrategy` 和 `running` 视为互斥，因此任何面向高可用性的 VM 必须使用 `runStrategy` 来表达其重启意图。第二个是 VMI 模板上的 `.spec.template.spec.evictionStrategy`（类型 `string`）；CRD 描述指出该字段“描述在节点排空时应遵循的策略”，并列出了接受的值为 `None`、`LiveMigrate`、`LiveMigrateIfPossible` 和 `External`。

这两个字段单独都无法处理节点未优雅排空而是简单消失的情况。当节点停止报告且其 VMI pod 卡在 `Terminating` 状态时，底层的 RWO `PersistentVolume` 仍然被记录为附加到该节点，因此 virt-controller 无法在健康节点上启动替换的 VMI。上游 Kubernetes 的解决方案是 `node.kubernetes.io/out-of-service` 污点原语：在不可达的 `Node` 上触发形状为 `{key: node.kubernetes.io/out-of-service, value: nodeshutdown, effect: NoExecute}` 的污点会触发附加-分离控制器强制分离卷。支持该原语的 `NodeOutOfServiceVolumeDetach` 特性开关在 Kubernetes `v1.28` 上为 GA，并在 `v1.34.5` 时锁定，因此集群无需任何特性开关切换即可工作。

## 解决方案

配置 `VirtualMachine` 以实现高可用性，然后安装一个可以代表其应用失效污点的节点级修复器。这三部分——`runStrategy`、`evictionStrategy` 和选择 VMI 主机节点的 `NodeHealthCheck`——共同满足围栏准备标准。

在每个必须自动恢复的 VM 上设置 `.spec.runStrategy: Always`。这指示 virt-controller 保持一个 VMI 运行，并在先前的 VMI 对象被移除后重新创建它；不要同时设置 `.spec.running`，因为 CRD 将这两个字段标记为互斥。

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: ha-vm
  namespace: my-vms
spec:
  runStrategy: Always
  template:
    spec:
      evictionStrategy: LiveMigrate
      domain:
        devices: {}
```

选择 `.spec.template.spec.evictionStrategy` 以匹配工作负载。CRD 列举的值为 `None`、`LiveMigrate`、`LiveMigrateIfPossible` 和 `External`，该策略在节点排空时触发。`LiveMigrate` 要求排空等待迁移，仅适用于存储和网络允许迁移的 VM；`LiveMigrateIfPossible` 在迁移不可行时回退到正常关机；`External` 将驱逐推迟到外部控制器；`None` 允许标准 pod 驱逐继续。

只有当以下三项同时成立时，围栏 VM 才是恢复就绪的：`VirtualMachine` 声明 `runStrategy: Always`，VMI 使用 RWX 存储或在支持 `VolumeAttachment` 强制分离的 CSI 驱动程序上的 RWO 存储，并且 `NodeHealthCheck` 资源选择托管 VMI 的节点。如果没有第三个条件，不可达的节点永远不会接收到失效污点，RWO 卷也永远不会释放——无论 `runStrategy` 如何声明，VM 都无法在存活的节点上重新启动。

从平台目录安装节点修复堆栈。`node-healthcheck-operator` 包作为 `PackageManifest` 存在于 ACP 中（目录 `platform`，安装模式 `AllNamespaces`，建议命名空间 `workload-availability`，当前 CSV `node-healthcheck-operator.v0.9.13`），而匹配的 CRD 组 `remediation.medik8s.io` 在新集群中缺失——该操作程序可以安装，但默认情况下未订阅，必须在创建任何 `NodeHealthCheck` 资源之前进行订阅。一个伴随的 `self-node-remediation-operator` 包通过相同的目录提供（请参见上面的环境锚点以获取其 CSV），并提供一个 `SelfNodeRemediationTemplate`，`NodeHealthCheck` 通过 `remediationTemplate` 引用该模板；上游修复流程随后将不可达的节点引导到 `node.kubernetes.io/out-of-service=nodeshutdown:NoExecute` 污点，其原语形状与 kubelet/attach-detach 控制器在此 Kubernetes 版本中已经遵循的节点污点三元组相同。

创建一个 `NodeHealthCheck` 资源，以监视正确的节点。`NodeHealthCheck.spec` 形状包含四个键——`selector`（一个标签选择器，选择检查监视的节点）、`unhealthyConditions`（一个 `{type, status, duration}` 条目的列表）、`minHealthy`（一个整数或百分比字符串，例如 `"51%"`，描述在允许修复之前必须保持健康的节点数量），以及 `remediationTemplate`（一个指向 `*RemediationTemplate` CR 的对象引用）。

```yaml
apiVersion: remediation.medik8s.io/v1alpha1
kind: NodeHealthCheck
metadata:
  name: vm-hosts
spec:
  selector:
    matchLabels:
      node-role.kubernetes.io/worker: ""
  unhealthyConditions:
    - type: Ready
      status: "False"
      duration: 300s
    - type: Ready
      status: Unknown
      duration: 300s
  minHealthy: "51%"
  remediationTemplate:
    apiVersion: self-node-remediation.medik8s.io/v1alpha1
    kind: SelfNodeRemediationTemplate
    namespace: workload-availability
    name: self-node-remediation-resource-deletion-template
```

`selector` 接受标准 Kubernetes `LabelSelector` 的任一形式——`matchLabels`（如上所示）或 `matchExpressions`（例如 `[{key: node-role.kubernetes.io/worker, operator: Exists}]`，这是包的 `alm-examples` 示例使用的形式）。这两种形式选择相同的一组节点；选择与命名空间中其余 CR 集合匹配的任一形式。

## 诊断步骤

当 VM 在节点故障后卡住时，逐字段检查链。读取 VM 以确认 `runStrategy` 和 VMI 模板的 `evictionStrategy` 设置为预期值；这两个字段位于 `virtualmachines.kubevirt.io/v1` 上，并从同一对象读取。

```bash
kubectl get vm -n my-vms ha-vm \
  -o jsonpath='{.spec.runStrategy}{"\n"}{.spec.template.spec.evictionStrategy}{"\n"}'
```

检查不可达的 `Node` 是否获得了失效污点。污点形状是上游三元组 `node.kubernetes.io/out-of-service=nodeshutdown:NoExecute`；在 Kubernetes `v1.34.5` 上，`NodeOutOfServiceVolumeDetach` 开关被锁定为 GA，因此 kube-controller-manager 会在污点出现后立即采取行动。

```bash
kubectl get node <unreachable-node> \
  -o jsonpath='{range .spec.taints[*]}{.key}={.value}:{.effect}{"\n"}{end}'
```

如果污点缺失，则节点修复器未运行。确认修复堆栈实际上已订阅——在标准 ACP 集群中，`node-healthcheck-operator` 和 `self-node-remediation-operator` 包作为 `PackageManifest` 对象存在于目录中，但它们的 CRD（`nodehealthchecks.remediation.medik8s.io`，`selfnoderemediationtemplates.self-node-remediation.medik8s.io`）仅在订阅包后出现。

```bash
kubectl get packagemanifest node-healthcheck-operator \
  -o jsonpath='{.status.channels[?(@.name=="stable")].currentCSV}{"\n"}'
kubectl get crd nodehealthchecks.remediation.medik8s.io 2>/dev/null \
  || echo "node-healthcheck-operator not subscribed"
```

一旦 `NodeHealthCheck` 到位，并且其 `unhealthyConditions` 在配置的持续时间内匹配，上游修复流程将不可达的节点引导到 `node.kubernetes.io/out-of-service=nodeshutdown:NoExecute` 污点——该污点原语的形状以及 `NodeOutOfServiceVolumeDetach` 特性开关在 Kubernetes `v1.34.5` 上被锁定为 GA 是该集群直接锚定的内容。污点下游发生的事情——强制分离 RWO `VolumeAttachment` 和在存活节点上调度新的 VMI pod——是文档化的上游序列，并依赖于支持 VM 存储的 CSI 驱动程序。在一个标准的 ACP 集群中，其唯一的 `StorageClass` 解析为主机本地 CSI，例如 `topolvm.cybozu.com`（在此情况下 `volumeattachments.storage.k8s.io` 不被使用，因为 `ATTACHREQUIRED=false`），强制分离路径无效，围栏卷无法迁移——在依赖此最终步骤之前，请验证集群具有 RWX 或支持强制分离的 CSI。

---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500201
sourceSHA: 91541b12920e5121f45db988a7b95d96c9e7d418ec1df8df67041e2222b334bf
---

# virt-launcher 在 ACP 上的 KubeVirt 虚拟机中与多个次级网络的 VMI 同步循环

## 问题

在安装了 `kubevirt-operator` 包的 Alauda 容器平台上（CSV `kubevirt-hyperconverged-operator.v4.3.5`，通道 `alpha`，在 `kubevirt` 命名空间中的 HCO 单例，KubeVirt 版本为 `v1.7.0-alauda.2`），配置了两个或更多通过 Multus 附加的次级网络的 KubeVirt 虚拟机可能会使其 virt-launcher pod 进入高频率的同步循环。virt-launcher 容器（`registry.alauda.cn:60080/3rdparty/kubevirt/virt-launcher:v1.7.0-alauda.2`）每秒发出许多 `Synced vmi` 信息行，来自 `pos=server.go:208`，每行都是一个形状为 `{component:"virt-launcher", level:"info", msg:"Synced vmi", pos:"server.go:208", timestamp:...}` 的单行 JSON 记录，携带 VMI 的名称、命名空间和 UID。

在同一触发下，虚拟机的 IP 地址在 VirtualMachineInstance 状态中明显波动。VMI CRD（`kubevirt.io` 组，种类 `VirtualMachineInstance` 在版本 `v1` 和 `v1alpha3`）定义了 `.status.interfaces[]` 条目，携带 `ipAddress`、`ipAddresses[]`、`mac`、`name`、`interfaceName`、`podInterfaceName`、`linkState` 和 `infoSource`；当循环处于活动状态时，这些条目——包括报告的 IP——在每次同步迭代中被重写，并在使用 `kubectl get vmi -o yaml` 观察时似乎来来去去。

## 根本原因

VMI 上的 `.status.interfaces[]` 是由多个生产者提供的合并视图：每个条目的 `infoSource` 字段是一个枚举，值为 `domain`、`guest-agent` 和 `multus-status`，标识哪个子系统贡献了数据。当虚拟机携带多个 Multus 附加的次级网络时，生产者对合并的接口集应该是什么样子存在分歧，因此每次同步传递都会写入一个新的期望状态。节点智能体（`virt-handler`，镜像 `build-harbor.alauda.cn/3rdparty/kubevirt/virt-handler:v1.7.0-alauda.2`）对每次这样的更新向 virt-launcher cmd-server 发出一个新的每 VMI 同步 RPC，而控制平面控制器（`virt-controller`，镜像 `build-harbor.alauda.cn/3rdparty/kubevirt/virt-controller:v1.7.0-alauda.2`）则持续驱动 VMI 同步——共同产生每秒的 `Synced vmi` 日志行和 `.status.interfaces[]` 中可见的 IP 波动。

## 解决方案

在虚拟机模板中重新排序接口列表，使 pod 网络接口成为第一个条目。ACP 上的 VM CRD 是 `kubevirt.io/VirtualMachine`（版本 `v1` 和 `v1alpha3`），每个虚拟机的模板接口列表位于 `spec.template.spec.domain.devices.interfaces[]`；匹配的 `spec.template.spec.networks[]` 块支持标准的 `pod` 网络类型和 `multus` 网络类型，其中 `multus.networkName` 引用一个 `NetworkAttachmentDefinition`（`k8s.cni.cncf.io/v1`）名称。编辑虚拟机 YAML，将 `name` 与 `networks[]` 中的 `pod` 网络条目匹配的接口条目移动到 `interfaces[]` 的第一个位置，可以缓解循环。

对虚拟机对象应用更改（示例假设虚拟机有一个名为 `default` 的 pod 网络接口和两个附加的 Multus 次级接口；根据需要替换虚拟机名称和命名空间）：

```bash
kubectl edit vm -n <vm-namespace> <vm-name>
```

重新排序后的模板如下——`networks[]` 中的 `pod` 网络条目由 `interfaces[]` 中的第一个条目通过 `name` 匹配，后面是附加的 Multus 次级条目：

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
spec:
  template:
    spec:
      domain:
        devices:
          interfaces:
            - name: default
              masquerade: {}
            - name: secondary-1
              bridge: {}
            - name: secondary-2
              bridge: {}
      networks:
        - name: default
          pod: {}
        - name: secondary-1
          multus:
            networkName: <nad-namespace>/<nad-name-1>
        - name: secondary-2
          multus:
            networkName: <nad-namespace>/<nad-name-2>
```

保存后，KubeVirt 将根据更新的模板重新生成 VMI；新 virt-launcher pod 中的 `Synced vmi` 日志速率和新 VMI 上 `.status.interfaces[]` 的稳定性应确认此解决方法是否适用于该虚拟机的特定接口拓扑。

## 诊断步骤

通过在虚拟机的命名空间中流式传输 pod 的日志并 grep `Synced vmi` 消息来确认 virt-launcher 侧的症状；健康的虚拟机在启动时和合法的同步期间会发出此行，而陷入循环的虚拟机则会每秒多次发出此行，来自 `pos=server.go:208`，`level:"info"` 和上述描述的 JSON 包：

```bash
kubectl logs -n <vm-namespace> -l kubevirt.io=virt-launcher,vm.kubevirt.io/name=<vm-name> \
  --tail=200 -f
```

通过读取 VMI 的状态块并观察 `.status.interfaces[]` 来确认匹配的 VMI 侧症状；在循环状态下，受影响条目的 `ipAddress` / `ipAddresses` / `mac` / `interfaceName` / `podInterfaceName` / `linkState` / `infoSource` 字段在每次同步迭代中被重写，IP 在值之间波动而不是稳定：

```bash
kubectl get vmi -n <vm-namespace> <vm-name> \
  -o jsonpath='{.status.interfaces}' | jq .
```

通过读取虚拟机对象上的接口和网络列表来交叉检查虚拟机模板与解决方法；`spec.template.spec.domain.devices.interfaces[]` 的第一个条目应与 `spec.template.spec.networks[]` 中的 `pod` 网络条目具有相同的 `name`，任何 `multus` 网络（每个通过 `networkName` 引用一个 `NetworkAttachmentDefinition`）应排在其后：

```bash
kubectl get vm -n <vm-namespace> <vm-name> \
  -o jsonpath='{.spec.template.spec.domain.devices.interfaces}{"\n"}{.spec.template.spec.networks}{"\n"}'
```

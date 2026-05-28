---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500336
sourceSHA: 09d874db2e0b0be9c12a1ed9ceea8eab487710799cba3ccdbaeaea94991ddbf0
---

# 在 ACP KubeVirt 上将两个 VM NIC 附加到一个辅助网络

## 问题

在 Alauda 容器平台上，KubeVirt 虚拟机有时需要两个不同的网络接口，这两个接口由同一个辅助网络支持——例如，在一个底层网络上的冗余数据平面对。Multus 通过引用的网络名称为每个附件键入，因此单个 VM 不能在其两个接口上引用相同的 NetworkAttachmentDefinition；这两个接口条目会合并为一个附件，而不是产生两个独立的 NIC。在 ACP 上，这种绑定行为源自上游的 Multus（multus-cni v4.2.4）和上游的 KubeVirt VM CRD（`virtualmachines.kubevirt.io`，命名空间 `kubevirt`），其中每个接口的独立附件要求是一个通用的 Multus 属性，而不是特定于 CNI 的属性。

## 根本原因

由于 Multus 根据网络名称去重附件，因此指向相同 NetworkAttachmentDefinition 的两个 VM `spec.template.spec.networks[]` 条目解析为一个逻辑附件，而 KubeVirt 仅连接一个相应的接口。因此，在同一个底层网络上为 VM 提供一个真正的第二个 NIC 需要一个第二个 NetworkAttachmentDefinition，而不是重用第一个；这遵循了通用的上游 Multus 行为，适用于 multus-cni v4.2.4，并且不特定于任何特定的 CNI。

## 解决方案

为额外的接口定义一个第二个 NetworkAttachmentDefinition。这两个 NetworkAttachmentDefinitions 是标准的上游 Multus CRD（`k8s.cni.cncf.io/v1`），每个都必须具有在命名空间内唯一的 `metadata.name`，因为 Multus 根据该名称解析和去重附件。在 ACP 上，辅助网络 CNI 是 kube-ovn（镜像 `kube-ovn:v1.15.10`）；一个 kube-ovn 辅助 NetworkAttachmentDefinition 声明 CNI `type: kube-ovn`，并使用提供者约定 `<nad-name>.<namespace>.ovn`，这将附件绑定到必须已经存在的 kube-ovn 子网（子网及其提供者网络和 VLAN 链是 NAD 的提供者引用解析的前提条件）。创建两个具有不同名称的 NetworkAttachmentDefinitions，以便每个都可以作为其自己的接口附加。

以下对展示了命名空间 `kubevirt` 中的两个不同 NetworkAttachmentDefinitions，每个都采用 kube-ovn 形状，并且每个都有唯一的 `metadata.name`：

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: secondary-net-a
  namespace: kubevirt
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "type": "kube-ovn",
      "provider": "secondary-net-a.kubevirt.ovn"
    }
---
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: secondary-net-b
  namespace: kubevirt
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "type": "kube-ovn",
      "provider": "secondary-net-b.kubevirt.ovn"
    }
```

从每个 VM 网络条目引用各自的 NetworkAttachmentDefinition，并将每个网络绑定到一个单独的接口。每个唯一的 NetworkAttachmentDefinition 作为独立接口附加到 VM，每个 `spec.template.spec.networks[].multus` 条目引用不同的 `networkName`，每个 `domain.devices.interfaces[]` 条目命名匹配的网络；这种绑定是 ACP 中 `kubevirt` 命名空间的上游 KubeVirt VM CRD 形式：

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: dual-nic-vm
  namespace: kubevirt
spec:
  template:
    spec:
      domain:
        devices:
          interfaces:
            - name: nic-a
              bridge: {}
            - name: nic-b
              bridge: {}
      networks:
        - name: nic-a
          multus:
            networkName: secondary-net-a
        - name: nic-b
          multus:
            networkName: secondary-net-b
```

由于两个 `networkName` 值解析为两个不同的 NetworkAttachmentDefinitions，Multus 生成两个独立的附件，KubeVirt 在同一个底层网络上提供两个 NIC；在两个条目中重用一个 NetworkAttachmentDefinition 反而会导致生成一个附件（multus-cni v4.2.4-b223aa77，kube-ovn v1.15.10，命名空间 `kubevirt`）。

## 诊断步骤

确认 VM 的命名空间中存在两个不同的 NetworkAttachmentDefinitions，并且它们的名称是唯一的，因为重复或共享名称会导致附件合并为一个：

```bash
kubectl get network-attachment-definitions.k8s.cni.cncf.io -n kubevirt
```

检查 VM 的网络到接口的绑定，并验证每个 `multus.networkName` 引用不同的 NetworkAttachmentDefinition，与接口条目一一对应：

```bash
kubectl get virtualmachine -n kubevirt dual-nic-vm \
  -o jsonpath='{.spec.template.spec.networks}'
```

如果尽管有两个接口条目，但运行中的 VM 上只出现一个 NIC，请检查这两个网络条目是否指向相同的 NetworkAttachmentDefinition 名称；在 multus-cni v4.2.4 中，两个共享一个名称的条目会去重为一个附件。

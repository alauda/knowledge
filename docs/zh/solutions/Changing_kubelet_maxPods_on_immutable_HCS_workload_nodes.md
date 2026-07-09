---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.x,4.2.x,4.3.x'
id: KB260700026
sourceSHA: 84863d12f1c312aec49e9a51c415c98a6833b254423363d3811637dca9ab2b18
---

# 更改不可变基础设施节点上的 kubelet maxPods 设置

## 问题

您需要更改不可变基础设施工作节点上的 kubelet `maxPods` 设置——例如，调整在华为云栈 (HCS) 上配置的集群的 Pod 密度。在不可变节点上，您不能简单地编辑主机上的文件并期望更改能够持久化：节点文件由平台的机器配置组件进行协调，超出带外的编辑被视为配置漂移。更改还必须到达两个不同的节点群体：

- **已经存在的节点**，必须在**不重启**的情况下采用新值。
- **后续添加的节点**，通过扩展或在升级的滚动更新期间替换，必须在启动时已经携带新值。

本文涵盖了两者：现有节点的机器配置，以及未来节点的集群提供者模板。

## 环境

此操作步骤由 Alauda 容器平台机器配置组件提供，其适用性与该组件的版本相关——**而不是**与 ACP 平台版本相关：

- **机器配置版本。** 此操作步骤适用于当前的机器配置版本——即计划中的 **v4.1.x** 版本之前的版本。v4.1.x 是**计划中但尚未发布**；它旨在引入一个专用的 kubelet 配置自定义资源。一旦该版本可用并投入使用，请通过该资源配置 kubelet，而迁移此处创建的对象。
- **ACP 平台版本。** 该方法本身不依赖于 ACP 版本。它是否可以在特定集群上使用仅取决于已安装的机器配置版本支持哪些 ACP 版本。当前的机器配置支持 ACP v4.1、v4.2 和 v4.3。

## 根本原因

`maxPods` 是上游 `KubeletConfiguration` (`kubelet.config.k8s.io/v1beta1`) 的一个字段。在不可变节点上，kubelet 配置由机器配置拥有，通过机器配置守护进程呈现和协调节点文件；如果管理文件被超出带外编辑，守护进程将节点标记为 `Degraded`。需要两个独立的交付路径，因为这两个节点群体的创建方式不同：

- 现有节点**不会**重新配置，因此其运行配置必须就地更改。
- 未来节点是从提供者的 **引导配置** 创建的，因此它们在首次启动时继承该配置所指定的内容。

kubelet 从分层源读取其配置，具有固定的优先级：**命令行标志 > `--config-dir` 插件 > `--config` 文件 > 内置默认值**。以下两个交付路径都将 `maxPods` 设置为命令行标志；在两者都适用的情况下，哪个优先取决于 *保持两个路径一致性*。

在此操作步骤针对的机器配置版本中（见 *环境* 部分），没有专用的 kubelet 配置自定义资源。因此，支持的临时方法是一个 `MachineConfig`，它为 kubelet 安装一个 systemd 插件，下面将对此进行描述。

> 这是一个高级的节点级操作步骤。kubelet 服务覆盖中的错误可能会使节点处于 `NotReady` 状态。请先在非生产池上应用，如果不确定，请联系 Alauda 支持。

## 解决方案

### 第 1 部分 — 使用机器配置更改现有节点（无重启）

`maxPods` 是通过 systemd 插件设置的，该插件通过 `KUBELET_EXTRA_ARGS` 将 `--max-pods` 传递给 kubelet。它在 kubelet 重启后生效——节点不会重启，正在运行的 Pods 不会被驱逐。这适用于**所有工作节点，包括基础设施 (`infra`) 节点**，它们采用相同的值。通过两个对象按顺序交付。

**前提条件 — 确认节点的 kubelet 服务。** 下面的插件重新声明了 kubelet 的 `ExecStart`。首先从目标节点读取实际的 `ExecStart`，并逐字重用；唯一的要求是它以 `$KUBELET_EXTRA_ARGS` 结尾，以便下面设置的值能够应用：

```bash
systemctl cat kubelet
```

**步骤 1 — 节点干扰策略。** 默认情况下，文件更改不会重启任何服务，因此插件将被写入磁盘但不会应用。添加一个策略，当插件文件更改时重新加载 systemd 并重启 kubelet。使用 **`kubectl edit machineconfiguration cluster`** 编辑现有的单例——**不要**使用 `kubectl apply`，因为这将覆盖对象上已有的其他策略——并在步骤 2 创建 `MachineConfig` 之前确认条目出现在 `status.nodeDisruptionPolicyStatus` 中：

```yaml
apiVersion: machineconfiguration.alauda.io/v1alpha1
kind: MachineConfiguration
metadata:
  name: cluster            # cpaas-system 命名空间中的单例
spec:
  nodeDisruptionPolicy:
    files:
      - path: /etc/systemd/system/kubelet.service.d/30-maxpods.conf
        actions:
          - type: DaemonReload
          - type: Restart
            restart:
              serviceName: kubelet.service
    sshkey:
      actions:
        - type: None
```

**步骤 2 — 设置 maxPods。** 准备 systemd 插件。`ExecStart=` 被清除并重新声明，以便最后应用 `$KUBELET_EXTRA_ARGS`；**将 `250` 替换为您的目标值，并将 `ExecStart` 行与您节点上 `systemctl cat kubelet` 的输出匹配**：

```ini
[Service]
Environment="KUBELET_EXTRA_ARGS=--max-pods=250"
ExecStart=
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
```

进行 Base64 编码：

```bash
base64 -w0 30-maxpods.conf
```

创建 `MachineConfig`（下面的 `contents.source` 是上述插件的编码）。`role: worker` 标签将其应用于每个工作节点，包括 `infra`：

```yaml
apiVersion: machineconfiguration.alauda.io/v1alpha1
kind: MachineConfig
metadata:
  name: 30-worker-kubelet-maxpods
  labels:
    machineconfiguration.alauda.io/role: worker
    machineconfiguration.alauda.io/kubelet-config: "setting"
  annotations:
    machineconfiguration.alauda.io/kubelet-fields: "maxPods"
spec:
  config:
    ignition:
      version: 3.4.0
    storage:
      files:
        - path: /etc/systemd/system/kubelet.service.d/30-maxpods.conf
          mode: 0o644
          overwrite: true
          contents:
            source: 'data:text/plain;base64,W1NlcnZpY2VdCkVudmlyb25tZW50PSJLVUJFTEVUX0VYVFJBX0FSR1M9LS1tYXgtcG9kcz0yNTAiCkV4ZWNTdGFydD0KRXhlY1N0YXJ0PS91c3IvYmluL2t1YmVsZXQgJEtVQkVMRVRfS1VCRUNPTkZJR19BUkdTICRLVUJFTEVUX0NPTkZJR19BUkdTICRLVUJFTEVUX0tVQkVBRE1fQVJHUyAkS1VCRUxFVF9FWFRSQV9BUkdTCg=='
```

> **不要启用 `--config-dir` 指向不存在的目录。** 此操作步骤的早期版本将 kubelet 指向 `--config-dir=/etc/kubernetes/kubelet.conf.d` 并在该目录存在之前重启它，这使得节点处于 `NotReady` 状态。上述插件完全避免了 `--config-dir`。如果您必须使用它来设置没有命令行标志的配置（见 *限制*），请在任何引用它之前，在同一 `MachineConfig` 中创建该目录——通过在其中写入文件。

在应用 `MachineConfig` 后，守护进程会在每个工作节点上重新加载 systemd 并重启 kubelet；新的 `maxPods` 生效，节点不会重启。

在此对象中仅保留 kubelet 设置（不包括 chrony、sysctl 或无关文件）；将插件命名为 `NN-<name>.conf`，其中 `NN` 在 10–49 范围内；并保留上述显示的标签。要设置其他可通过标志设置的字段，请将它们添加到**同一** `KUBELET_EXTRA_ARGS` 行中，以空格分隔——**不要**创建第二个插件来分配 `KUBELET_EXTRA_ARGS`（systemd 仅保留变量的最后一次赋值）——并在 `kubelet-fields` 注释中列出每个字段。

### 第 2 部分 — 使未来节点携带该值（提供者模板）

新的工作（计算）节点是从工作池的 `KubeadmConfigTemplate` 创建的（连同其 `MachineDeployment` 和 `HCSMachineTemplate`）。在此处设置 `maxPods`，以便节点在创建时就具备该值。控制平面节点通过不同的资源配置——`KubeadmControlPlane`——不在此工作负载节点操作步骤的范围内。

对于工作节点，通过 `KubeadmConfigTemplate` 中的 `joinConfiguration.nodeRegistration.kubeletExtraArgs` 设置该值。在任何现有的 `kubeletExtraArgs` 条目（如 `volume-plugin-dir`）旁边添加 `max-pods`；不要删除它们。将相同的值应用于**每个**工作池的模板，包括 `infra` 池，以便所有工作节点匹配：

```yaml
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: <cluster>-<worker-pool>
spec:
  template:
    spec:
      joinConfiguration:
        nodeRegistration:
          kubeletExtraArgs:
            max-pods: "250"
```

`kubeletExtraArgs` 成为 kubelet 命令行标志（`--max-pods`）。应用此模板不会更改现有节点；它仅影响在更改后创建的工作节点。在机器配置也管理的节点上，第 1 部分的值会覆盖此值（见 *保持两个路径一致性*），因此将两者设置为**相同**的值。

### 保持两个路径一致性

一个常见的担忧是，是否将机器配置插件重新应用于新节点——一个提供者引导已经配置的节点——会导致问题。不会，但要明确哪个值优先：

- **没有共享文件。** 机器配置在 `/etc/systemd/system/kubelet.service.d/30-maxpods.conf` 写入其 systemd 插件。提供者的 `kubeletExtraArgs` 由 kubeadm 渲染到 `/var/lib/kubelet/kubeadm-flags.env`（`KUBELET_KUBEADM_ARGS`）。守护进程仅管理其自己的插件，从不触及 kubeadm 文件，因此没有共享所有权冲突，没有漂移，也没有重启循环。
- **两者都是命令行标志，机器配置优先。** kubelet 单元的 `ExecStart` 以 `... $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS` 结尾。提供者值在 `$KUBELET_KUBEADM_ARGS` 中到达；机器配置值在 `$KUBELET_EXTRA_ARGS` 中到达，后者是**最后**的。当同一标志（`--max-pods`）出现两次时，kubelet 使用最后一次出现的值。因此，在任何由机器配置管理的节点上，机器配置值生效并覆盖提供者值。
- **后果。** 将两个路径设置为**相同**的值。如果它们不同，`KubeadmConfigTemplate` 中的 `max-pods` 将对受管理节点没有影响。仅通过这两条声明路径设置该值；不要通过 SSH 编辑节点。

### 限制

- **Pod 网络大小。** `maxPods` 不能超过每个节点可用的 Pod IP 地址数量。使用每节点默认的 Pod CIDR（一个 `/24`，大约 254 个可用地址），无论 `maxPods` 设置为多少，节点都无法有效运行超过该数量的 Pods。在将 `maxPods` 提高到或超过该数字之前，请检查集群的每节点 Pod CIDR 大小；扩大它是一个需要单独规划的集群范围的网络更改。
- **仅具有命令行标志的设置可以使用此方法。** `--max-pods` 有一个标志，因此可以通过 `KUBELET_EXTRA_ARGS` 使用。仅在 `KubeletConfiguration` 中存在的设置——例如 `systemReserved`、`evictionHard` 或 `cpuManagerPolicy`——没有标志，必须通过 kubelet `--config-dir` 机制（一个配置插件目录）交付。如果您使用 `--config-dir`，则该目录必须**首先创建**（通过一个 `MachineConfig` 在其中写入文件），然后任何单元指向 kubelet——否则 kubelet 无法启动，节点将处于 `NotReady` 状态。
- **临时方法，受机器配置版本限制。** 此插件方法是当前机器配置版本（即计划中的 **v4.1.x** 之前的版本）支持的路径，这些版本没有专用的 kubelet 配置资源。v4.1.x 版本是**计划中但尚未可用**；它旨在添加该资源。一旦集群运行提供该资源的机器配置版本，请将第 1 部分的对象迁移到该资源，并停止使用此方法。上述标签使得迁移变得机械化。此边界由机器配置版本设置，而不是 ACP 版本。

## 诊断步骤

从节点读取实时有效的 kubelet 配置并确认 `maxPods`。这将返回实际使用的合并值：

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | jq '.kubeletconfig.maxPods'
```

检查一个现有节点（通过第 1 部分更改）和一个在第 2 部分更改后添加的节点；两者都应报告您设置的值（示例中为 `250`）。如果现有节点仍显示旧值，请确认第 1 步中的节点干扰策略在 `cluster` 资源的 `status.nodeDisruptionPolicyStatus` 中存在，并且第 2 步插件中的 kubelet `ExecStart` 与节点的实际服务匹配。

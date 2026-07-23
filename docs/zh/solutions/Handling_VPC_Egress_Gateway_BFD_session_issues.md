---
products:
  - Alauda Container Platform
kind:
  - Troubleshooting
ProductsVersion:
  - 4.3.0,4.3.1,4.3.2
id: TBD
sourceSHA: c48fd57ace1a3d90fe76bc3d76b1fdd85309e959e82d509b119541ca01507338
---

# VPC 出口网关 BFD 会话异常的处理方法

本文提供两类 VPC 出口网关（VEG）BFD 会话异常的处理方法。请根据现场现象选择对应场景。

## 场景 1：BFD 会话频繁在 Up 和 Down 之间切换

**适用版本：** ACP v4.3.0 和 v4.3.1

### 问题现象

VEG 启用 BFD 后，`bfdd-control status` 能够查询到一个或多个会话，但会话频繁在 `Up` 和 `Down` 之间切换。当 OVN 将对应的 VEG 下一跳标记为不可用时，业务出网可能中断。

### 原因

BFD 报文必须在协商出的检测时间内完成处理。以下情况可能导致已建立的会话反复超时：

- ACP v4.3.0 和 v4.3.1 中，VEG `bfdd` 容器的默认 CPU request 和 limit 均为 `50m`。CPU 限流或节点调度延迟可能导致 `bfdd` 无法及时处理 BFD 报文。
- VEG 使用 `minRX: 100` 和 `minTX: 100` 时，会话对短暂的调度延迟和网络丢包更加敏感。

以上情况可能独立出现，也可能同时存在。

### 解决方案

升级到 ACP v4.3.2 或更高版本。该版本已将 VEG `bfdd` 容器的默认 CPU request 和 limit 调整为 `200m`。

如果暂时无法升级 ACP，请对受影响的 VEG 应用以下调整。

:::warning
修改 `spec.resources` 或 `spec.bfd` 会滚动更新 VEG Deployment 并重建 Pod。对于单副本 VEG，请安排维护窗口，因为滚动更新期间业务出网可能中断。
:::

编辑受影响的 VEG：

```bash
kubectl -n <namespace> edit veg <veg-name>
```

将 CPU request 和 limit 调整为 `200m`：

```yaml
spec:
  resources:
    requests:
      cpu: 200m
    limits:
      cpu: 200m
```

增加 CPU 后，如果会话仍不稳定，并且 VEG 显式使用 100 ms 探测间隔，请将 `minRX` 和 `minTX` 调整为 `1000`：

```yaml
spec:
  bfd:
    minRX: 1000
    minTX: 1000
```

增加探测间隔可以降低会话对短暂调度延迟和网络丢包的敏感度，但也会增加故障检测时间。当探测间隔为 1000 ms、`multiplier` 为 `5` 时，BFD 故障检测时间约为 5 秒，不包含 OVN 更新转发路径所需的时间。

## 场景 2：BFD 会话为零，但健康检查仍然通过

**适用版本：** ACP v4.3.0、v4.3.1 和 v4.3.2

### 问题现象

VEG 启用 BFD 后，`bfdd-control status` 显示 `There are 0 sessions:`，但 VEG Pod 仍处于 `Running` 和 `Ready` 状态。对应的 VEG 下一跳可能变为不可用，并造成业务出网中断。

### 原因

现有 `bfdd` 健康检查直接执行 `bfdd-control status`。该命令只要能够成功连接本地守护进程，就会返回退出码 `0`，即使本地不存在 BFD 会话：

| BFD 状态 | 示例输出 | 退出码 |
| --- | --- | --- |
| 存在 BFD 会话 | `There are 1 sessions:` | `0` |
| 不存在 BFD 会话 | `There are 0 sessions:` | `0` |

Kubernetes exec 探针只判断命令退出码，不解析命令输出。因此，现有 livenessProbe 无法将会话表为空识别为检查失败，kubelet 也不会重启 `bfdd` 容器。

### 解决方案

升级到 ACP v4.3.3 或更高版本。该版本会将 BFD 会话表为空识别为健康检查失败。

如果集群暂时必须继续使用 ACP v4.3.0、v4.3.1 或 v4.3.2，请使用以下临时方案。

:::warning
更新 Deployment 会重建 VEG Pod。对于单副本 VEG，请安排维护窗口，因为滚动更新期间业务出网可能中断。

VEG Deployment 由 Kube-OVN 控制器生成。修改 VEG spec 或副本数、升级 Kube-OVN，或者重建 VEG 或 Deployment 时，手工修改的探针可能被覆盖。
:::

设置 VEG 所在的命名空间和名称，并获取控制器生成的 Deployment 名称：

```bash
NAMESPACE="<veg-namespace>"
VEG_NAME="<veg-name>"

DEPLOYMENT="$(kubectl -n "${NAMESPACE}" get deployment \
  -l "ovn.kubernetes.io/vpc-egress-gateway=${VEG_NAME}" \
  -o jsonpath='{.items[0].metadata.name}')"
```

编辑控制器生成的 Deployment：

```bash
kubectl -n "${NAMESPACE}" edit deployment "${DEPLOYMENT}"
```

找到名为 `bfdd` 的容器，修改其现有 `livenessProbe` 中的 `exec.command`，并将 `timeoutSeconds` 调整为 `10`：

```yaml
livenessProbe:
  exec:
    command:
      - bash
      - -ec
      - 'output="$(bfdd-control status)"; ! grep -q "^There are 0 sessions:" <<< "${output}"'
  timeoutSeconds: 10
```

该修改用于识别空会话，并尝试通过重启 `bfdd` 容器恢复。如果重启后会话仍为空，该功能只能暴露异常，不能修复 BFD 会话，需要继续排查 OVN BFD peer、网络路径和 BFD 配置。

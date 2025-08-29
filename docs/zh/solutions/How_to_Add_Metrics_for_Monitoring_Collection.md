---
products:
  - Alauda Container Platform
kind:
  - Solution
id: KB1756448100-D4A2
sourceSHA: b42145c6659f0a4bb36c727e32994bf8e04a1ae61e92afb0abde6906fb3a5369
---

# 如何添加监控收集的指标

## 问题

如果直接修改 ServiceMonitor 中的白名单以添加 Prometheus 收集的指标，可以为 Prometheus 和 VictoriaMetrics 系统收集更多的指标数据。然而，这存在风险：平台升级可能导致 ServiceMonitor 无法更新，因而由于 ResourcePatch(RPCH) 导致集成的 Prometheus 和 VictoriaMetrics 监控失败。

## 环境信息

适用版本：4.0.x, 4.1.x

## 支持的平台组件

- exporter-coredns
- exporter-kube-controller-manager
- exporter-kube-dns
- exporter-kube-etcd
- exporter-kube-scheduler
- exporter-kube-state
- exporter-kubelets
- exporter-kubernetes
- exporter-node

> **注意**\
> 对于 VictoriaMetrics 监控插件，exporter-kubelets 对应的资源类型是 `VMNodeScrape`，而不是 `ServiceMonitor`。

## 修改步骤

登录到 global 集群的主节点，并修改 Prometheus/Victoriametrics 的 ModuleInfo(minfo) 资源以添加 additionalKeepMetrics。

### 步骤 1：检索对应的 minfo

如果监控组件是 Prometheus

```shell
kubectl get minfo -A | grep prometheus | grep <cluster-name>
```

如果监控组件是 Victoriametrics

```shell
kubectl get minfo -A | grep victoriametrics  | grep <cluster-name>
```

### 步骤 2：编辑 MInfo 资源

```shell
kubectl edit minfo <minfo-name>
```

在 spec 下添加以下内容，将 <component-name> 替换为目标组件，将 <metric> 替换为要添加的指标（确保该指标由组件暴露）：
如果监控组件是 Prometheus

```yaml
spec:
  valuesOverride:
    ait/chart-kube-prometheus:
      <component-name>:
        additionalKeepMetrics:
        - XXX
```

如果监控组件是 Victoriametrics

```yaml
spec:
  valuesOverride:
    ait/chart-victoriametrics:
      <component-name>:
        additionalKeepMetrics:
        - XXX
```

示例：为 exporter-node 添加与 IPVS 相关的指标

如果监控组件是 Prometheus

```yaml
spec:
  valuesOverride:
    ait/chart-kube-prometheus:
      exporter-node:
        additionalKeepMetrics:
        - node_ipvs_connections_total
        - node_ipvs_incoming_packets_total
        - node_ipvs_outgoing_packets_total
        - node_ipvs_incoming_bytes_total
        - node_ipvs_outgoing_bytes_total
        - node_ipvs_backend_connections_active
        - node_ipvs_backend_connections_inactive
        - node_ipvs_backend_weight
```

如果监控组件是 Victoriametrics

```yaml
spec:
  valuesOverride:
    ait/chart-victoriametrics:
      exporter-node:
        additionalKeepMetrics:
        - node_ipvs_connections_total
        - node_ipvs_incoming_packets_total
        - node_ipvs_outgoing_packets_total
        - node_ipvs_incoming_bytes_total
        - node_ipvs_outgoing_bytes_total
        - node_ipvs_backend_connections_active
        - node_ipvs_backend_connections_inactive
        - node_ipvs_backend_weight
```

配置更改后，确保 AppRelease (AR) 已更新，并且监控组件状态为 Ready：

```shell
kubectl -n cpaas-system get ars
```

## 验证步骤

通过 `https://<platform-domain>/clusters/<cluster-name>/prometheus-0` 访问 Prometheus UI 页面，然后在 UI 页面上查询通过上述操作添加的额外指标。如果数据正常返回，则确认修改已生效。

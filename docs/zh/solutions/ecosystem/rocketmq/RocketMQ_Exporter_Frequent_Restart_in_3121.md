---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500102
sourceSHA: ce344c38a7e47ce3306bf11eec0626573a65ae022d68b1a4fed119c7026ad136
---

# RocketMQ Exporter 在 3.12.1 中频繁重启

:::info 适用版本
RocketMQ 3.12.1。
:::

## 问题

在某些 RocketMQ 3.12.1 部署中，exporter 容器反复重启。

## 诊断

首先检查 pod 和容器事件。在报告的案例中，exporter 被杀死是因为内存不足，并显示 `OOMKilled`。

有用的命令：

```bash
kubectl -n <namespace> describe pod <pod-name>
kubectl -n <namespace> get events --sort-by=.lastTimestamp
```

## 解决方案

从数据服务 YAML 视图或底层工作负载资源中增加受影响的 exporter 容器的资源规格。

根据观察到的使用情况和重启行为调整 exporter 的内存限制。

## 注意事项

- 此问题是在 exporter 端观察到的，而不是在 RocketMQ broker 本身。
- 增加内存后，重新检查 pod 稳定性和 exporter 抓取连续性。

---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500540
sourceSHA: a32bf7d57f9bc77a45ba1acf4e1cb50075ee806b3f06d976dae37c46fa598aa8
---

# 在 Alauda Service Mesh v2 中禁用 istio-proxy sidecar 的 startupProbe

## 问题

在 Alauda Container Platform（kubernetes v1.34.5，`servicemesh-operator2.v2.1.2` 打包的 Istio v1.28.6）上，Istio 变更注入 webhook 添加到 mesh-member pods 的 `istio-proxy` sidecar 容器是一个纯上游 Istio 数据平面原语，在此 Istio 版本中，渲染的容器携带一个 Kubernetes `startupProbe`。`startupProbe` 字段是标准的 `core/v1.Container.startupProbe`（`Probe`）；根据其上游描述，当探测失败时，pod 会被重启，类似于 `livenessProbe` 失败。

在应用容器启动缓慢的工作负载上——例如，JVM 重的镜像、在启动时等待远程依赖的 pods，或在瞬时压力下的节点——注入的 `istio-proxy` 上反复出现 `startupProbe` 失败会导致 kubelet 重启 pod。重启周期在 kubelet 开始评估 `readinessProbe` 和 `livenessProbe` 之前增加了可观察的几秒延迟，但一旦 sidecar 最终通过启动，mesh 数据平面本身不受影响。

## 解决方案

注入的 `istio-proxy` sidecar 形状由上游 Istio 注入模板驱动，该模板接受 `global.proxy.startupProbe.enabled`；将该模板值设置为 `false` 会导致注入 webhook 渲染不带 `startupProbe` 的 `istio-proxy` 容器。在 Alauda Service Mesh v2（servicemesh-operator2.v2.1.2）中，该模板值通过 Sail `Istio` 自定义资源（`sailoperator.io/v1`）访问——其 `spec.values` 块暴露上游 Istio 配置值，该字段直接设置在 `spec.values.global.proxy.startupProbe.enabled` 下。

编辑集群的 Sail `Istio` 自定义资源（其名称和命名空间取决于 servicemesh-operator2 的安装方式；替换为实际的控制平面名称和命名空间）并添加值覆盖：

```bash
kubectl -n istio-system edit istio default
```

```yaml
apiVersion: sailoperator.io/v1
kind: Istio
metadata:
  name: default
spec:
  version: v1.28.6
  values:
    global:
      proxy:
        startupProbe:
          enabled: false
```

运行容器上的 `startupProbe` 字段是不可变的——其上游描述指出 `This cannot be updated.`——因此在 `Istio` CR 更改之前运行的 pods 保留了之前的 sidecar 形状。重启（重新注入）这些 pods，以便注入 webhook 重新渲染它们的 `istio-proxy` 容器，不带 `startupProbe`：

```bash
kubectl -n <workload-namespace> rollout restart deployment <name>
```

在发布后，新创建的 pods 将携带不带 `startupProbe` 的 `istio-proxy` 容器，kubelet 将立即在容器启动时开始评估 `readinessProbe` 和 `livenessProbe`。

## 诊断步骤

当 pods 表现出缓慢启动并追溯到 `istio-proxy` 的 `startupProbe` 时，kubelet 会发出 Kubernetes `Event` 对象，带有 `reason=Unhealthy` 和引用失败启动探测的 `message`（例如，`startup probe failed: ...`）；这些事件在命名空间事件列表和 `describe pod` 输出中可见：

```bash
kubectl -n <workload-namespace> get events --sort-by=.lastTimestamp | grep -i startup
kubectl -n <workload-namespace> describe pod <pod-name>
```

在携带注入的 `istio-proxy` sidecar 的 mesh 命名空间中，直接检查候选 pod 上的容器，以确认 `startupProbe` 字段在更改前存在（更改前）或在重新注入后缺失（更改后）：

```bash
kubectl -n <workload-namespace> get pod <pod-name> \
  -o jsonpath='{.spec.containers[?(@.name=="istio-proxy")].startupProbe}'
```

如果该字段打印为非空 JSON 对象，则 pod 仍在运行并带有探测，必须重启以获取更新的注入模板值。

---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500307
sourceSHA: 5576f2c9360ad49f6c7df1f1ef2460b20ea34bd7c413940bed6f3dc1a3b6b395
---

# kube-controller-manager 因为配置错误的 HPA 导致的领导选举租约续约失败而重启

## 问题

在 Alauda 容器平台上，kube-controller-manager (KCM) 作为 kubelet 管理的控制平面静态 Pod 运行在 `kube-system` 命名空间中——例如 `kube-controller-manager-192.168.135.152`，携带静态 Pod 镜像注释和类型为 `Node` 的拥有者引用，没有单独的管理操作员。该 Pod 通过定期续订名为 `kube-controller-manager` 的领导选举 Lease 对象来保持控制平面领导权，该 Lease 位于 `kube-system` 下，使用 `coordination.k8s.io/v1` API；该 Lease 的 `leaseDurationSeconds` 为 `15`，这是进程每个周期必须在此时间内完成续订的截止时间，其 `holderIdentity` 和前进的 `renewTime` 反映了实时心跳（镜像 `registry.alauda.cn:60080/tkestack/kube-controller-manager:v1.34.5`）。

该配置的一个症状是 KCM Pod 不断重启：每次重启都会增加 Pod 的 `restartCount`，并在 Pod 状态中留下填充的 previous-termination 块，根本原因追溯到进程失去其领导选举租约。

## 根本原因

当 kube-controller-manager 无法及时访问其领导选举 Lease 时，它会遵循其自身日志中可观察到的领导选举代码路径：它尝试获取并续订 `kube-system/kube-controller-manager` 的租约，并在续订失败时记录针对该锁的资源锁获取错误（`error retrieving resource lock kube-system/kube-controller-manager`）。这是失去领导权的前兆。

kube-controller-manager 以 `--leader-elect=true` 运行，因此它参与领导选举，失去租约会终止该进程；在此路径上，容器的 `lastState.terminated.reason` 被记录为 `Error`。进程终止导致 Pod 重启。

水平 Pod 自动扩缩器 (HPA) 控制器作为同一 kube-controller-manager 进程中的控制循环运行：KCM 以默认的 `--controllers=*` 设置启动，启动日志显示 `horizontal-pod-autoscaler-controller` 在进程中启动。由于 HPA 控制器与领导选举共享进程，文档中记录的上游故障模式是，在该循环内的持续压力可能与租约的及时续订竞争——而该 Lease 的 `leaseDurationSeconds` 为 `15`，进程必须在每个周期内满足该时间。

计算 CPU 利用率目标的 HPA 依赖于目标工作负载的容器声明 CPU 资源请求：`averageUtilization` 目标被定义为请求值的百分比，因此当目标容器没有 CPU 请求时，HPA 无法计算利用率，而是出现报告缺失 CPU 请求的指标错误。在文档中记录的上游故障模式中，处于这种配置错误条件下的 HPA 与控制器管理器进程中的内存增长相关，这也是本文所讨论的路径。

## 解决方案

检查并纠正 HorizontalPodAutoscaler 配置，以便 HPA 控制循环不再陷入指标错误条件。HorizontalPodAutoscaler 原语在 `autoscaling/v2` 中提供（类型 `HorizontalPodAutoscaler`，简称 `hpa`）；列出集群中的 HPA 对象以确认是否存在以及它们所针对的工作负载。

```bash
kubectl get hpa --all-namespaces
kubectl describe hpa <hpa-name> -n <namespace>
```

对于一个针对 CPU 利用率的 HPA，确保目标工作负载中的每个容器都声明了 CPU 资源请求，因为利用率目标被评估为请求值的百分比；指向没有 CPU 请求的工作负载的 HPA 无法计算利用率，并产生缺失 CPU 请求的指标错误。

```yaml
spec:
  containers:
    - name: app
      resources:
        requests:
          cpu: 200m
```

在不需要 HorizontalPodAutoscaler 的情况下，移除它同样可以清除在 kube-controller-manager 中运行的 HPA 控制器循环中的指标错误条件。

## 诊断步骤

确认 `kube-system` 中 kube-controller-manager 静态 Pod 的重启模式。频繁重启的 Pod 显示出较高的 `restartCount`，并伴随有 previous-termination 块；在失去领导选举的路径上，之前的终止记录的 `reason` 为 `Error`。读取 Pod 状态及其 previous-termination 详细信息。

```bash
kubectl get pods -n kube-system -l component=kube-controller-manager
kubectl describe pod -n kube-system <kcm-pod-name>
kubectl get pod -n kube-system <kcm-pod-name> \
  -o jsonpath='{.status.containerStatuses[0].lastState.terminated}'
```

检查 `kube-system` 中 kube-controller-manager 容器的日志以获取领导选举序列——尝试获取和续订租约，随后是针对 `kube-system/kube-controller-manager` 的资源锁获取错误，标志着续订失败。

```bash
kubectl logs -n kube-system <kcm-pod-name> | grep -i leaderelection
kubectl logs -n kube-system <kcm-pod-name> --previous | grep -i "resource lock"
```

验证领导选举 Lease 本身以读取续订截止时间和当前持有者。Lease 位于 `kube-system/kube-controller-manager` 下，使用 `coordination.k8s.io/v1`，其 `leaseDurationSeconds` 为 `15`；当前持有者的 `renewTime` 停止前进表明该进程不再及时续订租约。

```bash
kubectl get lease kube-controller-manager -n kube-system \
  -o jsonpath='{.spec.leaseDurationSeconds}{"\t"}{.spec.holderIdentity}{"\t"}{.spec.renewTime}'
```

在诊断时交叉参考 HPA 库：列出 `autoscaling/v2` HorizontalPodAutoscaler 对象，以确定是否存在配置错误的 HPA，因为没有 HorizontalPodAutoscaler 对象的集群没有活动的 HPA 错误循环来驱动此条件。

```bash
kubectl get hpa --all-namespaces -o wide
```

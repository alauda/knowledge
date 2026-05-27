---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500229
sourceSHA: 0c09b92085a8baff160f369e5285525865cde0600fa3ab698fe0e6b12f58819e
---

# 应用程序 Pod 因 OOMKilled 和存活探针超时而重启

## 问题

在 Alauda 容器平台（Kubernetes v1.34.5，Ubuntu 22.04.1 LTS 节点，内核 5.15.0-56-generic）上，当应用程序容器的内存使用达到配置的 `resources.limits.memory` 时，该容器会被终止。kubelet 将容器的终止状态标记为标准原因值 `OOMKilled`，该值在 Pod 状态下的 `status.containerStatuses[].state.terminated.reason` 中显示，或者在重启后显示在 `status.containerStatuses[].lastState.terminated.reason` 中（与上游 Pod v1 形状相匹配的 `exitCode`、`finishedAt`、`signal` 和 `containerID` 字段被填充）。

当同一容器被 kubelet 重启并在每次重试时再次 OOM 被杀死时，kubelet 将重启策略升级为退避循环，并在 `status.containerStatuses[].state.waiting.reason` 下报告容器，原因值为 `CrashLoopBackOff` —— 这是上游 Pod v1 中标准的容器重复失败启动的原因。

在相同的内存压力下，kubelet 对容器的存活探针也可能在 cgroup 限制达到之前失败，因为上游 `Probe` 形状默认将 `timeoutSeconds` 设置为 `1`（`periodSeconds` 为 `10`，`failureThreshold` 为 `3`）；当应用程序线程被内核内存子系统暂停时，1 秒的 HTTP 探针超时，kubelet 记录一行 `prober.go:NNN] Liveness probe for <pod>:<container> failed (failure): Get http://...: net/http: request canceled (Client.Timeout exceeded while awaiting headers)`，该行随后可通过 kubelet 的日志单元查看。

## 根本原因

在负载下，容器的工作集内存超过了 `resources.limits.memory` 中设置的值。当 cgroup 内存控制器终止有问题的进程时，容器以 `state.terminated.reason=OOMKilled` 结束，该杀死在 Pod 对象上反映；如果 Pod 的 `restartPolicy` 允许，容器将被重启，重复相同形式的失败在后续尝试中显示为 `state.waiting.reason=CrashLoopBackOff`。

相同的内存压力还会使进程中的工作停滞足够长的时间，以至于默认的 1 秒存活探针超时触发；kubelet 将连续失败（默认 `failureThreshold=3`）视为探针失败并重启容器，这加剧了在 Pod 状态中观察到的由 OOM 驱动的重启循环。

## 解决方案

通过设置 `resources.requests.memory` 和 `resources.limits.memory` 为覆盖应用程序峰值工作集的值，来提高工作负载的 Deployment（或其他控制器）上的容器内存预算。Pod 规格字段形状 `containers[].resources.{limits,requests}` 是上游的 `map[string]Quantity`（键 `memory`、`cpu`、`ephemeral-storage`），在 ACP 上是相同的，因此标准清单可以逐字应用：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      containers:
        - name: my-app
          image: my-app:latest
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "500m"
```

使用标准的发布应用更改：

```bash
kubectl apply -f my-app-deployment.yaml
kubectl rollout status deploy/my-app
```

如果存活探针在负载下也出现问题，请放宽探针预算，以便在瞬态内存压力期间不会触发 1 秒的默认超时。`Probe` 形状直接在容器规格上暴露 `timeoutSeconds`、`periodSeconds` 和 `failureThreshold`，提高 `timeoutSeconds`（如有需要，也可以提高 `failureThreshold`）可以给应用程序时间在内核短暂暂停时作出响应：

```yaml
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          timeoutSeconds: 5
          periodSeconds: 10
          failureThreshold: 3
```

对于内存占用随流量变化的工作负载（高峰时段负载、批处理窗口），将限制增加与 `HorizontalPodAutoscaler` 配对，以便在任何单个副本达到其限制之前，副本数量增加。HPA api-group `autoscaling/v2`（`HorizontalPodAutoscaler`，简称 `hpa`）在 ACP 上保持不变，并接受标准的上游规格：

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-app
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 75
```

```bash
kubectl apply -f my-app-hpa.yaml
kubectl get hpa my-app
```

## 诊断步骤

识别被杀死的容器，并直接确认 Pod 对象上的终止原因。`OOMKilled` 原因是 kubelet 在 cgroup 内存控制器终止容器进程时写入的，它出现在当前尝试的 `state.terminated.reason` 或在容器重启后出现在 `lastState.terminated.reason` 中：

```bash
kubectl get pod <pod> -o yaml
kubectl get pod <pod> \
  -o jsonpath='{.status.containerStatuses[*].lastState.terminated.reason}'
kubectl get pod <pod> \
  -o jsonpath='{.status.containerStatuses[*].state.terminated.reason}'
```

检查同一容器是否现在处于退避循环中。容器状态下的等待原因 `CrashLoopBackOff` 是 kubelet 对重复失败的标准信号，在持续 OOM 杀死的 Pod 上，这就是出现的值：

```bash
kubectl get pod <pod> \
  -o jsonpath='{.status.containerStatuses[*].state.waiting.reason}'
kubectl describe pod <pod>
```

当怀疑存活探针失败是一个促发因素时，请查看 Pod 被调度的节点上的 kubelet 日志——`prober.go` 日志行以上游格式显示探针失败，ACP 节点上的 kubelet 作为普通的 systemd 单元 `kubelet.service` 运行，因此 `journalctl -u kubelet` 显示相同的行形状：

```bash
kubectl get pod <pod> -o jsonpath='{.spec.nodeName}'
journalctl -u kubelet --since "1 hour ago" | grep -E 'prober.go.*Liveness probe'
```

---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500164
sourceSHA: 383218d602417254b97ef67f27cf5e19e533bf4d64ec4d49356ae67ef76ca67b
---

# 使用 kubectl 检查 ACP 集群健康状态

## 问题

Alauda 容器平台 4.3.x 集群的操作员（Kubernetes 服务器 `v1.34.5`，Ubuntu 22.04.1 LTS 节点，使用 `containerd://2.2.1-5`）需要一组简短且可重复的 `kubectl` 检查，以确认节点已注册且处于 Ready 状态，没有 CertificateSigningRequest 对象处于待处理状态，并且 etcd 法定人数健康。以下命令生成管理员在处理控制平面事件或维护窗口之前首先扫描的标题列。

## 诊断步骤

列出与集群注册的每个节点及其 `STATUS`、`ROLES`、`AGE` 和 kubelet `VERSION` 列：

```bash
kubectl get nodes
```

```text
NAME              STATUS   ROLES                                   AGE   VERSION
<control-plane>   Ready    control-plane,cpaas-system,master       12d   v1.34.5
```

在 ACP 上，`ROLES` 列除了上游的 `control-plane` / `master` 角色外，还包含平台特定的 `cpaas-system` 角色。

附加 `-o wide` 以添加 `INTERNAL-IP`、`EXTERNAL-IP`、`OS-IMAGE`、`KERNEL-VERSION` 和 `CONTAINER-RUNTIME` 列。在此集群中，`OS-IMAGE` 列报告 `Ubuntu 22.04.1 LTS`，这些节点上的容器运行时为 `containerd://2.2.1-5`：

```bash
kubectl get nodes -o wide
```

```text
NAME              STATUS  ...  INTERNAL-IP       EXTERNAL-IP  OS-IMAGE             KERNEL-VERSION      CONTAINER-RUNTIME
<control-plane>   Ready   ...  192.168.135.152   <none>       Ubuntu 22.04.1 LTS   5.15.0-56-generic   containerd://2.2.1-5
```

健康的集群没有 CertificateSigningRequest 对象处于 `Pending` 状态。在稳定状态的 ACP 集群中，查询通常返回 `No resources found`，这是预期的健康读数：

```bash
kubectl get csr
```

```text
No resources found
```

检查每个端点的 etcd 数据库大小。在 ACP 上，etcd 成员作为名为 `etcd-<control-plane-ip>` 的静态 Pod 运行在 `kube-system` 命名空间中，且 `etcdctl` 可在该 Pod 内使用；通过 `kubectl exec` 访问 etcd Pod，客户端使用静态 Pod 的 PKI 挂载。`endpoint status --cluster -w table` 形式打印 `ENDPOINT`、`ID`、`VERSION`、`DB SIZE`、`IS LEADER`、`IS LEARNER`、`RAFT TERM`、`RAFT INDEX`、`RAFT APPLIED INDEX` 和 `ERRORS` 列。在一个运行了 12 天的单控制平面集群中，`DB SIZE` 列显示为 `163 MB`，远低于 1 GiB 的阈值，尽管这本身不是错误，但被视为警告信号，`VERSION` 报告为 `3.5.28`：

```bash
kubectl exec -n kube-system etcd-<control-plane-ip> -- \
  etcdctl --cacert=/etc/kubernetes/pki/etcd/ca.crt \
          --cert=/etc/kubernetes/pki/etcd/server.crt \
          --key=/etc/kubernetes/pki/etcd/server.key \
          endpoint status --cluster -w table
```

```text
+------------------------------+------------------+---------+---------+-----------+...
|           ENDPOINT           |        ID        | VERSION | DB SIZE | IS LEADER |...
+------------------------------+------------------+---------+---------+-----------+...
| https://<control-plane-ip>:2379 | xxxxxxxxxxxxxxxx |  3.5.28 |  163 MB |   true    |...
+------------------------------+------------------+---------+---------+-----------+...
```

使用匹配的 `endpoint health` 形式检查每个端点的健康状态和往返延迟。表格列为 `ENDPOINT`、`HEALTH`、`TOOK` 和 `ERROR`；`HEALTH` 列读取为 `true` 是通过/失败信号。`TOOK` 值是单次往返时间，而不是硬性阈值——健康的关键在于 `HEALTH` 为 `true`，并且 `TOOK` 保持在低毫秒范围内，并在重复检查中保持稳定，而不是任何特定的截止值。在这个实验室的单控制平面集群中，`TOOK` 被观察为 `11.739462ms`；将其视为示例数据点，而不是限制（单数字毫秒值是常见的，且在其他健康端点上暂时较高的读数本身并不是问题）：

```bash
kubectl exec -n kube-system etcd-<control-plane-ip> -- \
  etcdctl --cacert=/etc/kubernetes/pki/etcd/ca.crt \
          --cert=/etc/kubernetes/pki/etcd/server.crt \
          --key=/etc/kubernetes/pki/etcd/server.key \
          endpoint health --cluster -w table
```

```text
+------------------------------+--------+---------------+-------+
|           ENDPOINT           | HEALTH |     TOOK      | ERROR |
+------------------------------+--------+---------------+-------+
| https://<control-plane-ip>:2379 |  true  | 11.739462ms   |       |
+------------------------------+--------+---------------+-------+
```

传统的 `kubectl get componentstatus` 查询仍然由 Kubernetes `v1.34.5` 的 apiserver 提供，并返回 `scheduler`、`controller-manager` 和 `etcd-0` 行，包含 `STATUS`、`MESSAGE` 和 `ERROR` 列；apiserver 首先打印 `Warning: v1 ComponentStatus is deprecated in v1.19+`，因为该 API 被标记为最终删除。在单控制平面主机上，`scheduler` 和 `controller-manager` 行经常显示为 `Unhealthy`，并带有 `127.0.0.1:10259: connect: connection refused` 风格的消息，因为它们的 `/healthz` 端点绑定到静态 Pod 的主机网络中的 `127.0.0.1`，无法从 kubelet 主机外部访问；而 `etcd-0` 行则报告为 `Healthy`：

```bash
kubectl get componentstatus
```

```text
Warning: v1 ComponentStatus is deprecated in v1.19+
NAME                 STATUS      MESSAGE                                                                  ERROR
scheduler            Unhealthy   Get "https://127.0.0.1:10259/healthz": dial tcp 127.0.0.1:10259: connect: connection refused
controller-manager   Unhealthy   Get "https://127.0.0.1:10257/healthz": ...
etcd-0               Healthy     ok
```

## 解决方案

使用 `kubectl get nodes` / `kubectl get nodes -o wide` / `kubectl get csr` / `kubectl exec -n kube-system etcd-<control-plane-ip> -- etcdctl ... endpoint status|health --cluster -w table` 上述序列作为 ACP 4.3.x 的常规集群健康烟雾测试。将节点上的 `STATUS` 列、`kubectl get csr` 中缺少 `Pending` 行、etcd `DB SIZE` 保持在 1 GiB 以下，以及每个 etcd 端点的 `HEALTH` 列读取为 `true` 视为绿色信号；在进一步更改之前调查任何偏差。已弃用的 `kubectl get componentstatus` 输出仍然对 etcd 行有参考价值，但不应依赖于控制平面上 `/healthz` 监听器绑定到 `127.0.0.1` 的调度程序和控制管理器行；这些行在主机外部预期读取为 `Unhealthy`，并不意味着控制平面本身出现故障。

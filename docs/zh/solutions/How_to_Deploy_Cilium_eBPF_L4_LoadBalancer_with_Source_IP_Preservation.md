---
id: KB260300001
products:
  - Alauda Container Platform
kind:
  - Solution
sourceSHA: f08bed9e8e3925b9d23738b44dac6e99b0d27fbf6802f8976076f756383d70d6
---

# 使用 Cilium CNI 和基于 eBPF 的 L4 负载均衡器实现高性能容器网络（源 IP 保留）

本文档描述了如何在 ACP 4.2+ 集群中部署 Cilium CNI，并利用 eBPF 实现高性能的第四层负载均衡，同时保留源 IP。

## 先决条件

| 项目         | 要求             |
| ------------ | ---------------- |
| ACP 版本     | 4.2+             |
| 网络模式     | 自定义模式       |
| 架构         | x86_64 / amd64   |

> **注意**：Cilium/eBPF 需要 Linux 内核 4.19+（推荐 5.10+）。以下操作系统 **不支持**：
>
> - CentOS 7.x（内核版本 3.10.x）
> - RHEL 7.x（内核版本 3.10.x - 4.18.x）
>
> 支持的操作系统：
>
> - Ubuntu 22.04
> - RHEL 8.x
> - openEuler 22.03

### 节点端口要求

| 端口 | 组件            | 描述               |
| ---- | --------------- | ------------------ |
| 4240 | cilium-agent    | 健康 API          |
| 9962 | cilium-agent    | Prometheus 指标   |
| 9879 | cilium-agent    | Envoy 指标        |
| 9890 | cilium-agent    | 智能体指标        |
| 9963 | cilium-operator | Prometheus 指标   |
| 9891 | cilium-operator | Operator 指标     |
| 9234 | cilium-operator | 指标              |

### 内核配置要求

确保节点上启用了以下内核配置（可以通过 `grep` 在 `/boot/config-$(uname -r)` 中检查）：

- `CONFIG_BPF=y` 或 `=m`
- `CONFIG_BPF_SYSCALL=y` 或 `=m`
- `CONFIG_NET_CLS_BPF=y` 或 `=m`
- `CONFIG_BPF_JIT=y` 或 `=m`
- `CONFIG_NET_SCH_INGRESS=y` 或 `=m`
- `CONFIG_CRYPTO_USER_API_HASH=y` 或 `=m`

## ACP 4.x Cilium 部署步骤

### 步骤 1：创建集群

在集群创建页面，将 **网络模式** 设置为 **自定义** 模式。在集群达到 `EnsureWaitClusterModuleReady` 状态后再部署 Cilium。

### 步骤 2：安装 Cilium

1. 从 ACP 市场下载最新的 Cilium 镜像包（v4.2.x）

2. 使用 violet 上传到平台：

```bash
export PLATFORM_URL=""
export USERNAME=''
export PASSWORD=''
export CLUSTER_NAME=''

violet push cilium-v4.2.17.tgz --platform-address "$PLATFORM_URL" --platform-username "$USERNAME" --platform-password "$PASSWORD" --clusters "$CLUSTER_NAME"
```

3. 在将要安装 Cilium 的业务集群上创建临时 RBAC 配置（此 RBAC 权限在集群成功部署之前未配置）：

创建临时 RBAC 配置文件：

```bash
cat > tmp.yaml << 'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cilium-clusterplugininstance-admin
  labels:
    app.kubernetes.io/name: cilium
rules:
- apiGroups: ["cluster.alauda.io"]
  resources: ["clusterplugininstances"]
  verbs: ["*"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cilium-admin-clusterplugininstance
  labels:
    app.kubernetes.io/name: cilium
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cilium-clusterplugininstance-admin
subjects:
- apiGroup: rbac.authorization.k8s.io
  kind: User
  name: admin
EOF
```

应用临时 RBAC 配置：

```bash
kubectl apply -f tmp.yaml
```

4. 导航到 **管理员 → 市场 → 集群插件** 并安装 Cilium

5. Cilium 安装成功后，删除临时 RBAC 配置：

```bash
kubectl delete -f tmp.yaml
rm tmp.yaml
```

## 创建具有源 IP 保留的 L4 负载均衡器

在主节点后端执行以下操作。

### 步骤 1：移除 kube-proxy 并清理规则

1. 获取当前 kube-proxy 镜像：

```bash
kubectl get -n kube-system kube-proxy -oyaml | grep image
```

2. 备份并删除 kube-proxy DaemonSet：

```bash
kubectl -n kube-system get ds kube-proxy -oyaml > kube-proxy-backup.yaml

kubectl -n kube-system delete ds kube-proxy
```

3. 创建一个 BroadcastJob 来清理 kube-proxy 规则：

```yaml
apiVersion: operator.alauda.io/v1alpha1
kind: BroadcastJob
metadata:
  name: kube-proxy-cleanup
  namespace: kube-system
spec:
  completionPolicy:
    ttlSecondsAfterFinished: 300
    type: Always
  failurePolicy:
    type: FailFast
  template:
    metadata:
      labels:
        k8s-app: kube-proxy-cleanup
    spec:
      serviceAccountName: kube-proxy
      hostNetwork: true
      restartPolicy: Never
      nodeSelector:
        kubernetes.io/os: linux
      priorityClassName: system-node-critical
      tolerations:
      - operator: Exists
      containers:
      - name: kube-proxy-cleanup
        image: registry.alauda.cn:60070/tkestack/kube-proxy:<KUBERNETES_VERSION>      ## 用步骤 1 中获取的 kube-proxy 镜像替换
        imagePullPolicy: IfNotPresent
        command:
        - /bin/sh
        - -c
        - "/usr/local/bin/kube-proxy --config=/var/lib/kube-proxy/config.conf --hostname-override=$(NODE_NAME) --cleanup || true"
        env:
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              apiVersion: v1
              fieldPath: spec.nodeName
        securityContext:
          privileged: true
        volumeMounts:
        - mountPath: /var/lib/kube-proxy
          name: kube-proxy
        - mountPath: /lib/modules
          name: lib-modules
          readOnly: true
        - mountPath: /run/xtables.lock
          name: xtables-lock
      volumes:
      - name: kube-proxy
        configMap:
          name: kube-proxy
      - name: lib-modules
        hostPath:
          path: /lib/modules
          type: ""
      - name: xtables-lock
        hostPath:
          path: /run/xtables.lock
          type: FileOrCreate
```

保存为 `kube-proxy-cleanup.yaml` 并应用：

```bash
kubectl apply -f kube-proxy-cleanup.yaml
```

BroadcastJob 配置了 `ttlSecondsAfterFinished: 300`，将在完成后 5 分钟内自动清理。

### 步骤 2：创建地址池

> **VIP 地址要求**：Cilium L2 通告通过 ARP 广播实现 IP 故障转移。因此，VIP 必须在与集群节点 **相同的第二层网络** 中，以确保 ARP 请求能够正确广播并响应。

保存为 `lb-resources.yaml`：

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancerIPPool
metadata:
  name: lb-pool
spec:
  blocks:
    - cidr: "192.168.132.192/32"    # 用实际的 VIP 段替换
---
apiVersion: cilium.io/v2alpha1
kind: CiliumL2AnnouncementPolicy
metadata:
  name: l2-policy
spec:
  interfaces:
    - eth0                          # 用实际的网络接口名称替换
  externalIPs: true
  loadBalancerIPs: true
```

应用配置：

```bash
kubectl apply -f lb-resources.yaml
```

### 步骤 3：验证

创建一个 LoadBalancer 服务以验证 IP 分配并测试连接性。

**验证 1：检查 LB 服务是否已分配 IP**

```bash
kubectl get svc -A
```

预期输出示例：

```text
NAMESPACE      NAME                      TYPE           CLUSTER-IP     EXTERNAL-IP       PORT(S)                     AGE
cilium-123-1   test                      LoadBalancer   10.4.98.81     192.168.132.192   80:31447/TCP                35s
```

**验证 2：检查领导节点发送的 ARP 请求**

```bash
kubectl get leases -A | grep cilium
```

预期输出示例：

```text
cpaas-system      cilium-l2announce-cilium-123-1-test       192.168.141.196                                                                 24s
```

**验证 3：测试外部访问**

从外部客户端访问 LoadBalancer 服务。在 Pod 内捕获的数据包应显示源 IP 为客户端的 IP，表明源 IP 保留成功。

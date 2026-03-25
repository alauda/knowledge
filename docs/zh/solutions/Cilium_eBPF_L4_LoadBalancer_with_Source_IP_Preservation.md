---
id: KB260300001
products:
  - Alauda Container Platform
kind:
  - Solution
sourceSHA: pending
---

# 基于 eBPF 的高性能容器网络 Cilium CNI 和 eBPF 实现的高性能四层负载均衡（支持源 IP 可见的 S2 方案）

本文档介绍如何在 ACP 4.2 以上版本集群中部署 Cilium CNI，并利用 eBPF 实现高性能四层负载均衡，支持源 IP 透传。

## 环境要求

| 项目 | 要求 |
|------|------|
| ACP 版本 | 4.2+ |
| 网络模式 | Custom（自定义）模式 |
| 架构 | x86_64 / amd64 |

> **注意**：由于 Cilium/eBPF 需要 Linux 内核 4.19+（推荐 5.10+），以下操作系统**不支持**：
> - CentOS 7.x（内核版本 3.10.x）
> - RHEL 7.x（内核版本 3.10.x - 4.18.x）
>
> 支持的操作系统：
> - Ubuntu 22.04
> - RHEL 8.x
> - 麒麟 V10-SP3
> - openEuler 22.03

### 节点端口要求

| 端口 | 组件 | 说明 |
|------|------|------|
| 4240 | cilium-agent | Health API |
| 9962 | cilium-agent | Prometheus Metrics |
| 9879 | cilium-agent | Envoy Metrics |
| 9890 | cilium-agent | Agent Metrics |
| 9963 | cilium-operator | Prometheus Metrics |
| 9891 | cilium-operator | Operator Metrics |
| 9234 | cilium-operator | Metrics |

### 内核配置要求

确保节点内核已启用以下配置（可通过 `grep` 检查 `/boot/config-$(uname -r)`）：

- `CONFIG_BPF=y` 或 `=m`
- `CONFIG_BPF_SYSCALL=y` 或 `=m`
- `CONFIG_NET_CLS_BPF=y` 或 `=m`
- `CONFIG_BPF_JIT=y` 或 `=m`
- `CONFIG_NET_SCH_INGRESS=y` 或 `=m`
- `CONFIG_CRYPTO_USER_API_HASH=y` 或 `=m`

## ACP 4.x Cilium 部署步骤

### Step 1: 创建集群

在创建集群页面，**Network Mode（网络模式）** 使用 **Custom** 模式。等到集群到达 `EnsureWaitClusterModuleReady` 状态时，再去部署 Cilium。

### Step 2: 安装 Cilium

1. 从 ACP 应用市场下载最新的 Cilium 镜像包（v4.2.x 版本）
2. 使用 violet 上传到环境：

```bash
export PLATFORM_URL=""
export USERNAME=''
export PASSWORD=''
export CLUSTER_NAME=''

violet push cilium-v4.2.17.tgz --platform-address "$PLATFORM_URL" --platform-username "$USERNAME" --platform-password "$PASSWORD" --clusters "$CLUSTER_NAME"
```

3. 在安装 Cilium 的业务集群临时配置 RBAC（因为集群部署成功前这个 RBAC 权限还没配置，所以需要临时配置）：

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

4. 进入 **平台管理 → 应用市场 → 集群插件**，找到并安装 Cilium

5. Cilium 安装成功后，删除临时 RBAC 配置：

```bash
kubectl delete -f tmp.yaml
rm tmp.yaml
```

## 创建透传的 L4 负载均衡

进入后台 master 节点执行以下操作。

### Step 1: 删除 kube-proxy 并清理规则

1. 获取 kube-proxy 当前的镜像：

```bash
kubectl get -n kube-system kube-proxy -oyaml | grep image
```

2. 备份并删除 kube-proxy 的 DaemonSet：

```bash
kubectl -n kube-system get ds kube-proxy -oyaml > kube-proxy-backup.yaml

kubectl -n kube-system delete ds kube-proxy
```

3. 创建清理的 BroadcastJob：

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
        image: registry.alauda.cn:60070/tkestack/kube-proxy:v1.33.5      ## 替换成当前环境的 kube-proxy 镜像
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

BroadcastJob 配置了 `ttlSecondsAfterFinished: 300`，执行完成后会在 5 分钟内自动清理。

### Step 2: 创建地址池

> **VIP 地址要求**：Cilium L2 Announcement 通过 ARP 广播实现 IP 漂移，因此 VIP 必须与集群节点在**同一个二层网络**中，确保 ARP 请求能够正常广播和响应。

保存为 `lb-resources.yaml`：

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancerIPPool
metadata:
  name: lb-pool
spec:
  blocks:
    - cidr: "192.168.132.192/32"    # 替换为实际分配的 VIP 段
---
apiVersion: cilium.io/v2alpha1
kind: CiliumL2AnnouncementPolicy
metadata:
  name: l2-policy
spec:
  interfaces:
    - eth0                          # 替换为实际网卡名
  externalIPs: true
  loadBalancerIPs: true
```

应用配置：

```bash
kubectl apply -f lb-resources.yaml
```

### Step 3: 验证

创建 LB Service，验证是否分配到 IP，并测试连通性。

**验证 1：查看 LB Service 是否分配了 IP**

```bash
kubectl get svc -A
```

预期输出示例：

```text
NAMESPACE      NAME                      TYPE           CLUSTER-IP     EXTERNAL-IP       PORT(S)                     AGE
cilium-123-1   test                      LoadBalancer   10.4.98.81     192.168.132.192   80:31447/TCP                35s
```

**验证 2：查看发起 ARP 请求的 Leader 节点**

```bash
kubectl get leases -A | grep cilium
```

预期输出示例：

```text
cpaas-system      cilium-l2announce-cilium-123-1-test       192.168.141.196                                                                 24s
```

**验证 3：测试外部访问**

从外部能访问通这个 LoadBalancer Service，并且在 Pod 内抓包可以看到源 IP 是 Client 端的，即透传成功。

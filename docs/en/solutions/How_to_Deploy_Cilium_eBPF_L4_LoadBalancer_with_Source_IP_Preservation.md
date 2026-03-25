---
id: KB260300001
products:
  - Alauda Container Platform
kind:
  - Solution
sourceSHA: pending
---

# High-Performance Container Networking with Cilium CNI and eBPF-based L4 Load Balancer (Source IP Preservation)

This document describes how to deploy Cilium CNI in a ACP 4.2+ cluster and leverage eBPF to implement high-performance Layer 4 load balancing with source IP preservation.

## Prerequisites

| Item | Requirement |
|------|------|
| ACP Version | 4.2+ |
| Network Mode | Custom Mode |
| Architecture | x86_64 / amd64 |

> **Note**: Cilium/eBPF requires Linux kernel 4.19+ (5.10+ recommended). The following operating systems are **NOT supported**:
> - CentOS 7.x (kernel version 3.10.x)
> - RHEL 7.x (kernel version 3.10.x - 4.18.x)
>
> Supported operating systems:
> - Ubuntu 22.04
> - RHEL 8.x
> - Kylin V10-SP3
> - openEuler 22.03

### Node Port Requirements

| Port | Component | Description |
|------|------|------|
| 4240 | cilium-agent | Health API |
| 9962 | cilium-agent | Prometheus Metrics |
| 9879 | cilium-agent | Envoy Metrics |
| 9890 | cilium-agent | Agent Metrics |
| 9963 | cilium-operator | Prometheus Metrics |
| 9891 | cilium-operator | Operator Metrics |
| 9234 | cilium-operator | Metrics |

### Kernel Configuration Requirements

Ensure the following kernel configurations are enabled on the nodes (can be checked via `grep` in `/boot/config-$(uname -r)`):

- `CONFIG_BPF=y` or `=m`
- `CONFIG_BPF_SYSCALL=y` or `=m`
- `CONFIG_NET_CLS_BPF=y` or `=m`
- `CONFIG_BPF_JIT=y` or `=m`
- `CONFIG_NET_SCH_INGRESS=y` or `=m`
- `CONFIG_CRYPTO_USER_API_HASH=y` or `=m`

## ACP 4.x Cilium Deployment Steps

### Step 1: Create Cluster

On the cluster creation page, set **Network Mode** to **Custom** mode. Wait until the cluster reaches `EnsureWaitClusterModuleReady` status before deploying Cilium.

### Step 2: Install Cilium

1. Download the latest Cilium image package (v4.2.x) from the ACP marketplace

2. Upload to the platform using violet:

```bash
export PLATFORM_URL=""
export USERNAME=''
export PASSWORD=''
export CLUSTER_NAME=''

violet push cilium-v4.2.17.tgz --platform-address "$PLATFORM_URL" --platform-username "$USERNAME" --platform-password "$PASSWORD" --clusters "$CLUSTER_NAME"
```

3. Create temporary RBAC configuration on the business cluster where Cilium will be installed (this RBAC permission is not configured before the cluster is successfully deployed):

Create temporary RBAC configuration file:

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

Apply temporary RBAC configuration:

```bash
kubectl apply -f tmp.yaml
```

4. Navigate to **Administrator → Marketplace → Cluster Plugins** and install Cilium

5. After Cilium is successfully installed, delete the temporary RBAC configuration:

```bash
kubectl delete -f tmp.yaml
rm tmp.yaml
```

## Create L4 Load Balancer with Source IP Preservation

Execute the following operations on the master node backend.

### Step 1: Remove kube-proxy and Clean Up Rules

1. Get the current kube-proxy image:

```bash
kubectl get -n kube-system kube-proxy -oyaml | grep image
```

2. Backup and delete the kube-proxy DaemonSet:

```bash
kubectl -n kube-system get ds kube-proxy -oyaml > kube-proxy-backup.yaml

kubectl -n kube-system delete ds kube-proxy
```

3. Create a BroadcastJob to clean up kube-proxy rules:

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
        image: registry.alauda.cn:60070/tkestack/kube-proxy:v1.33.5      ## Replace with the kube-proxy image from Step 1
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

Save as `kube-proxy-cleanup.yaml` and apply:

```bash
kubectl apply -f kube-proxy-cleanup.yaml
```

The BroadcastJob is configured with `ttlSecondsAfterFinished: 300` and will be automatically cleaned up within 5 minutes after completion.

### Step 2: Create Address Pool

> **VIP Address Requirement**: Cilium L2 Announcement implements IP failover through ARP broadcasting. Therefore, the VIP must be in the **same Layer 2 network** as the cluster nodes to ensure ARP requests can be properly broadcast and responded to.

Save as `lb-resources.yaml`:

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancerIPPool
metadata:
  name: lb-pool
spec:
  blocks:
    - cidr: "192.168.132.192/32"    # Replace with the actual VIP segment
---
apiVersion: cilium.io/v2alpha1
kind: CiliumL2AnnouncementPolicy
metadata:
  name: l2-policy
spec:
  interfaces:
    - eth0                          # Replace with the actual network interface name
  externalIPs: true
  loadBalancerIPs: true
```

Apply the configuration:

```bash
kubectl apply -f lb-resources.yaml
```

### Step 3: Verification

Create a LoadBalancer Service to verify IP allocation and test connectivity.

**Verification 1: Check if LB Service has been assigned an IP**

```bash
kubectl get svc -A
```

Expected output example:

```text
NAMESPACE      NAME                      TYPE           CLUSTER-IP     EXTERNAL-IP       PORT(S)                     AGE
cilium-123-1   test                      LoadBalancer   10.4.98.81     192.168.132.192   80:31447/TCP                35s
```

**Verification 2: Check the leader node sending ARP requests**

```bash
kubectl get leases -A | grep cilium
```

Expected output example:

```text
cpaas-system      cilium-l2announce-cilium-123-1-test       192.168.141.196                                                                 24s
```

**Verification 3: Test external access**

From an external client, access the LoadBalancer Service. Capturing packets inside the Pod should show the source IP as the client's IP, indicating successful source IP preservation.

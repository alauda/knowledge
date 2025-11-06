---
products:
  - Alauda Container Platform
kind:
  - Solution
id: KB1762167636-4744
sourceSHA: 879ea27bf4e7e9fc00e49cb71251ca2f84305986bf39b7343821ae81e25e9252
---

# 业务集群清单

:::info
本文档提供了用于配置高可用业务集群的示例 YAML 清单。应用这些清单以声明性地创建集群。

为了简化维护，将以下清单打包为 Helm Chart 或使用 Kustomize 管理。

示例集群配置：

- Kube-OVN 覆盖网络
- IPv4
- keepalived VIP 用于高可用性
- 相同的 SSH 密钥用于节点访问
  :::

:::warning
通过手动应用以下清单创建的集群不支持升级。
:::

## 在 global 集群中修改和创建集群 YAML

```yaml
apiVersion: v1
data:
  registryPassword: "{{ registry.password }}"   # base64 编码
  registryUsername: "{{ registry.user_name }}"  # base64 编码
kind: Secret
metadata:
  labels:
    cluster.x-k8s.io/cluster-name: "{{ name }}"
    cpaas.io/cluster-credential: ""
  name: {{ name }}-credential  # {{ name }} 是集群名称
  namespace: cpaas-system
type: Opaque
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  annotations:
    capi.cpaas.io/tke-platform-cluster: ""
    cpaas.io/display-name: "{{ cluster.display_name }}"
    cpaas.io/network-type: kube-ovn
    kube-ovn.cpaas.io/transmit-type: overlay
    kube-ovn.cpaas.io/join-cidr: {{ kube_ovn.join_cidr }}
  labels:
    capi.cpaas.io/alauda-cluster: baremetal
  name: "{{ name }}"
  namespace: cpaas-system
spec:
  controlPlaneRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: UserProvisionedCluster
    name: "{{ name }}"
    namespace: cpaas-system
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: UserProvisionedCluster
    name: "{{ name }}"
    namespace: cpaas-system
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: UserProvisionedMachinePool
metadata:
  labels:
    cluster.x-k8s.io/cluster-name: "{{ name }}"
  name: {{ name }}-pool-master
  namespace: cpaas-system
spec:
  clusterName: "{{ name }}"
  cri:
    type: containerd
    version: {{ containerd.version }}
  pool:
  - credentialRef:
      name: {{ name }}-credential-node
    ip: {{ node.ip }}
    port: {{ node.ssh_port }}
    taints:
    - key: node-role.kubernetes.io/control-plane
      effect: NoSchedule
  - credentialRef:
      name: {{ name }}-credential-node
    ip: {{ node.ip }}
    port: {{ node.ssh_port }}
    taints:
    - key: node-role.kubernetes.io/control-plane
      effect: NoSchedule
  - credentialRef:
      name: {{ name }}-credential-node
    ip: {{ node.ip }}
    port: {{ node.ssh_port }}
    taints:
    - key: node-role.kubernetes.io/control-plane
      effect: NoSchedule
  role: master
  version: {{ k8s_version }}
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: UserProvisionedMachinePool
metadata:
  labels:
    cluster.x-k8s.io/cluster-name: "{{ name }}"
  name: {{ name }}-pool-worker
  namespace: cpaas-system
spec:
  clusterName: "{{ name }}"
  cri:
    type: containerd
    version: {{ containerd.version }}
  pool:
  - credentialRef:
      name: {{ name }}-credential-node
    ip: {{ node.ip }}
    port: {{ node.ssh_port }}
  role: node
  version: {{ k8s_version }}
---
apiVersion: v1
data:
  password: ""
  privateKey: {{ ssh_key }}  # base64 编码
  username: {{ ssh_user }}   # base64 编码
kind: Secret
metadata:
  name: {{ name }}-credential-node
  namespace: cpaas-system
type: Opaque
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: UserProvisionedCluster
metadata:
  annotations:
    cpaas.io/registry-address: '{{ registry.address }}'
  labels:
    cluster.x-k8s.io/cluster-name: "{{ name }}"
  name: "{{ name }}"
  namespace: cpaas-system
spec:
  clusterCIDR:
    cidrBlocks:
    - {{ podCIDR }}
  serviceCIDR:
    cidrBlocks:
    - {{ serviceCIDR }}
  controlPlaneEndpoint:
    host: {{ load_balancer.domain }}
    port: 6443
  credentialRef:
    name: {{ name }}-credential
  dnsDomain: cluster.local
  etcd:
    local: {}
  ha:
    config:
      vip:  {{ load_balancer.domain }}
      vport: 6443
      vrid: 137
    type: internal
  # true: 使用主机名作为节点名称
  # false: 使用节点 IP 作为节点名称
  hostnameAsNodeName: {{ true or false }}  
  kubeProxy:
    ipvs: true
  machinePoolRef:
    name: {{ name }}-pool-master
  maxNodePodNum: {{ max_pod_num }}
  networkConfig:
    device: "{{ default_network_device }}"
    stack: Ipv4
  networkType: kube-ovn
  version: {{ k8s_version }}  # 例如: 1.32.7，与 global kubernetes 版本相同
```

## 添加工作节点

要添加工作节点，请修改名为 `{{ name }}-pool-worker` 的 `UserProvisionedMachinePool` 资源。(`{{ name }}` 是集群名称)

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: UserProvisionedMachinePool
metadata:
  annotations:
  labels:
    cluster.x-k8s.io/cluster-name: test-cluster
  name: test-cluster-pool-worker
  namespace: cpaas-system
spec:
  clusterName: test-cluster
  cri:
    type: containerd
    version: 1.7.27-4
  pool:
  - credentialRef:
      name: test-cluster-credential-node
    ip: 192.168.132.23
    port: 22
  - credentialRef:
      name: test-cluster-credential-node
    ip: 192.168.129.222
    port: 22
  role: node
  version: 1.32.7
```

## 集群插件

要安装集群插件，请在业务集群中创建或更新插件清单。
例如，要安装 MetalLB 插件：

```yaml
apiVersion: cluster.alauda.io/v1alpha1
kind: ClusterPluginInstance
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "2"
    cpaas.io/display-name: metallb
  labels:
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: metallb
spec:
  pluginName: metallb
```

要安装 VictoriaMetrics 插件：

```yaml
apiVersion: cluster.alauda.io/v1alpha1
kind: ClusterPluginInstance
metadata:
  annotations:
    cpaas.io/display-name: victoriametrics
  labels:
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: victoriametrics
spec:
  config:
    agentOnly: true
    agentReplicas: 1
    components:
      nodeExporter:
        port: 9100
      vmagent:
        scrapeInterval: 60
        scrapeTimeout: 45
    crossClusterDependency:
      victoriametrics: global
    replicas: 1
  pluginName: victoriametrics
```

## Operators

要使用 Operator Lifecycle Manager (OLM) 部署 operator，请在业务集群中创建 `Subscription` 资源。示例：

```yaml
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  annotations:
    cpaas.io/target-namespaces: ""
  labels:
    catalog: platform
    operators.coreos.com/redis-operator.redis-system: ""
  name: redis-operator
  namespace: redis-system
spec:
  channel: alpha
  installPlanApproval: Manual
  name: redis-operator
  source: platform
  sourceNamespace: cpaas-system
  startingCSV: redis-operator.v4.1.0-beta.16.g09dee005
```

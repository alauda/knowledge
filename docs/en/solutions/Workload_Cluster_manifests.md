---
products: 
  - Alauda Container Platform
kind:
  - Solution
---

# Workload Cluster Manifests

:::info
This document provides example YAML manifests for provisioning a highly available workload cluster. Apply these manifests to declaratively create the cluster.

To ease maintenance, package following manifests as a Helm chart or manage them with Kustomize.

Example cluster configuration:

- Kube-OVN overlay network
- IPv4
- keepalived VIP for HA
- identical SSH key for node access
:::

:::warning
Clusters created by manually applying the following manifests do not support upgrades.
:::

## Modify and create cluster YAML in the global cluster

```yaml
apiVersion: v1
data:
  registryPassword: "{{ registry.password }}"   # base64 encoded
  registryUsername: "{{ registry.user_name }}"  # base64 encoded
kind: Secret
metadata:
  labels:
    cluster.x-k8s.io/cluster-name: "{{ name }}"
    cpaas.io/cluster-credential: ""
  name: {{ name }}-credential  # {{ name }} is cluster name
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
  privateKey: {{ ssh_key }}  # base64 encoded
  username: {{ ssh_user }}   # base64 encoded
kind: Secret
metadata:
  name: {{ name }}-credential-node
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
  # true: use hostname as node name
  # false: use node ip as node name
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
  version: {{ k8s_version }}
```

## Add a worker node

To add a worker node, modify the `UserProvisionedMachinePool` resource named `{{ name }}-pool-worker`. ( `{{ name }}` is cluster name)

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

## Cluster plugins

To install a cluster plugin, create or update the plugin manifest in the workload cluster.
For example, to install the MetalLB plugin:

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

To install the VictoriaMetrics plugin:

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

To deploy an operator using the Operator Lifecycle Manager (OLM), create a `Subscription` resource in the workload cluster. Example:

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

---
id: KB250500024
products: 
   - Alauda Container Platform
kind:
   - Solution
---
# Alauda LoadBalancer with MetalLB

## Overview
MetalLB offers an implementation of network load balancer(LoadBalancer type of Service) for on-prem Kubernetes cluster. It provides an externally-accessible IP address that client can send traffic to the corresponding Pods on your cluster. The externally-accessible IP is announced through standard ARP/NAD requests or BGP protocol to achieve a fast fail over or high availability.
## Prerequisites

1. Kubernetes Cluster managed by ACP.
2. A range of IPv4 addresses available in L2 segment.
3. Traffic on port 7946 (TCP & UDP) must be allowed between nodes.
## Installation
Execute the following command to install the MetalLB plugin:

```bash
export KUBECONFIG="/etc/kubernetes/admin.conf"

# install MetalLB plugin
cat <<EOF | kubectl apply -f -
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
EOF

# wait for the MetalLB plugin to be ready

kubectl -n cpaas-system wait --for=condition=Health=true ars/metallb
```

## Chapter 1. Configuring address pools 
As a cluster administrator, you can add address pools to your cluster to control the IP addresses allocated to Service of type `LoadBalancer`.
### Step 1: Creating an IP address pool
Using the following command to create an IP address pool.

```bash
cat <<EOF | kubectl apply -f -
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: example
  namespace: metallb-system
spec:
  addresses:
  - 192.168.10.0/24
  - 192.168.9.1-192.168.9.5
  - fc00:f853:0ccd:e799::/124
  autoAssign: false
EOF
```

#### Fields description

- `spec.addresses`: A list of IP address ranges over which MetalLB has authority.You can list multiple ranges in a single pool, they will all share thesame settings. Each range can be either a CIDR prefix, or an explicitstart-end range of IPs.
- `spec.autoAssign`: AutoAssign flag used to prevent MetallB from automatic allocationfor a pool.

### Step 2. Creating an L2 advertisement

In order to advertise the IP coming from an `IPAddressPool`, an `L2Advertisement` instance must be associated to the `IPAddressPool`.Using the following command to create an `L2 advertisement`.

```bash
cat <<EOF | kubectl apply -f -
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: example
  namespace: metallb-system
spec:
  ipAddressPools:
  - example
  nodeSelectors:
  - matchLabels:
      kubernetes.io/hostname: NodeA
  interfaces:
  - eth3
EOF
```

#### Fields description

- `spec.ipAddressPools`: The list of IPAddressPools to advertise via this advertisement, selected by name.
- `spec.nodeSelectors`: NodeSelectors allows to limit the nodes to announce as next hops for the LoadBalancer IP. When empty, all the nodes having are announced as next hops.
- `spec.interfaces`: A list of interfaces to announce from. The LB IP will be announced only from these interfaces.If the field is not set, we advertise from all the interfaces on the host.
## Chapter 2. Configuring Service to use MetalLB

### Step 1: Creating a Service with a random IP

By default, address pools are configured to permit automatic assignment. MetalLB assigns an IP address from these address pools.

To accept any IP address from any pool that is configured for automatic assignment, no special annotation or configuration is required. The only thing you need to do is to set the type of Service to `LoadBalancer`.

```bash
apiVersion: v1
kind: Service
metadata:
  name: example
spec:
  ports:
    - port: 8080
      targetPort: 8080
      protocol: TCP
  type: LoadBalancer
```

### Step 2: Creating a Service with a specific IP

To assign an IP address to a Service with in the address pools, then you can use the `metallb.universe.tf/loadBalancerIPs` annotation.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx
  annotations:
    metallb.universe.tf/loadBalancerIPs: 192.168.1.100
spec:
  ports:
  - port: 80
    targetPort: 80
  selector:
    app: nginx
  type: LoadBalancer
```

### Step 3: Creating a Service with a specific pool

To assign an IP address from a specific address pool, but you are not concerned with the specific IP address, then you can use the `metallb.universe.tf/address-pool` annotation.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx
  annotations:
    metallb.universe.tf/address-pool: example
spec:
  ports:
  - port: 80
    targetPort: 80
  selector:
    app: nginx
  type: LoadBalancer
```

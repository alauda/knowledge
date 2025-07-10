---
id: KB250500026
products: 
   - Alauda Container Platform
kind:
   - Solution
---
# Alauda Container Platform Egress Gateway Installation and Usage Guide

## Overview

Alauda Container Platform(ACP) offers an **Egress Gateway** feature, designed to provide your applications with a **dedicated, external public IP address** for outbound traffic. This capability centralizes and controls how your applications initiate connections to external networks, allowing for precise management of egress policies. Instead of your application Pods using a dynamic, internal IP for external communication, the Egress Gateway ensures all their outbound traffic originates from a stable, publicly routable IP. This greatly simplifies network security configurations and external integrations.

This document describes how to deploy and use an egress gateway on ACP.

## Prerequisites

1. Alauda Container Platform installed.
2. Kubernetes Cluster managed by ACP.
3. Public IP availability and reachability
4. Some configurations to be set:
    * For OpenStack VM environments, you need to turn off PortSecurity on the corresponding network port.
    * For VMware vSwitch networks, MAC Address Changes, Forged Transmits and Promiscuous Mode Operation should be set to allow.
    * For Hyper-V virtualization, MAC Address Spoofing should be enabled in VM nic advanced features.
    * Public clouds, such as AWS, GCE, AliCloud, etc., do not support user-defined Mac. In this scenario, it is recommended to use the VPC-CNI provided by the corresponding public cloud vendor.

## Installation Steps

> NOTICE: All the commands mentioned in this document MUST be executed in a master node of the cluster where you want to create an egress gateway.

### Installing Multus CNI

Execute the following command to install Multus CNI plugin:

```shell
# optional environment variable
export KUBECONFIG="/etc/kubernetes/admin.conf"

# install Multus CNI plugin
cat <<EOF | kubectl apply -f -
apiVersion: cluster.alauda.io/v1alpha1
kind: ClusterPluginInstance
metadata:
  annotations:
    cpaas.io/display-name: multus
  labels:
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: multus
spec:
  pluginName: multus
EOF

# wait for ars to be created
while true; do
  if kubectl -n cpaas-system get ars -o name | grep -w multus >/dev/null; then
    break
  fi
  echo "Waiting for ars/multus to be created..."
  sleep 3
done

# wait for the Multus CNI plugin to be ready
kubectl -n cpaas-system wait --for=condition=Health=true ars/multus
```

### Creating Network Attachment Definition

Create a *NetworkAttachmentDefinition* resource using the following command:

```shell
# optional environment variable
export KUBECONFIG="/etc/kubernetes/admin.conf"

# this variable value MUST be name of an network interface that connects to the external physical network
NIC="eth0"

# install Multus CNI plugin
cat <<EOF | kubectl apply -f -
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: macvlan
  namespace: kube-system
spec:
  config: '{
      "cniVersion": "0.3.0",
      "type": "macvlan",
      "master": "${NIC}",
      "mode": "bridge",
      "ipam": {
        "type": "kube-ovn",
        "server_socket": "/run/openvswitch/kube-ovn-daemon.sock",
        "provider": "macvlan.kube-system"
      }
    }'
EOF
```

### Enabling BFD Port on the default VPC

Execute the following command to enable BFD Port on the default VPC:

```shell
# optional environment variable
export KUBECONFIG="/etc/kubernetes/admin.conf"

# internal IP address used for to communicate with the egress gateway instances
# change this value if you want to use another IP address
BFD_IP="10.255.255.255"

# enable BFD port for the default VPC
cat <<EOF | kubectl apply -f -
apiVersion: kubeovn.io/v1
kind: Vpc
metadata:
  name: ovn-cluster
spec:
  bfdPort:
    enabled: true
    ip: "${BFD_IP}"
    nodeSelector:
      matchLabels:
        node-role.kubernetes.io/control-plane: ""
EOF
```

### Creating MACVlan Subnet

Execute the following command to create a MACVlan subnet:

```shell
# optional environment variable
export KUBECONFIG="/etc/kubernetes/admin.conf"

# external subnet CIDR
CIDR="10.226.82.0/24"
# external subnet gateway
GATEWAY="10.226.82.254"

# create the subnet
cat <<EOF | kubectl apply -f -
apiVersion: kubeovn.io/v1
kind: Subnet
metadata:
  name: macvlan
spec:
  protocol: IPv4
  provider: macvlan.kube-system
  cidrBlock: "${CIDR}"
  gateway: "${GATEWAY}"
EOF
```

## Using Egress Gateway

Execute the following command to create an egress gateway bound to an namespace:

```shell
# optional environment variable
export KUBECONFIG="/etc/kubernetes/admin.conf"

# namespace to which the egress gateway is bound to
NAMESPACE="ha-cluster-ns"
# name, namespace and replicas of the egress gateway instance
GW_NAME="egress-gateway"
GW_NAMESPACE="kube-system"
REPLICAS=3
# comma separated egress IPs
EGRESS_IPS="10.226.82.241,10.226.82.242,10.226.82.243"
# traffic policy: "Clutser" or "Local"
# if set to "Local", traffic will be routed to the gateway pod/instance on the same node when available
TRAFFIC_POLICY="Local"

# create egress gateway
cat <<EOF | kubectl apply -f -
apiVersion: kubeovn.io/v1
kind: VpcEgressGateway
metadata:
  name: ${GW_NAME}
  namespace: ${GW_NAMESPACE}
spec:
  replicas: ${REPLICAS}
  externalSubnet: macvlan
  externalIPs:
$(for ip in $(echo ${EGRESS_IPS} | sed 's/,/ /g'); do echo "  - $ip"; done)
  selectors:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ${NAMESPACE}
  nodeSelector:
    - matchExpressions:
      - key: node-role.kubernetes.io/control-plane
        operator: DoesNotExist
  trafficPolicy: Local
  bfd:
    enabled: true
    minRX: 100
    minTX: 100
    multiplier: 5
EOF

# wait for the egress gateway to be ready
kubectl -n ${GW_NAMESPACE} wait --for=condition=Ready=true veg/${GW_NAME}
```

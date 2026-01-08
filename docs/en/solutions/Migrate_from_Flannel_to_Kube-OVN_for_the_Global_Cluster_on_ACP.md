---
kind:
  - Solution
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0
id: KB260100005
---

# Migrate Flannel to Kube-OVN for the Global Cluster on ACP

## Issue

In Alauda Container Platform(ACP), Flannel is removed since v4.0.6. For global clusters where Flannel is running as the CNI plugin, there is a need to migrate Flannel to another CNI plugin, e.g. Kube-OVN.

This document describes how to migrate Flannel to Kube-OVN for the global cluster on ACP.

## Environment

1. The ACP global cluster using Flannel as the CNI plugin.

## Resolution

:::warning
During the migration, node reboots are required and the container network will be interrupted, which will cause a series of expected failures in the Global cluster, including but not limited to the platform management console being inaccessible. Please plan the operation window in advance.
:::

### Preparation

Compared to Flannel, Kube-OVN will automatically create a subnet named `join` to connect the host network and the container network. Before performing the migration, please plan the CIDR for the `join` subnet in advance.

### Steps

On the master node of the Global cluster, execute the following script. Make sure to modify the value of `JOIN_SUBNET` to the desired CIDR for the `join` subnet:

```bash
#!/bin/bash

set -ex

# CIDR of the join subnet
JOIN_SUBNET=100.64.0.0/16

# Add label to master nodes
kubectl label --overwrite node -l node-role.kubernetes.io/control-plane kube-ovn/role=master

# Update cluster information
kubectl label --overwrite cls global cni-type=kube-ovn
kubectl annotate --overwrite cls global kube-ovn.cpaas.io/join-cidr=${JOIN_SUBNET} kube-ovn.cpaas.io/transmit-type=overlay
kubectl patch -n cpaas-system upcluster global --type=merge -p '{"spec":{"networkType":"kube-ovn"}}'

# Wait for kube-ovn to be installed
while true; do
  echo "Waiting for minfo to be created..."
  if [ $(kubectl get minfo -l cpaas.io/cluster-name=global,cpaas.io/module-name=kube-ovn -o name | wc -l) -eq 1 ]; then
    break
  fi
  sleep 5
done

while true; do
  echo "Waiting for ars to be created..."
  name=$(kubectl -n cpaas-system get ars cni-kube-ovn --ignore-not-found -o name)
  if [ "$name" != "" ]; then
    break
  fi
  sleep 5
done

# Wait for kube-ovn to be ready
kubectl -n cpaas-system wait ars cni-kube-ovn --for condition=Health --timeout=900s

# Delete flannel
kubectl delete --ignore-not-found minfo -l cpaas.io/cluster-name=global,cpaas.io/module-name=cni
kubectl delete --ignore-not-found -n cpaas-system ars cni-flannel
```

On **ALL** nodes of the Global cluster, execute the following command to clean up Flannel-related files:

```bash
# Remove CNI config and binary
rm -fv /etc/cni/net.d/10-flannel.conflist /opt/cni/bin/flannel
```

According to the relevant specifications, reboot all nodes in the Global cluster.

On the master node of the Global cluster, execute the following command to clean up node annotations:

```bash
# Remove annotations
kubectl get node -o name | while read node; do
  kubectl annotate --overwrite $node \
    flannel.alpha.coreos.com/backend-data- \
    flannel.alpha.coreos.com/backend-type- \
    flannel.alpha.coreos.com/kube-subnet-manager- \
    flannel.alpha.coreos.com/public-ip-
done
```

Wait for the cluster components to recover and verify that the Global cluster functions are working properly.

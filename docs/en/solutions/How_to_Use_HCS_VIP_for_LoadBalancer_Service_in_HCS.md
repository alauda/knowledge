---
id: KB250500031
products:
  - Alauda Container Platform
kind:
  - Solution
---

# How to use VM VIPs for a LoadBalancer Service in an HCS environment

## Overview

In an HCS environment, the Huawei VM layer pre-creates VIPs (virtual IP addresses) for external access. However, Kubernetes `LoadBalancer` Services cannot use these VIPs directly by default. To make these Huawei-assigned VIPs available to workloads in the cluster, you need to create an external IP pool.

This document describes an ACP 4.2 solution: after VIPs are created on the HCS VM layer, create an address pool by using the platform-provided **External IP Pools** capability, assign these VIPs to a `LoadBalancer` Service, and let kube-proxy IPVS generate forwarding rules on each node so that external traffic sent to the VIP can be forwarded to the backend Pods.

## Applicable version

- ACP 4.2

## Architecture

The HCS VM layer is responsible for external VIP routing. ACP `External IP Pools` manages allocatable external IP resources. MetalLB allocates VIPs to Services, and kube-proxy IPVS creates virtual server rules on each node to forward traffic to backend Pods. This solution uses MetalLB only for VIP management and allocation, and does not use its BGP advertisement capability.

```text
External client
     ↓ Access VIP
HCS VM layer network (routes external VIP traffic)
     ↓ Traffic reaches cluster nodes
┌─────────────────────────────────────────────────────────────┐
│                     HCS cluster                             │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Node 1     │    │   Node 2     │    │   Node 3     │  │
│  │  kube-proxy  │    │  kube-proxy  │    │  kube-proxy  │  │
│  │ (IPVS rules) │    │ (IPVS rules) │    │ (IPVS rules) │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         ↓                  ↓                  ↓             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │           Service (LoadBalancer)                       │ │
│  │        ExternalIP (VIP): 10.0.0.100                    │ │
│  └────────────────────────────────────────────────────────┘ │
│         ↓                  ↓                  ↓             │
│      Pod A              Pod B              Pod C           │
└─────────────────────────────────────────────────────────────┘
```

**Traffic flow:**
1. An external client accesses the VIP, and the HCS VM layer routes the traffic to cluster nodes.
2. kube-proxy (IPVS) recognizes the Service that owns the VIP and forwards the traffic to backend Pods.

## Prerequisites

1. The HCS VM layer has allocated and configured an available VIP range for the cluster.
2. The VIPs are reachable from external clients on the HCS network side.
3. The `metallb` cluster plugin is already deployed.
4. The VIP address pool has been confirmed with the network team and does not overlap with the cluster internal CIDR.

## Procedure

### Step 1: Configure kube-proxy to use IPVS mode

> This step is required. IPVS mode is a hard requirement for this solution.

1. Edit the kube-proxy ConfigMap:

```bash
kubectl edit configmap kube-proxy -n kube-system
```

```yaml
mode: "ipvs"
```

2. Restart kube-proxy for the change to take effect:

```bash
kubectl rollout restart daemonset/kube-proxy -n kube-system
```

3. Confirm that kube-proxy has switched to IPVS mode:

```bash
kubectl get configmap kube-proxy -n kube-system -o yaml | grep mode
```

The output should show `mode: ipvs`.

### Step 2: Create an address pool

In the ACP console, go to the target cluster and open `Networking` -> `External IP Pools`. Create an external address pool for `LoadBalancer` Services.

Huawei has already provided the available VIP range. When creating the address pool, you only need to fill in these key fields:

1. `Name`: Enter the address pool name.
2. `IP Resources` -> `IP Address`: Enter the VIP range assigned by Huawei.

When you create the `LoadBalancer` Service later, the address pool name in the annotation must match the `Name` used here.

The platform address pool is used only to manage and allocate VIPs. External VIP routing is still handled by the HCS VM layer, so you do not need to create an extra `BGP Peer`, and this solution does not depend on MetalLB BGP advertisement.

### Step 3: Create a LoadBalancer Service

Create a `LoadBalancer` Service so that it uses a VIP from the platform-managed address pool. kube-proxy then creates the corresponding IPVS rules on each node.

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: my-app-lb
  annotations:
    metallb.universe.tf/address-pool: <pool-name>
spec:
  type: LoadBalancer
  selector:
    app: my-app
  ports:
    - name: http
      port: 80
      targetPort: 8080
EOF
```

## Verification

After the `LoadBalancer` Service is created, confirm that the assigned VIP is reachable.

```bash
# Check the external address of the Service
kubectl get svc my-app-lb

# First, access VIP:Port from a cluster node
curl http://<VIP_ADDRESS>:80
```

Then access the same `VIP:Port` from outside the cluster and confirm that external traffic can also reach the service.

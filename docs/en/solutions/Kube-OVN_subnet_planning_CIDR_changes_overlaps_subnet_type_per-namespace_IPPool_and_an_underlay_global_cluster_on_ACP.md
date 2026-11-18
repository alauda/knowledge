---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.2"
  - "4.3"
---

# Kube-OVN subnet planning: CIDR changes, overlaps, subnet type, per-namespace IPPool and an underlay global cluster on ACP

## Issue

Planning questions and errors around Kube-OVN subnets:

- The Service address pool is used up and no Service can be created, or someone wants to change the Pod, Service or join CIDR of a running cluster, or move a cluster from Calico to Kube-OVN, and asks whether a redeploy is needed. The join CIDR given at global cluster deployment was wrong.
- Creating a new subnet fails with a CIDR conflict.
- Overlay subnets were carved from the same block as an underlay subnet, and the question is whether that is safe.
- How to tell underlay subnets from overlay subnets in `kubectl get subnet`, and why the used-IP list of an underlay subnet is not sorted.
- A checklist inspection says the join address shown for the cluster in the console does not match the join address used in the backend.
- Someone wants to give one IP range of a subnet to project A and another range to project B.
- Someone asks whether the global cluster can be deployed with Kube-OVN underlay instead of overlay.
- Someone wants a `kubectl` command that prints the cluster's subnet CIDRs.

Related articles: "Kube-OVN subnet stuck Terminating or Pods use the wrong subnet: finalizers, namespace binding or uppercase IPv6 on ACP".

## Root Cause

### Cause 1: there is no supported procedure to change the Pod, Service or join CIDR after deployment

There is no ready-made, supported procedure to change the Pod subnet, the Service subnet or the join subnet of a deployed cluster (confirmed for ACP 4.3.1 global and business clusters). A change on a running cluster needs a case-by-case evaluation by the vendor's R&D, or the cluster is redeployed with the new ranges. A wrong global join CIDR on ACP 4.2.0 was handled by redeploying. There is likewise no verified method to enlarge or add a Service CIDR. For a Calico-to-Kube-OVN move, "How to Migrate CNI from Calico to Kube-OVN on ACP" covers ACP 3.18 business clusters only, not the global cluster. An overlay range causes no problem as long as it does not conflict with the production network or with the cluster CIDRs.

### Cause 2: a new subnet's CIDR overlaps the join subnet

A new subnet must avoid the CIDRs of all existing subnets, including `join`, which is easy to forget because no workload uses it directly. A CIDR inside the `join` range is rejected with a conflict error.

### Cause 3: overlay subnets taken from the same block as an underlay subnet

Splitting one block into disjoint pieces (for example two `/24` blocks for the default and `join` overlay subnets and the remaining `/23` as an underlay subnet) does not by itself break the cluster, because the ranges do not overlap. The general recommendation still stands: keep overlay ranges out of physical-network address space, because an overlapping or misconfigured subnet can confuse routing, for example by sending traffic meant for Pods to physical nodes.

### Cause 4: an underlay subnet is the one with a VLAN

A subnet that references a `vlan` is an underlay subnet; a subnet without one is an overlay subnet. The console lists the used addresses of an underlay subnet in no particular order; that is the current design.

### Cause 5: the checklist join CIDR mismatch comes from the cluster's kube-ovn.cpaas.io/join-cidr annotation

The console reads the join CIDR from the annotation `kube-ovn.cpaas.io/join-cidr` on the `Cluster` resource (`kubectl get cls <cluster-name>`, `platform.tkestack.io/v1`, next to `cpaas.io/network-type: kube-ovn` and `kube-ovn.cpaas.io/transmit-type: overlay`). When that annotation does not hold the join CIDR the cluster really uses, the checklist reports a mismatch.

### Cause 6: a subnet cannot be divided between projects; an IPPool binds ranges to namespaces

The platform does not support dividing one subnet between projects. The Kube-OVN `IPPool` (`kubeovn.io/v1`) binds ranges to namespaces instead:

- `spec.subnet` names the owning subnet; `spec.ips` accepts `<IP>`, `<CIDR>` and `<IP1>..<IP2>`, IPv4 and IPv6.
- `spec.namespaces` optionally binds namespaces; Pods in a bound namespace get addresses only from the bound pool. Several pools can be bound to one namespace.
- Pools in one subnet must not overlap. Random allocation from the subnet excludes all pool ranges. `spec.ips` can be updated at any time and takes effect immediately.

### Cause 7: the global cluster cannot be deployed with Kube-OVN underlay

The global cluster deployment page of the installer (port `8080`) offers only the Kube-OVN overlay configuration, and no parameter switches the global cluster to underlay at deployment time.

### Cause 8: subnet CIDRs can be read with kubectl

On Calico the CIDRs are in the Calico `IPPool` objects (`crd.projectcalico.org/v1`, `spec.cidr`). On Kube-OVN, `kubectl get subnet` prints a CIDR column for every subnet together with provider, VPC, protocol, NAT, default, gateway type, used and available counts, and excluded IPs.

## Resolution

### Cause 1: there is no supported procedure to change the Pod, Service or join CIDR after deployment

Plan the Pod, Service and join ranges before deployment. For a running cluster, request an evaluation for that cluster or redeploy with the new ranges. For an exhausted Service CIDR, free addresses by deleting Services that are no longer used.

> **Warning:** Deleting a Service removes its ClusterIP and DNS name immediately. Confirm with the owner that it is unused (no endpoints is a hint, not proof) and export it first; re-creating it from the export restores the object, possibly with a different ClusterIP.

```bash
kubectl get svc -A --no-headers | wc -l
kubectl get endpoints -A | awk '$3=="<none>"'
kubectl -n <namespace> get svc <unused-service> -o yaml > /root/svc-<unused-service>.yaml
kubectl -n <namespace> delete svc <unused-service>
```

### Cause 2: a new subnet's CIDR overlaps the join subnet

List all subnet CIDRs, including `join`, and choose a range that overlaps none of them:

```bash
kubectl get subnet -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidrBlock,VLAN:.spec.vlan'
```

### Cause 3: overlay subnets taken from the same block as an underlay subnet

Check that no two subnets overlap and that no overlay range is used on the physical network; if so, no change is needed. For new plans, use ranges that are not routed on the physical network for overlay subnets.

### Cause 4: an underlay subnet is the one with a VLAN

```bash
kubectl get subnet -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidrBlock,VLAN:.spec.vlan,PROVIDER:.spec.provider'
kubectl get vlan
```

An empty VLAN column means overlay. To read the used addresses of a subnet in order:

```bash
kubectl get ip -o custom-columns='IP:.spec.ipAddress,SUBNET:.spec.subnet,POD:.spec.podName' | grep <subnet> | sort -t . -k 1,1n -k 2,2n -k 3,3n -k 4,4n
```

### Cause 5: the checklist join CIDR mismatch comes from the cluster's kube-ovn.cpaas.io/join-cidr annotation

Read the real join CIDR on the business cluster, compare it with the annotation on the global cluster, and set the annotation to the real value. Then rerun the checklist.

> **Warning:** The annotation is platform metadata; a wrong value misleads the console and the checklist. Record the current value; annotating it back is the rollback.

```bash
# on the business cluster
kubectl get subnet join -o jsonpath='{.spec.cidrBlock}{"\n"}'
# where the cluster resource lives
kubectl get cls <cluster-name> -o jsonpath='{.metadata.annotations.kube-ovn\.cpaas\.io/join-cidr}{"\n"}'
kubectl annotate cls <cluster-name> kube-ovn.cpaas.io/join-cidr=<actual-join-cidr> --overwrite
```

### Cause 6: a subnet cannot be divided between projects; an IPPool binds ranges to namespaces

Use one `IPPool` per namespace when a range must be reserved:

```yaml
apiVersion: kubeovn.io/v1
kind: IPPool
metadata:
  name: <pool-name>
spec:
  subnet: <subnet>
  ips:
    - 198.51.100.50..198.51.100.150
  namespaces:
    - <namespace>
```

Use your own addresses; pools in one subnet must not overlap.

### Cause 7: the global cluster cannot be deployed with Kube-OVN underlay

Deploy the global cluster with the overlay configuration the page offers.

### Cause 8: subnet CIDRs can be read with kubectl

```bash
# Calico cluster
kubectl get ippools.crd.projectcalico.org -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidr,BLOCK:.spec.blockSize,IPIP:.spec.ipipMode,VXLAN:.spec.vxlanMode'
# Kube-OVN cluster
kubectl get subnet
```

The fully qualified name avoids picking up Kube-OVN's own `ippools.kubeovn.io` on a cluster that has both CRDs.

## Diagnostic Steps

Start from the subnet list; it answers the type question, shows overlaps and shows bound namespaces:

```bash
kubectl get subnet -o wide
kubectl get subnet <subnet> -o yaml
kubectl get ippool
```

- A question about changing the Pod, Service or join range, or a full Service CIDR: Cause 1.
- A creation error naming a CIDR conflict: Cause 2. Disjoint ranges cut from one block: Cause 3.
- The VLAN column decides underlay or overlay: Cause 4.
- A checklist join-CIDR mismatch: Cause 5.
- A request to divide a subnet between projects: Cause 6. An underlay global cluster: Cause 7. A command for the CIDRs: Cause 8.

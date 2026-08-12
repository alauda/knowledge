---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Egress IP for Hosted Control Plane Tenant Clusters Running on ACP Virtualization
## Overview

A tenant cluster provisioned through Hosted Control Planes (HCP) runs its worker "nodes" as VMs inside an ACP Virtualization management cluster. Each tenant-cluster worker is therefore a `virt-launcher` pod at the management layer — and the tenant cluster's egress traffic has to cross two OVN-Kubernetes SDN layers to leave the physical network: the tenant cluster's own SDN, then the management cluster's SDN, then the host's physical NIC.

A common migration requirement is **static egress IP per application namespace**: traffic from a specific namespace in the tenant cluster should egress with a predictable IP the upstream firewall can allowlist. On a traditional hypervisor (vSphere, KVM bare metal), this is straightforward — the hypervisor can translate a namespace-level egress to a chosen physical IP. On HCP-on-Virtualization, the layering is more complex: the tenant's OVN-Kubernetes decides the namespace-level egress, then the management cluster's OVN-Kubernetes has to let that egress pass through a bridge to a bonded NIC that carries the chosen IP.

## Current support

The OVN-Kubernetes egress-IP feature has **platform-support constraints** documented at the release level. As of current supported builds, the feature is supported in two cases:

- The egress IP is carried on the **primary host network** (the node's normal pod-cluster egress path).
- The tenant cluster runs on a supported hypervisor platform list (check the platform's egress-IP platform-support matrix for the current version).

Running the tenant cluster as VMs on another ACP cluster (HCP-on-Virtualization) is a **stacked-cluster** topology. The feature's end-to-end correctness depends on both the management cluster's OVN and the tenant cluster's OVN cooperating over a shared secondary network, which requires extra plumbing that the feature's current implementation does not automatically set up.

This case is being tracked as a platform RFE; until the RFE lands, Egress IP is not the right tool for tenant-cluster namespace-level egress pinning.

## Workarounds until the feature supports HCP-on-Virtualization

Two patterns are available today. Pick based on the operational requirement.

### Option A — tenant-side egress routing via NodePort / external LB

If the application's egress target is an HTTP / API endpoint, route egress through a **management-cluster** LoadBalancer or external LB that you control. The tenant application calls a cluster-local service proxy (Envoy, Squid, Traefik, or a hand-rolled proxy) that lives in a management-cluster namespace you do own, and the proxy egresses from a specific management-cluster node whose physical NIC carries the allow-listed IP.

- Trade-off: egress is no longer transparent — tenant applications must configure their HTTP client to use the proxy.
- Benefit: the egress IP is a management-cluster artifact, so any stacked-cluster gymnastics happens in one place.

### Option B — network-level egress via a dedicated bridge on the management cluster

If the egress must be IP-transparent (the application has no proxy support), provision a dedicated secondary network on the management cluster that pins to a specific physical NIC / IP, and attach the tenant-cluster workers to that network as a secondary interface. Tenant traffic that should egress through the allowlisted path uses the secondary interface as the default route; other traffic uses the primary tenant SDN.

Requires, on the management cluster:

- A `NetworkAttachmentDefinition` referencing the chosen physical NIC via OVN's `localnet` or bridge topology.
- Coordination with the node configuration so the physical NIC is bonded / tagged / allowed to carry the egress traffic.

Requires, on the tenant cluster:

- A per-namespace routing policy that directs target traffic through the secondary interface.
- DNS / firewall coordination so the allowlist on upstream receivers sees the fixed IP.

Trade-off: this is a substantial network design change. Document the layers so the team that later debugs a routing issue understands that tenant traffic leaves through a management-layer NIC that is not obvious from the tenant's own routing tables.

### Option C — wait for the RFE-tracked feature

For teams that can tolerate the wait, Egress IP support for HCP-on-Virtualization is on the roadmap. Track platform release notes and re-evaluate the native feature when it becomes supported in the cluster's version.

## Why this is more involved than on a raw hypervisor

On a vSphere-hosted tenant:

1. The vSphere virtual switch sees the VM's traffic.
2. vSphere's NIOC / port-group configuration can pin the VM's egress to a specific uplink with a specific IP on the physical network.
3. No coordination required between tenant-cluster SDN and hypervisor SDN — vSphere handles the mapping.

On HCP-on-Virtualization:

1. The tenant SDN (OVN-Kubernetes inside the tenant cluster) decides which `EgressIP` applies.
2. The traffic lands on the virtual node (a `virt-launcher` pod's network), which is on the **management** cluster's pod network.
3. The management cluster's OVN-Kubernetes now has to honour the tenant's egress choice by forwarding the traffic through the right bridge to the right physical NIC.

That multi-layer coordination — letting a tenant-cluster configuration dictate management-cluster network behaviour — is the part the RFE adds. Doing it today requires the manual bridge configuration (Option B) or stepping outside the native feature entirely (Option A).

## Diagnostic Steps

Confirm the topology first. On the management cluster:

```bash
# List tenant clusters (HostedControlPlane objects).
kubectl get hostedcontrolplane -A -o \
  custom-columns='NAME:.metadata.name,NS:.metadata.namespace,PLATFORM:.spec.platform.type'
```

A `PLATFORM: KubeVirt` (or the equivalent platform enum for ACP Virtualization-hosted tenants) confirms the tenant's workers are VMs on this cluster.

Inspect a tenant-node's underlying `virt-launcher` pod to see the management-cluster network it is attached to:

```bash
# Pick a tenant node to inspect.
MGMT_NS=<tenant-hosted-ns>
VM=<tenant-node-vm-name>

kubectl -n "$MGMT_NS" get pod -l kubevirt.io/domain="$VM" \
  -o jsonpath='{.items[0].spec.containers[*].volumeMounts}{"\n"}{.items[0].metadata.annotations}{"\n"}'
```

The `k8s.v1.cni.cncf.io/networks` annotation lists every network attached to the VM. Egress IP via Option B adds another entry here.

From inside the tenant cluster, list any `EgressIP` objects the tenant's OVN-Kubernetes would honour if supported:

```bash
# Run inside the tenant cluster (use kubeconfig for the hosted cluster).
kubectl get egressip -o yaml
```

If `EgressIP` objects exist but tenant egress does not actually leave through the expected IP, that confirms the feature is being requested on a topology it does not yet fully support. The workarounds above are the way forward until native support lands.

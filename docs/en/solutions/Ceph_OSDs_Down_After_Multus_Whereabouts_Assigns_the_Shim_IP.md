---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Ceph OSDs Down After Multus Whereabouts Assigns the Shim IP
## Issue

A Ceph cluster wired onto a private Multus secondary network shows one or
more OSDs marked `down`. The OSD pods are healthy from a Kubernetes
standpoint (containers running, no crash loop) but they cannot reach the rest
of the Ceph cluster on the secondary network and `ceph osd tree` flags them
out. Looking at network state on the affected node and the OSD pod, two
different endpoints are advertising the same IP address: the per-node `shim`
interface that Multus injects to bridge primary and secondary CNI traffic,
and the OSD pod's secondary NIC.

## Root Cause

The Multus integration provisions a per-node `shim*` interface on the host
network namespace so packets can leave the secondary network back through the
primary CNI when needed. The shim takes one IP from the same range that the
Whereabouts IPAM is later asked to assign from. If the Whereabouts pool
configuration does not exclude the shim addresses, the IPAM is free to
allocate one of them to a pod NIC the next time an OSD is scheduled. The
result is two endpoints claiming the same address: ARP/NDP responses become
ambiguous, the OSD pod cannot reach peers reliably, and the cluster reports
the OSD as unreachable.

This affects the Ceph storage stack on ACP exposed under
`storage/storagesystem_ceph`, which uses the same Rook + Multus topology. The
fix is the same regardless of how the cluster was deployed: tell Whereabouts
to keep its hands off the shim IPs.

## Resolution

### Preferred: ACP Ceph Storage Surface

When the cluster is managed through ACP's `storage/storagesystem_ceph`
component, declare the secondary network and its address allocation through
the storage system configuration. The IPAM range and exclusion list belong on
the `NetworkAttachmentDefinition` that the storage system references; the
storage operator wires it into the Rook CephCluster spec automatically. Two
patterns are supported on the underlying NAD:

Option A — Exclude the shim addresses explicitly. Useful when the shim IPs
are scattered through the range and a single contiguous block is not
practical:

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: ceph-public
  namespace: ceph-storage
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "name": "ceph-public",
      "type": "macvlan",
      "master": "ens224",
      "mode": "bridge",
      "ipam": {
        "type": "whereabouts",
        "range": "192.168.0.0/24",
        "exclude": [
          "192.168.0.0/32",
          "192.168.0.1/32",
          "192.168.0.2/32",
          "192.168.0.3/32",
          "192.168.0.4/32"
        ],
        "routes": [{"dst": "192.168.0.0/24"}]
      }
    }
```

Option B — Reserve the lower portion of the range for shim addresses and let
Whereabouts allocate from a strictly higher band. This is the cleaner pattern
when adding nodes later, because the shim block is set aside up front:

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: ceph-public
  namespace: ceph-storage
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "name": "ceph-public",
      "type": "macvlan",
      "master": "ens224",
      "mode": "bridge",
      "ipam": {
        "type": "whereabouts",
        "range": "192.168.0.0/24",
        "range_start": "192.168.0.5",
        "range_end": "192.168.0.254",
        "routes": [{"dst": "192.168.0.0/24"}]
      }
    }
```

After updating the NAD, recycle the affected OSD pods so Whereabouts releases
their existing leases and reallocates from the corrected pool:

```bash
kubectl -n ceph-storage delete pod -l app=rook-ceph-osd,osd=<id>
```

Wait for `ceph -s` to report `HEALTH_OK` and the OSDs back as `up/in` before
draining additional pods.

## Diagnostic Steps

Enumerate the shim IPs currently in use on each node:

```bash
for node in $(kubectl get node -o name); do
  echo "=== $node"
  kubectl debug "$node" -it \
    --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
    -- chroot /host ip a | grep -E 'shim'
done
```

Pull the secondary-network IPs the OSD pods think they own. Replace
`ceph-public` with the NAD name configured for the storage system:

```bash
kubectl -n ceph-storage get pod -l app=rook-ceph-osd -o json \
  | jq -r '.items[]
            | .metadata.annotations["k8s.v1.cni.cncf.io/network-status"]
            | fromjson[]
            | select(.name == "ceph-storage/ceph-public")
            | .ips[]'
```

Cross-reference both lists. Any address that appears in both columns is the
collision; the OSD on that IP is the one Ceph reports as `down`. Also dump
the Whereabouts allocation state to confirm the fix landed:

```bash
kubectl -n kube-system get ippools.whereabouts.cni.cncf.io -o yaml
```

Once the NAD is corrected, the next OSD pod restart should pick an address
that is not in the shim list, and `ceph -s` should clear the OSD-down
warning within the next health-check cycle.

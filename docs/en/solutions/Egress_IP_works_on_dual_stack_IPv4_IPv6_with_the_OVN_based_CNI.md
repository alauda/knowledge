---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Egress IP works on dual-stack IPv4 + IPv6 with the OVN-based CNI
## Overview

The cluster's CNI lets a project / namespace pin its outbound traffic to one or more *egress IPs* — addresses that are used as the source IP for connections leaving the cluster, irrespective of the pod IP they originated from. The most-frequent question on dual-stack clusters is whether egress IP can pin **both** an IPv4 and an IPv6 source for the same namespace. The short answer is yes, on the OVN-based CNI; the longer answer is below.

## What works on dual-stack

The cluster's OVN-based CNI handles egress IP selection per address family. On a dual-stack node, the egress IP datapath maintains separate selection state for IPv4 and for IPv6:

- An egress IP CR (or the cluster's equivalent CRD) that lists an IPv4 address pins the namespace's IPv4 outbound traffic to that address.
- An egress IP CR that lists an IPv6 address pins the namespace's IPv6 outbound traffic to that address.
- A single CR that lists both an IPv4 and an IPv6 address pins each family to its corresponding address. There is no "favourite family"; both work in parallel.

Documentation examples typically show only IPv4 because that has been the prevalent deployment, but the configuration shape is the same — only the address family in the `egressIPs` list differs.

## Example shapes

The exact CRD name depends on the CNI flavour deployed in the cluster (`EgressIP`, vendor-prefixed equivalents). The two patterns below illustrate the two configurations users typically reach for.

### IPv4 + IPv6 in one CR

```yaml
apiVersion: <cni-group>/<v1>
kind: EgressIP
metadata:
  name: project-a-egress
spec:
  egressIPs:
    - 10.0.10.50            # IPv4 source
    - 2001:db8:1::1234       # IPv6 source
  namespaceSelector:
    matchLabels:
      egress.example.com/project-a: "true"
  podSelector: {}
```

The CNI assigns each address to a node that has the matching family on its egress-capable interface. Outbound IPv4 from any pod in a labelled namespace goes out as `10.0.10.50`; outbound IPv6 from the same pod goes out as `2001:db8:1::1234`.

### Two CRs (one per family)

If you prefer to keep IPv4 and IPv6 lifecycles separate (different teams own each address pool, different on-call rotations), split into two CRs targeting the same namespaces:

```yaml
apiVersion: <cni-group>/<v1>
kind: EgressIP
metadata:
  name: project-a-egress-v4
spec:
  egressIPs:
    - 10.0.10.50
  namespaceSelector:
    matchLabels:
      egress.example.com/project-a: "true"
---
apiVersion: <cni-group>/<v1>
kind: EgressIP
metadata:
  name: project-a-egress-v6
spec:
  egressIPs:
    - 2001:db8:1::1234
  namespaceSelector:
    matchLabels:
      egress.example.com/project-a: "true"
```

Both CRs watch the same namespace selector; the CNI applies them per family.

## What doesn't work

The legacy SDN-based CNI (the historical CNI shipped with some clusters before the OVN-based one became the default) only supports egress IP for IPv4, and does not support dual-stack at all. If you are still on the legacy SDN, IPv6 egress IP is not available; the path forward is to migrate the cluster's CNI to the OVN-based one.

If your cluster runs a fully different CNI (a vendor SDN that is not derived from OVN), check the vendor's documentation — egress IP semantics are CNI-specific, and the address-family rules above are specifically about the OVN-based datapath.

## FIPS-enabled clusters

There is no special interaction with FIPS. The egress IP datapath is implemented in the CNI and does not rely on cryptographic operations beyond what the rest of the cluster is doing. A FIPS-enabled dual-stack cluster supports IPv4 + IPv6 egress IP the same way a non-FIPS one does.

## Verifying the configuration on a running cluster

After applying the CR(s):

1. Confirm the addresses are bound to a node:

   ```bash
   kubectl get egressip -o yaml | yq '.items[] |
     {name: .metadata.name,
      ips:  .spec.egressIPs,
      bindings: .status.items}'
   ```

   Each address should show a `node` and an interface in `.status.items`. If the binding is empty, the CNI could not find a node whose egress-capable interface has the matching family in its allowed range.

2. From a pod in a labelled namespace, query an external endpoint that echoes back the source address:

   ```bash
   kubectl exec -n <ns> <pod> -- curl -s -4 https://ifconfig.example/
   kubectl exec -n <ns> <pod> -- curl -s -6 https://ifconfig.example/
   ```

   The returned addresses should match the two `egressIPs` values respectively.

3. If the IPv6 leg goes out as the pod's own IPv6 (not the egress IP), check that the egress-capable interface on the assigned node actually has IPv6 enabled and that the IPv6 egress IP falls inside the interface's allowed CIDR. The CNI silently leaves traffic on the default path when the egress IP cannot be programmed onto the kernel routing table.

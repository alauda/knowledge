---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A datacentre gateway (DCGW) router peered with MetalLB observes IPv6 `Service` prefixes advertised with an IPv4 next-hop equal to the worker node's IPv4 address. The expectation was an IPv6 next-hop sourced from the IPv6 BGP session. Removing IPv4 peers from `BGPAdvertisement` does not change the behaviour. The traffic still reaches the service because the IPv4 next-hop resolves on the same path, but the router operator wants strict address-family separation: IPv4 routes over the IPv4 session, IPv6 routes over the IPv6 session.

## Root Cause

Recent MetalLB releases have moved the BGP dataplane to FRR. By default, an FRR session enables BGP Multiprotocol Extensions (MP-BGP), which lets a single peering carry multiple Address Families (AFI/SAFI) — including the case where the IPv4 session also advertises IPv6 prefixes (and vice versa) using the next-hop of the underlying transport. The DCGW receives those IPv6 prefixes over the IPv4 session and prints the underlying IPv4 transport address as the resolved next-hop.

There is no traffic impact — the next-hop resolves and forwarding works — but the operational requirement of "v4 only on v4 sessions, v6 only on v6 sessions" is not met by the default configuration.

## Resolution

Disable Multiprotocol BGP on the affected neighbours so each session carries only its own Address Family. Patch the `FRRConfiguration` resource for the cluster to set `disableMP: true` on the relevant neighbour blocks:

```yaml
apiVersion: frrk8s.metallb.io/v1beta1
kind: FRRConfiguration
metadata:
  name: external-dcgw
  namespace: metallb-system
spec:
  bgp:
    routers:
      - asn: 64512
        neighbors:
          - address: 10.0.0.1
            asn: 65000
            disableMP: true
            toAdvertise:
              allowed:
                mode: filtered
                prefixes:
                  - 192.0.2.0/24
          - address: 2001:db8::1
            asn: 65000
            disableMP: true
            toAdvertise:
              allowed:
                mode: filtered
                prefixes:
                  - 2001:db8:1::/48
```

After applying, the router sees:

- IPv4 prefixes only on the session to `10.0.0.1`, with an IPv4 next-hop.
- IPv6 prefixes only on the session to `2001:db8::1`, with an IPv6 next-hop.

### Caveats

- `disableMP: true` is a per-neighbour setting; apply it on every neighbour where strict separation is required.
- If a single peering session is genuinely needed to carry both families (for example, on a constrained edge router that does not support a second BGP session), keep `disableMP: false` (the default) and accept the cross-family next-hop. There is no forwarding correctness issue.
- `BGPAdvertisement` only controls which prefixes are advertised; it does not change the transport family for a given session. The MP option is the right knob for that.

## Diagnostic Steps

1. Confirm the BGP sessions and their configured neighbours:

   ```bash
   kubectl get frrconfigurations -A -o yaml
   kubectl get bgpadvertisement -A -o yaml
   ```

2. Read the per-node FRR state to confirm which sessions are up and which AFIs they carry:

   ```bash
   kubectl get frrnodestates -n metallb-system -o yaml
   ```

3. From the speaker pod, dump the FRR `vtysh` view of the BGP table to confirm next-hop resolution before and after the change:

   ```bash
   kubectl exec -n metallb-system <speaker-pod> -- vtysh -c 'show bgp summary'
   kubectl exec -n metallb-system <speaker-pod> -- vtysh -c 'show bgp ipv6 unicast'
   ```

4. On the DCGW, inspect the received routes and confirm the next-hop is now IPv6 for IPv6 prefixes.

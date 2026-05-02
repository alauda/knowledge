---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# virt-handler crashes with "no IP found" after enabling a migration network
## Issue

After enabling a dedicated live-migration network on the KubeVirt operator (HyperConverged Cluster Operator, HCO) — typically by setting `spec.liveMigrationConfig.network` to a NetworkAttachmentDefinition — the `virt-handler` DaemonSet pods enter `CrashLoopBackOff`. The pod logs end with a panic from the handler's startup path:

```text
{"component":"virt-handler","level":"info","msg":"node-labeller is running",...}
{"component":"virt-handler","level":"info","msg":"VSOCK server is already stopped",...}
{"component":"virt-handler","level":"info","msg":"set verbosity to 2",...}
panic: no IP found on <interface>

goroutine 1 [running]:
main.(*virtHandlerApp).Run(...)
        /remote-source/app/cmd/virt-handler/virt-handler.go:338 +0x...
main.main()
        /remote-source/app/cmd/virt-handler/virt-handler.go:672 +0x...
```

VMs cannot live-migrate while virt-handler is down on the affected node. The handler's pod events show the migration-network attachment was annotated (`AddedInterface ... <attachment>`) — the interface exists, but virt-handler refuses to keep running because no usable IP is on it.

## Root Cause

virt-handler resolves the migration-network NIC at startup and demands a routable IP on it. Two configurations trip this panic:

1. The NetworkAttachmentDefinition for the migration network does not assign an IP at all — virt-handler sees an interface in `up` state with no `inet` address.
2. The NetworkAttachmentDefinition assigns a Link-Local address (RFC 3927, `169.254.0.0/16`). Link-Local is not routable across nodes; virt-handler treats it as "no IP found" because traffic to the peer node could never use that address as a source.

The IP that backs a live-migration network must be a Global Unicast address — typically RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) or any other routable space configured by the cluster's CNI. APIPA / Link-Local will not work even if the interface is attached.

## Resolution

The remediation is to remove the bad migration-network reference from the HyperConverged CR and let virt-handler fall back to the pod network — or, after fixing the NetworkAttachmentDefinition's IP allocation, leave the reference in place.

### Option A — Detach the migration network entirely

Edit the HyperConverged CR in the KubeVirt operator namespace and remove the migration-network field from `spec.liveMigrationConfig`:

```bash
KV_NS=<kubevirt-operator-namespace>           # the namespace HCO runs in
kubectl -n "$KV_NS" edit hyperconverged kubevirt-hyperconverged
```

Drop the line:

```yaml
spec:
  liveMigrationConfig:
    network: <migration-net-NAD>      # remove this
```

Then bounce the failing virt-handlers so they pick up the new spec:

```bash
kubectl -n "$KV_NS" delete pod -l kubevirt.io=virt-handler
```

The handler pods recreate; live-migration falls back to the cluster's default pod network.

### Option B — Fix the NetworkAttachmentDefinition IPAM

If isolating live-migration traffic on a dedicated NIC is required, fix the IPAM block in the NetworkAttachmentDefinition so each node ends up with a routable IP. For a static-host-local example:

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: live-migration-net
  namespace: <kubevirt-operator-namespace>
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "name": "live-migration-net",
      "type": "macvlan",
      "master": "ens5",
      "mode": "bridge",
      "ipam": {
        "type": "whereabouts",
        "range": "10.200.10.0/24"
      }
    }
```

Routable subnet (`10.200.10.0/24`), an IPAM plugin that actually assigns one address per pod (`whereabouts`, `host-local` with `node` ranges, or DHCP) — these are the requirements virt-handler expects. After applying, restart the handlers as in Option A.

### Verify

```bash
kubectl -n "$KV_NS" get pod -l kubevirt.io=virt-handler
kubectl -n "$KV_NS" logs -l kubevirt.io=virt-handler --tail=50 | grep -E 'panic|IP'
```

All handler pods should be `Running`; no `panic: no IP found` line in the recent logs.

## Diagnostic Steps

1. Identify which nodes are affected — virt-handler is per-node, so a failed pod points directly at a node:

   ```bash
   kubectl -n "$KV_NS" get pod -l kubevirt.io=virt-handler -o wide
   ```

2. Grab the panic line from the failing handler — the interface name in the log is the migration-network NIC inside the handler's network namespace:

   ```bash
   kubectl -n "$KV_NS" logs <virt-handler-pod> --previous | tail -30
   ```

3. Inspect the migration-network NetworkAttachmentDefinition's IPAM block — confirm the subnet is routable, not Link-Local:

   ```bash
   kubectl -n "$KV_NS" get net-attach-def <migration-net> -o jsonpath='{.spec.config}' | jq
   ```

4. From a working virt-launcher pod attached to the same migration network, confirm the address that the IPAM plugin actually allocated:

   ```bash
   kubectl exec -it <virt-launcher-pod> -- ip -4 addr show
   ```

   An address in `169.254.0.0/16` (or the absence of any `inet` entry) on the migration-network NIC is the smoking gun.

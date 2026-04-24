---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

An `NodeNetworkConfigurationPolicy` (NNCP) designed to add a VLAN with a static IP and DNS resolvers to a bond or base interface stalls on apply. A subset of nodes gets stuck with `ConfigurationProgressing` on the NNCP status; the nodes continue to serve their existing workloads but cannot reconcile any further network change. Closer inspection shows:

- The `nmstate-handler` pods on affected nodes log repeated `i/o timeout` errors against the cluster's API-server service IP (typically `172.30.0.1` or `10.96.0.1`, depending on install).
- On each affected node, the OVN-Kubernetes masquerade IP (typically `169.254.0.2/17`) is **missing** from the `br-ex` bridge interface.
- Other nodes with the same NNCP applied are fine — the break is not deterministic across the fleet.

Without the masquerade IP on `br-ex`, the node cannot SNAT traffic destined for cluster-internal service IPs, so calls from host-networked pods (including the `nmstate-handler` itself) to the API server fail. That is why the handler cannot complete the NNCP apply — its own operation depends on the connectivity it has just broken.

## Root Cause

The NNCP reconciler drives `nmstate`, which on certain versions has a bug in how it enforces **interface-level** DNS when a single policy requests both static IP and static DNS at once. The bug path:

1. The NNCP requests static DNS on the new VLAN interface.
2. `nmstate` interprets this as "this interface's DNS should be the active resolver set for the node".
3. To guarantee that, `nmstate` walks every NetworkManager connection on the node and purges DNS entries from any other interface.
4. The `br-ex` bridge, as installed by OVN-Kubernetes, carries a NetworkManager connection profile (`ovs-if-br-ex.nmconnection`) that holds residual DNS configuration from install time.
5. `nmstate`'s purge-and-rewrite of `br-ex` incidentally removes **unmanaged** attributes on that bridge — including the masquerade IP `169.254.0.2` that OVN-Kubernetes places there at boot.

The masquerade IP is what lets the node SNAT traffic aimed at ClusterIP service addresses (they would otherwise be unroutable from the node's network namespace). With it gone, `nmstate-handler` pods running as host-networked DaemonSet pods cannot reach `172.30.0.1:443` and the NNCP apply cycles forever.

The fix is in `nmstate` — recent versions use the **Global DNS** (D-Bus-backed) path instead of interface-level DNS when static IP and DNS are combined, which avoids the walk through other interfaces. Until the fix reaches the cluster, the workaround is to structure the NNCP so the bug does not trigger.

## Resolution

### Preferred — upgrade to a fixed `nmstate`

The fix landed in `nmstate` **2.2.56-1** and later. Upgrade the node OS (or the nmstate operator, if the cluster runs kubernetes-nmstate from an operator channel) through the platform's node-update surface. After the upgrade rolls out and the nodes have rebooted or the kubelet has restarted:

- Apply the original NNCP.
- The nodes reconcile cleanly.
- The `br-ex` masquerade IP is preserved.
- `nmstate-handler` keeps API-server connectivity and the policy reaches `Success`.

Verify:

```bash
# No nodes stuck in ConfigurationProgressing.
kubectl get nodenetworkconfigurationpolicy \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.conditions[-1].type'

# On each node, the masquerade IP is present on br-ex.
NODE=<node>
kubectl debug node/$NODE --image=busybox -- \
  chroot /host ip -4 addr show br-ex | grep -E '169\.254\.'
```

A line containing `169.254.0.2` confirms the bug did not trigger and the OVN masquerade is intact.

### Workaround — structure the NNCP to avoid the trigger

While the nmstate upgrade is pending, avoid combining static IP and static DNS in the **same** policy. Two options:

**Split the policy into two NNCPs.** One sets the static IP (and any static routes); the other sets DNS separately. The single-IP-only policy does not trigger the DNS-purge path, and the single-DNS-only policy does not have interface-level DNS to enforce.

```yaml
# Policy 1 — static IP + routes only, no DNS.
apiVersion: nmstate.io/v1
kind: NodeNetworkConfigurationPolicy
metadata:
  name: vlan-100-static-ip
spec:
  nodeSelector:
    kubernetes.io/hostname: <target-node>
  desiredState:
    interfaces:
      - name: bond0.100
        type: vlan
        state: up
        vlan:
          base-iface: bond0
          id: 100
        ipv4:
          enabled: true
          address:
            - ip:    10.0.100.10
              prefix-length: 24
    routes:
      config:
        - destination: 10.0.0.0/8
          next-hop-address: 10.0.100.1
          next-hop-interface: bond0.100
---
# Policy 2 — DNS only, applied as a separate reconciliation.
apiVersion: nmstate.io/v1
kind: NodeNetworkConfigurationPolicy
metadata:
  name: dns-config
spec:
  nodeSelector:
    kubernetes.io/hostname: <target-node>
  desiredState:
    dns-resolver:
      config:
        server:
          - 10.0.0.53
          - 10.0.0.54
        search:
          - example.internal
```

Apply Policy 1 first, wait for it to report `Available=True`, then apply Policy 2. The DNS-only policy takes the Global-DNS path even on older nmstate builds, leaving `br-ex` untouched.

**Remove the residual DNS from `br-ex` before re-running the original NNCP.** The bug only triggers when `br-ex` has a static DNS entry to purge. Clearing that entry pre-emptively lets the combined policy apply without damaging the masquerade IP:

```bash
NODE=<target-node>
kubectl debug node/$NODE --image=busybox -- \
  chroot /host nmcli connection modify ovs-if-br-ex ipv4.dns "" ipv6.dns ""
kubectl debug node/$NODE --image=busybox -- \
  chroot /host nmcli connection up ovs-if-br-ex
```

This must be done on every affected node before reapplying the NNCP. Document that it is a pre-upgrade mitigation so it is not left in place after the nmstate fix lands.

### Recover a node already stuck

If a node is already stuck with the masquerade IP missing, restore it manually before the `nmstate-handler` can make forward progress:

```bash
NODE=<stuck-node>
# Add the masquerade IP back to br-ex.
kubectl debug node/$NODE --image=busybox -- \
  chroot /host ip addr add 169.254.0.2/17 dev br-ex

# Kick the nmstate-handler on the node.
kubectl -n nmstate delete pod \
  -l component=kubernetes-nmstate-handler \
  --field-selector spec.nodeName="$NODE"
```

The freshly-scheduled handler pod now has API-server connectivity through the restored masquerade. Combine with the workaround above so the policy reapply does not break the masquerade again.

## Diagnostic Steps

Identify which nodes are stuck on the NNCP:

```bash
kubectl get nodenetworkconfigurationenactment \
  -o custom-columns='NNCE:.metadata.name,NODE:.status.nodeName,STATUS:.status.conditions[-1].type'
```

Any `STATUS=ConfigurationProgressing` rows are candidates. For each such node, inspect the `nmstate-handler` pod logs:

```bash
NODE=<stuck-node>
POD=$(kubectl -n nmstate get pod -l component=kubernetes-nmstate-handler \
        --field-selector spec.nodeName="$NODE" -o jsonpath='{.items[0].metadata.name}')
kubectl -n nmstate logs "$POD" --tail=500 | grep -E 'i/o timeout|172\.30|10\.96'
```

`i/o timeout` against the service-network IP confirms the node has lost API connectivity.

Verify the masquerade IP on `br-ex`:

```bash
kubectl debug node/$NODE --image=busybox -- \
  chroot /host ip -4 addr show br-ex
```

Missing `169.254.0.2/17` confirms the root cause of this note. Present and correct — the issue is something else (different nmstate bug, different NNCP interaction).

Check the `br-ex` NetworkManager connection for residual DNS that trips the bug:

```bash
kubectl debug node/$NODE --image=busybox -- \
  chroot /host nmcli connection show ovs-if-br-ex | grep -E 'ipv4.dns|ipv6.dns'
```

Non-empty DNS on `br-ex` plus an NNCP that requests static IP + static DNS on another interface is the exact signature the workaround clears.

After applying the fix or workaround, re-run the enactment listing. Nodes should move to `status: Available=True` within a reconcile cycle (typically a minute or two), and a connectivity probe from an `nmstate-handler` pod back to the API server should succeed immediately.

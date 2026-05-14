---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Reordering DNS Search Domains via NodeNetworkConfigurationPolicy
## Issue

Nodes and pods inherit a `search` entry in their `/etc/resolv.conf` that matches the node's FQDN domain (e.g. `node.example.com`). Every short-name DNS lookup inside a pod therefore triggers a probe against that domain before the "real" internal zone is tried. The environment actually uses FQDNs end-to-end, and the unsolicited lookups noticeably inflate DNS query volume against the node-domain resolver.

A tempting fix — deleting the node-domain search entry entirely — breaks in-cluster short-name resolution that core services depend on. A safer approach is to keep the node domain as a fallback but move it behind any site-specific search domains.

## Root Cause

On each node, the host network stack is managed by NetworkManager, which derives `/etc/resolv.conf` from the active connections and the node's hostname. When the node's hostname is an FQDN such as `host.node.example.com`, NetworkManager automatically adds the domain portion (`node.example.com`) to the `search` list. The platform's DNS plumbing (kubelet resolver, CoreDNS upstream injection, the CNI sidecar that copies upstream resolv into pods) then carries that same search list into every pod.

This default behaviour exists because many core components — kubelet pulling its own images, the API server contacting an OIDC endpoint over short name, maintenance scripts on the node — depend on being able to resolve peers inside the node-domain. Removing it would break those components during bring-up.

The knob that actually exists, and is safe to use, is the *order* of search entries, not whether the node-domain entry is present at all.

## Resolution

### Preferred path — manage node network with NMState through ACP

ACP ships NMState (the upstream `nmstate.io` operator) as the declarative node-network surface under Immutable Infrastructure. A `NodeNetworkConfigurationPolicy` (NNCP) applied to the cluster rewrites `/etc/resolv.conf` on each target node to the desired search order, persists across reboots, and reconciles if a node drifts.

Define the policy so the operator-preferred search domain comes first and the node-domain stays last as a safety net:

```yaml
apiVersion: nmstate.io/v1
kind: NodeNetworkConfigurationPolicy
metadata:
  name: dns-search-priority
spec:
  nodeSelector:
    kubernetes.io/os: linux
  desiredState:
    dns-resolver:
      config:
        search:
          - customer-domain.com   # priority — queried first
          - node.example.com      # kept as fallback so cluster-internal resolution still works
```

Apply it:

```bash
kubectl apply -f dns-search-priority.yaml
kubectl get nodenetworkconfigurationpolicy dns-search-priority \
  -o jsonpath='{.status.conditions}{"\n"}'
```

The policy reaches `Available: True` once every selected node has been reconfigured. Check one pod on a reconfigured node to confirm the new search list is visible end-to-end:

```bash
kubectl debug node/<node> -it --image=registry.alauda.cn:60070/tkestack/pause:3.10 \
  -- chroot /host cat /etc/resolv.conf

kubectl -n <some-ns> exec <some-pod> -- cat /etc/resolv.conf
```

Both views should list `customer-domain.com` before `node.example.com`.

### OSS fallback — raw NMState without ACP

Wherever NMState is installed as the upstream CNCF/`nmstate.io` operator without the ACP Immutable Infrastructure wrapper, the same NNCP CR applies unchanged — `nmstate.io/v1 NodeNetworkConfigurationPolicy` is the upstream API. The only additional step is ensuring the `nmstate-handler` DaemonSet is present on every node you intend to reconfigure; on ACP the handler is installed as part of Immutable Infrastructure.

### What not to do

- **Do not** remove the node-domain search entry entirely. Core platform components (kubelet, CoreDNS upstream, cluster add-ons) assume the node domain is resolvable via short name during bring-up. Removal recreates failures that are slow and painful to correlate.
- **Do not** hand-edit `/etc/resolv.conf` on the nodes. NetworkManager re-renders the file on every reconciliation, and NNCP-driven nodes will overwrite manual edits on the next sync.
- **Do not** apply a per-pod `dnsConfig.searches` override as a cluster-wide workaround. That field is per-Pod and does not compose with the cluster default without careful merging; it is the right tool for a single namespace or a single workload, not for a platform-wide DNS policy.

## Diagnostic Steps

1. Observe the current search order on a pod:

   ```bash
   kubectl -n <ns> exec <pod> -- cat /etc/resolv.conf
   ```

   The `search` line is a space-separated list; the leftmost entry is probed first, so the order matters.

2. Observe the current search order on a node:

   ```bash
   kubectl debug node/<node> -it --image=registry.alauda.cn:60070/tkestack/pause:3.10 \
     -- chroot /host cat /etc/resolv.conf
   ```

3. Verify the hostname shape on a node — this is what NetworkManager uses to derive the domain suffix:

   ```bash
   kubectl debug node/<node> -it --image=registry.alauda.cn:60070/tkestack/pause:3.10 \
     -- chroot /host hostnamectl status
   ```

   If the static hostname is set to a bare short name, the auto-injected search entry will not be the node-domain — revisit how the nodes are being provisioned before assuming NNCP is the fix.

4. Validate the policy state after applying the NNCP:

   ```bash
   kubectl get nodenetworkconfigurationenactment \
     -l nmstate.io/policy=dns-search-priority \
     -o custom-columns='NODE:.status.nodeName,STATUS:.status.conditions[?(@.type=="Available")].status'
   ```

   Every node enactment should report `Available: True`. A node stuck at `Progressing` or `Degraded` usually means the local NetworkManager refused the desired state — check the enactment message for the specific reason.

After the rollout, DNS query counts against the node-domain resolver drop to the genuine node-to-node traffic level, and application short-name lookups resolve against the priority domain first.

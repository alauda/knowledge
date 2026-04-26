---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

Cluster operators sometimes need additional host-level firewall rules on worker nodes — for example to deny outbound SMTP except from the postfix proxy, to rate-limit ingress on a specific NodePort, or to enforce zone-based policy that does not fit within `NetworkPolicy` (which is Pod-scoped and East-West-only). This article describes the supported pattern for layering custom `nftables` rules on a Kubernetes node without conflicting with the rules managed by the CNI (Kube-OVN), kube-proxy, or container runtime.

## Resolution

There are two conceptually distinct delivery mechanisms; pick one:

- **Persistent / boot-time rules** — apply the rules through node configuration so they survive reboot and image rebuild. ACP's recommended path for this is the `configure/clusters/nodes` workflow (or, for fleets that mandate immutable hosts, the Immutable Infrastructure product).
- **Runtime-only rules** — apply the rules at Pod startup through a privileged DaemonSet. Rules are lost on reboot but can be reconciled continuously.

### Pattern A — Persistent rules through node configuration

Author the rule set as a standalone nftables file. The cluster CNI (Kube-OVN) installs its own rules in the `nat` and `filter` tables; keep custom rules in a separate dedicated table to avoid colliding with CNI-owned chains:

```text
# /etc/nftables.d/glean-custom.nft
table inet glean_custom {
    chain output {
        type filter hook output priority filter; policy accept;
        # Block outbound TCP/25 (SMTP) except from the postfix-proxy IP.
        ip daddr 0.0.0.0/0 tcp dport 25 ip saddr != 10.20.30.40 reject
    }
    chain input {
        type filter hook input priority filter; policy accept;
        # Rate-limit ingress on NodePort 32000 to 100 conn/s.
        tcp dport 32000 ct state new limit rate 100/second accept
        tcp dport 32000 ct state new drop
    }
}
```

Place this file under the node configuration store the platform exposes (see ACP `configure/clusters/nodes`); the platform writes it to `/etc/nftables.d/glean-custom.nft` on every targeted node and ensures `nftables.service` reloads on change. Verify on a target node:

```bash
ssh root@<node> 'systemctl status nftables; nft list table inet glean_custom'
```

### Pattern B — Runtime DaemonSet

For experimental rule sets or short-lived overrides, deploy a privileged DaemonSet that runs `nft -f /opt/glean/glean-custom.nft` from an init container and a sidecar that re-applies on file change. This DaemonSet runs on the host network namespace and uses `hostPID` to invoke `nft` against the host's kernel:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: glean-nftables-overlay
  namespace: kube-system
spec:
  selector:
    matchLabels: { app: glean-nftables-overlay }
  template:
    metadata:
      labels: { app: glean-nftables-overlay }
    spec:
      hostNetwork: true
      hostPID: true
      tolerations:
        - operator: Exists
      initContainers:
        - name: install
          image: registry.alauda.cn:60070/acp/alb-nginx:v4.3.1
          securityContext: { privileged: true }
          command:
            - sh
            - -c
            - |
              cp /config/glean-custom.nft /host/etc/nftables.d/
              chroot /host nft -f /etc/nftables.d/glean-custom.nft
          volumeMounts:
            - { name: host-root, mountPath: /host }
            - { name: rules,     mountPath: /config }
      containers:
        - name: pause
          image: registry.alauda.cn:60070/acp/alb-nginx:v4.3.1
          command: ["sleep", "infinity"]
      volumes:
        - name: host-root
          hostPath: { path: / }
        - name: rules
          configMap: { name: glean-nftables-rules }
```

The corresponding `ConfigMap` carries the same `glean-custom.nft` body shown in Pattern A.

## Diagnostic Steps

After applying a rule set:

1. Confirm the table exists on the node:

   ```bash
   nft list tables
   nft list table inet glean_custom
   ```

2. Confirm the rule actually took effect with a counter chain. Add a `counter` to one of the rules to make hit-rate observable:

   ```text
   chain input {
       tcp dport 32000 ct state new counter limit rate 100/second accept
   }
   ```

   Then read it back:

   ```bash
   nft list chain inet glean_custom input | grep counter
   ```

3. If the rule does not take effect, look for a higher-priority hook installed by the CNI or kube-proxy that masks it. List every chain by hook + priority:

   ```bash
   nft list ruleset | grep -E 'hook|priority'
   ```

   Re-author the rule with a `priority` value lower (more negative) than the masking hook, or move the predicate higher up in the matching chain.

4. Never `nft flush ruleset` on a node — that drops kube-proxy and CNI rules and breaks Pod connectivity. Always work inside a custom table named uniquely (here `glean_custom`).

## Cleanup

For Pattern A: remove the file from the node-config store; the platform reconciles the deletion and `nftables.service` reloads without the table. For Pattern B: `kubectl delete daemonset glean-nftables-overlay -n kube-system` and then on each node `nft delete table inet glean_custom`.

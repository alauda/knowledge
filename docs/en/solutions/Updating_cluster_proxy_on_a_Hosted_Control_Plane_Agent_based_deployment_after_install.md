---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Updating cluster proxy on a Hosted Control Plane Agent-based deployment after install
## Overview

After an Agent-based Hosted Control Plane (HCP) cluster is up, the cluster-wide HTTP proxy can change for legitimate reasons: a new corporate egress endpoint, a TLS-inspection appliance, a re-IP'd outbound NAT. This is a day-2 change, so the goal is to update the running cluster's proxy configuration without re-bootstrapping the existing nodes, and to make sure newly added nodes pick up the new proxy when they join the cluster.

The configuration is split between two custom resources:

- `HostedCluster` carries the proxy used by the **already-joined nodes**. Editing it triggers a `MachineConfig` rollout across the existing `NodePool` so that the existing nodes converge on the new settings.
- `InfraEnv` carries the proxy used during the boot/discovery phase by **brand-new nodes** that have not yet been added to the cluster. Editing it has no effect on nodes that are already part of the cluster.

This article describes how to perform each update and what to expect during the rollout.

## Resolution

### Update the proxy used by existing nodes

Edit the `HostedCluster` resource in the management cluster's hosting namespace and update `spec.configuration.proxy`:

```bash
kubectl edit hostedcluster <name> -n <hosting-ns>
```

```yaml
spec:
  configuration:
    proxy:
      httpProxy: http://proxy.example.internal:3128
      httpsProxy: http://proxy.example.internal:3128
      noProxy: .svc,.cluster.local,10.0.0.0/8,172.16.0.0/12
```

Saving the resource causes the control plane to render a new `MachineConfig` for the affected `NodePool`. Nodes are drained and rebooted in the order dictated by the `NodePool`'s `management` strategy. Watch the rollout with:

```bash
kubectl get nodepool -n <hosting-ns> <pool> -o jsonpath='{.status}{"\n"}' | jq .
kubectl get nodes --kubeconfig=<guest-kubeconfig>
```

### Update the proxy used by future nodes

Newly discovered nodes that have not yet joined the cluster pick up the proxy from the `InfraEnv` resource. To change the proxy that bootstraps future nodes:

```bash
kubectl edit infraenv <name> -n <hosting-ns>
```

```yaml
spec:
  proxy:
    httpProxy: http://proxy.example.internal:3128
    httpsProxy: http://proxy.example.internal:3128
    noProxy: .svc,.cluster.local,10.0.0.0/8,172.16.0.0/12
```

Editing `InfraEnv` does **not** retroactively change the proxy on nodes that already joined the cluster — those are governed by `HostedCluster`. After the change, regenerate the discovery ISO if your workflow requires it; new agents booted from that ISO will use the new proxy values.

### When to update both

In the steady state both resources should agree, otherwise newly added nodes will diverge from the rest of the pool until their first reboot. The recommended sequence is:

1. Update `HostedCluster` first and let the existing nodes finish rolling.
2. Update `InfraEnv` so future agents bootstrap with the same proxy settings.

## Diagnostic Steps

1. Confirm that the change has been observed by the control plane:

   ```bash
   kubectl get hostedcluster <name> -n <hosting-ns> \
     -o jsonpath='{.status.conditions}' | jq .
   ```

   The `Progressing` condition should report the proxy update being rolled out.

2. Track per-node convergence by inspecting the node's `MachineConfig` annotations on the guest cluster:

   ```bash
   kubectl get node <node> --kubeconfig=<guest-kubeconfig> \
     -o jsonpath='{.metadata.annotations}' | jq .
   ```

3. Validate inside a node that the new proxy is in effect:

   ```bash
   kubectl debug node/<node> --kubeconfig=<guest-kubeconfig> -- \
     chroot /host /bin/sh -c 'cat /etc/profile.d/proxy.sh 2>/dev/null; env | grep -i proxy'
   ```

4. Verify outbound reachability from a freshly scheduled pod:

   ```bash
   kubectl run proxy-check --rm -i --restart=Never --image=curlimages/curl \
     -- curl -fsS -x http://proxy.example.internal:3128 https://example.com/
   ```

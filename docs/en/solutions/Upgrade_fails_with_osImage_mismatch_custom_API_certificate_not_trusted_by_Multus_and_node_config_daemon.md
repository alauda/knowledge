---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A control-plane node fails to roll forward during a cluster upgrade. The visible symptom is an `osImageURL` mismatch reported by the cluster's node-configuration controller — the rendered desired image differs from what the node is running, and the node cannot rebase.

The standard recovery (touching `/run/machine-config-daemon-force` to push a force-rebase) does not help: the node-config daemon container itself logs x509 trust errors before it can start work, and Multus on the node logs the same:

```text
W… reflector.go:539] failed to list *v1.Node: Get "https://api.<cluster>:6443/...":
   tls: failed to verify certificate: x509: certificate signed by unknown authority
```

Pods that need the node CNI to come up (the API server itself, the node-config daemon, supporting controller-manager pods) churn in `ContainerCreating` because Multus shim cannot reach the API server to fetch the NetworkAttachmentDefinition / pod metadata:

```text
Failed to create pod sandbox: rpc error: ...
plugin type="multus-shim" name="multus-cni-network" failed (add):
  CNI request failed with status 400: ... K8S_POD_NAMESPACE=...
```

The cluster still has its workloads up on the unaffected nodes; the broken node sits with `osImage` mismatch, `kubelet` healthy on the surface, and Multus / node-config daemon stuck.

## Root Cause

Some time before the upgrade, the cluster's API serving certificate was replaced with one signed by a custom CA (a custom serving cert for the API). The replacement updated the kube-apiserver's certificate as expected — but two on-disk artefacts on each node carry their **own** copies of the old trust bundle:

- The node-config daemon's per-node kubeconfig embeds a CA cert it uses to verify the API server.
- Multus's CNI kubeconfig, written by the multus DaemonSet under `/etc/kubernetes/cni/net.d/multus.d/multus.kubeconfig`, does the same — Multus's shim plugin uses it to talk to the API for sandbox setup.

When the API server certificate was replaced, the operators that own those two kubeconfigs were supposed to regenerate them to embed the new CA. If the operator that regenerates the Multus kubeconfig did not actually do so (it was unhealthy, was not running on the node, or its reconcile was suppressed), the node ends up with kubeconfig files that pin the **old** CA — and any TLS handshake to the new API server fails with `signed by unknown authority`.

Because Multus's kubeconfig is broken, no new pod can finish CNI setup on the node — that includes the apiserver pod, the node-config daemon container, and anything else the upgrade tries to bring up. The node-config daemon cannot complete its rebase because it cannot talk to the API server. The upgrade stalls with the visible osImage mismatch.

## Resolution

The fix is to regenerate the Multus kubeconfig (and any other on-disk kubeconfig that pins the old CA) so the node can re-establish trust with the new API certificate. The operators that own these files will rewrite them on their next reconcile, but only after the stale copy is removed; some need an explicit pod restart.

### 1. Move the stale Multus kubeconfig aside on the affected node

```bash
kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> -- chroot /host bash -c '
  test -f /etc/kubernetes/cni/net.d/multus.d/multus.kubeconfig && \
    mv /etc/kubernetes/cni/net.d/multus.d/multus.kubeconfig \
       /etc/kubernetes/cni/net.d/multus.d/multus.kubeconfig.bak
'
```

Renaming rather than deleting keeps a copy you can compare against the regenerated one.

### 2. Force the multus and network-operator pods to regenerate the kubeconfig

Delete the multus pod on this specific node, plus the cluster-level network-operator pod that orchestrates kubeconfig generation:

```bash
NODE=<node>
# Multus pod on this node — it rewrites multus.kubeconfig on start
kubectl delete pod -n <multus-namespace> -l app=multus \
  --field-selector spec.nodeName="${NODE}"
# Network operator — it reconciles the secrets the multus pod reads
kubectl delete pods -n <network-operator-namespace> -l name=network-operator
```

The multus daemonset re-spawns immediately; on its first liveness it writes a fresh `multus.kubeconfig` containing the new CA. From that point on, new pods on the node can complete CNI sandbox setup.

### 3. Recover node trust for kubelet and the node-config daemon

Restart kubelet so it re-reads its bootstrap kubeconfig (which the platform's cert controller has already refreshed on the node):

```bash
kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> -- chroot /host \
  systemctl restart kubelet
```

Watch the node-config daemon container — it will now successfully list `Node` objects and proceed with the rebase that was previously blocked.

### 4. Reboot the node to complete the upgrade

With Multus, kubelet, and the node-config daemon all able to reach the API server, the node-config daemon's force-rebase (or a clean reboot) drives the node to the desired image. Drain first, then reboot:

```bash
kubectl drain "${NODE}" --ignore-daemonsets --delete-emptydir-data
kubectl debug node/"${NODE}" -it --profile=sysadmin --image=<utility-image> -- chroot /host \
  reboot
```

After the node comes back, the `osImage` mismatch should clear and the upgrade can resume on the next node.

### Hardening — re-roll all nodes after a custom CA change

When the API server certificate is replaced with one from a custom CA, every node's on-disk kubeconfigs need to pick up the new bundle. The cleanest way to make sure no node falls into the trap above is to roll the multus and network-operator pods cluster-wide, then to do a controlled reboot of each node, soon after the certificate change — *before* the next upgrade kicks off. Catching one stale kubeconfig late, in the middle of an upgrade, is much more expensive than a deliberate reroll right after the cert-rotation procedure.

## Diagnostic Steps

1. Check the node-config daemon's logs and look specifically for `x509: certificate signed by unknown authority`. That phrase confirms the trust mismatch is the failure mode (vs. a generic API outage):

   ```bash
   kubectl logs -n <node-config-namespace> <node-config-daemon-pod> \
     | grep -E 'x509|certificate|reflector'
   ```

2. Compare the CA on disk in the multus kubeconfig against the one the API server is currently presenting:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> -- chroot /host \
     awk '/certificate-authority-data/{print $2}' \
     /etc/kubernetes/cni/net.d/multus.d/multus.kubeconfig \
     | base64 -d | openssl x509 -noout -issuer -subject -dates

   kubectl get --raw /readyz | true       # on the host network: openssl s_client -connect api:6443 -showcerts
   ```

   A different `Issuer` line proves the on-disk kubeconfig is pinning the old CA.

3. Look at apiserver pod events. The Multus failure shows up as `FailedCreatePodSandBox` referencing `multus-shim`:

   ```bash
   kubectl get events -n <apiserver-namespace> --sort-by=.lastTimestamp | tail -30
   ```

4. After the kubeconfig has been regenerated, confirm a brand-new pod can be scheduled on the node and starts cleanly — that proves Multus's kubeconfig is healthy:

   ```bash
   kubectl run -n default sandbox-test --image=<utility-image> --overrides='{"spec":{"nodeName":"<node>"}}' --rm -it -- echo ok
   ```

5. Once the cluster is stable again, audit the certificate-rotation runbook to make sure the multus + network-operator restart step is documented as a mandatory follow-up to any custom CA change. The trap is silent until the next time something forces a node to bring up new pods — typically the next upgrade.

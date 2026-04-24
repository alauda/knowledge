---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

New pods in a namespace managed by the mesh never transition beyond the `Init` phase. The pod event stream shows the CNI network configuration failing, with a message that is long on plumbing detail but short on the real cause:

```text
Failed to create pod sandbox: rpc error: code = Unknown desc = failed to
create pod network sandbox k8s_xxx: error adding pod to CNI network
"multus-cni-network": plugin type="multus-shim" failed (add): CmdAdd
(shim): CNI request failed with status 400:
  ... ERRORED: error configuring pod [ns/pod] networking:
  [ns/pod/xxx:vN-M-istio-cni]:
  error adding container to network "vN-M-istio-cni":
  Get "https://<svc-ip>:443/api/v1/namespaces/<ns>/pods/<pod>":
  dial tcp <svc-ip>:443: connect: connection refused
```

The same manifest applies cleanly in namespaces that do not have sidecar injection enabled — the blocker is specifically the Istio CNI chain that adds the redirect rules for the sidecar, and that chain fails because its daemon cannot talk to the API server.

## Root Cause

The mesh's CNI plugin runs as a per-node DaemonSet (`istio-cni-node` in upstream Istio; the Service Mesh package on ACP ships the same workload under the mesh operator's namespace). Every time the kubelet invokes the CNI chain to attach a new pod sandbox, the CNI plugin contacts the API server to resolve the pod's labels, annotations, and ambient/sidecar mode. If that call fails (connection refused, i/o timeout, or a TLS error), the plugin returns `CNI request failed with status 400` and the sandbox is never created.

`connection refused` on the API server VIP from the CNI DaemonSet specifically — while other cluster-network traffic works — almost always means one of:

- The `istio-cni-node` pod on that node has crashed, been evicted, or lost its token binding, and its copy of the in-pod kubeconfig is stale.
- The DaemonSet is healthy but the node lost its route to the API server VIP (CoreDNS on the node churned, or the `kube-proxy`/`kube-ovn-controller` nf_conntrack table got pinned to a dead backend).
- A cluster-wide network policy or egress rule now blocks the `istio-cni-node` pod from reaching the API server port.

The healthy steady state is: one `istio-cni-node` pod per node, Ready, with a fresh ServiceAccount token, able to hit `https://<api-server-svc>:443/healthz`. When any of those drift, every subsequent pod that needs sidecar injection on that node fails to come up with the error above.

## Resolution

ACP ships the Istio control plane and CNI plugin through the `service_mesh` capability area; the preferred path is to drive the CNI DaemonSet restart through the mesh operator (the `IstioCNI` CR reconciler) rather than deleting pods by hand. Only if the operator path is unavailable does the direct pod-delete remain the fallback.

1. **Identify the affected node.** Pull the pod that is stuck in `Init` and read its `spec.nodeName`:

   ```bash
   kubectl get pod <stuck-pod> -n <ns> \
     -o jsonpath='{.spec.nodeName}{"\n"}'
   ```

2. **Look at the `istio-cni-node` pod on that node.** Depending on how the mesh was installed, the DaemonSet lives either in the mesh operator's namespace (`istio-cni`, `istio-system`, or the ACP mesh subsystem namespace) or in a shared operators namespace:

   ```bash
   kubectl get pods -A -l k8s-app=istio-cni-node -o wide \
     | grep <affected-node>
   ```

   If the pod is `CrashLoopBackOff` or `Error`, pull its logs — the root cause may be a stale token, an expired webhook certificate, or a node-local kernel/nftables problem. Fix those first before restarting.

3. **ACP-preferred — bounce the DaemonSet pod through the mesh operator.** Edit the `IstioCNI` CR (or the equivalent in the `service_mesh` surface) to trigger a rollout restart; the operator stamps a fresh `kubectl.kubernetes.io/restartedAt` annotation on the DaemonSet and the kubelet replaces the pod in place:

   ```bash
   kubectl -n <mesh-operator-ns> \
     annotate istiocni default \
     restart.istio.io/requested-at="$(date -uIs)" --overwrite
   ```

   Watch the new pod come up, verify the old sandbox-failing pod gets retried by the kubelet, and confirm new pods attach successfully.

4. **Upstream fallback — delete the `istio-cni-node` pod directly.** On a plain OSS Istio install (or if the operator reconcile loop is wedged), delete the DaemonSet pod on the affected node and let the DaemonSet controller replace it:

   ```bash
   kubectl -n <istio-cni-ns> delete pod \
     -l k8s-app=istio-cni-node \
     --field-selector spec.nodeName=<affected-node>
   ```

   The replacement pod picks up a fresh ServiceAccount token, reconnects to the API server, and the CNI chain starts succeeding. Stuck workload pods recover on their next `CreateSandbox` retry (usually within one minute).

5. **Investigate the underlying trigger.** A single DaemonSet pod restart is a mitigation, not a fix. If the problem returns on the same node, suspect: a `NetworkPolicy` that now denies egress from the CNI DaemonSet's labels; a kube-proxy / kube-ovn issue on that node; or a clock skew that invalidated the ServiceAccount token. Tail the DaemonSet's logs during the next recurrence rather than deleting the pod immediately.

## Diagnostic Steps

Check the pod event that produced the sandbox error — a repeating `FailedCreatePodSandBox` against the same node is the definitive signature:

```bash
kubectl get events -n <ns> \
  --field-selector involvedObject.name=<stuck-pod>,reason=FailedCreatePodSandBox \
  -o custom-columns=TIME:.lastTimestamp,MSG:.message
```

Verify the `istio-cni-node` pod on the affected node is Ready and recently started:

```bash
kubectl get pods -A -l k8s-app=istio-cni-node \
  -o wide --field-selector spec.nodeName=<affected-node>
```

From inside the CNI DaemonSet pod, confirm it can actually reach the API server service IP:

```bash
kubectl exec -n <istio-cni-ns> <istio-cni-node-pod> -- \
  sh -c 'wget -qS --no-check-certificate https://kubernetes.default.svc/healthz -O- 2>&1 | head'
```

A healthy response is `200 ok`. `connection refused`, `no route to host`, or a certificate error points at the specific class of break (routing, firewall, token binding) that needs investigation.

Check the CNI plugin's own log on the node for the 400-status handshake:

```bash
kubectl logs -n <istio-cni-ns> <istio-cni-node-pod> -c install-cni --tail=200 \
  | grep -E 'CmdAdd|connection refused|api/v1/namespaces'
```

If the log shows authenticated requests succeeding immediately after the restart, the fix has taken effect and the cluster is no longer blocked.

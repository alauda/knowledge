---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Marketplace Pods Time Out on Startup Probe Behind Strict Default NetworkPolicies
## Issue

After installing or enabling a node-level instrumentation agent (Dynatrace OneAgent's classic FullStack mode is the reported case; the same pattern shows up with other in-process injectors such as APM tracers and security profilers), pods in the platform's marketplace / operator-catalog namespace stop starting on Alauda Container Platform clusters whose default network posture is "deny all egress." The kubelet event log shows:

```text
Startup probe failed: command timed out
```

repeating until the pod is killed and recreated. The same behaviour can affect any pod in a namespace where strict default-deny NetworkPolicies are in effect.

## Root Cause

The marketplace catalog pods use a `grpc_health_probe` startup probe pointed at `:50051` with a small `timeoutSeconds`. When a node-level agent is also injecting itself into every binary launch, every probe execution starts by trying to phone home to the agent's collector. If the cluster's default NetworkPolicy denies that egress, the agent's connect attempt blocks for ~5 seconds before timing out. Only then does `grpc_health_probe` actually open the local gRPC socket — by which point the kubelet has already declared the probe failed.

The pattern is general: any sidecar/in-process agent that adds connect-blocking on every binary launch will tip short-window startup probes into timeout when egress to the agent is policy-blocked. The agent itself works correctly when the network path is open.

## Resolution

Allow the agent's egress out of the marketplace (or other affected) namespace, so the connect attempt completes promptly and the probe runs in time. Two scopings are reasonable.

### Per-namespace egress to the agent's collector

If only one or two namespaces are affected, add a targeted egress rule alongside the deny-all baseline:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-egress-to-agent
  namespace: <marketplace-ns>
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: <agent-collector-ns>
    ports:
    - protocol: TCP
      port: <agent-collector-port>   # e.g. 9999 for the reported agent
```

Apply with `kubectl apply -f`. Existing pods will pick up the new policy on their next probe attempt; if they have already crashed enough times to be in `CrashLoopBackOff`, delete them so the kubelet starts a fresh count.

### Cluster-wide allowance via AdminNetworkPolicy

If the agent is deployed into many namespaces and you want one rule rather than many, use an `AdminNetworkPolicy` (ANP) so cluster admins can allow the agent egress globally without modifying tenant NetworkPolicies:

```yaml
apiVersion: policy.networking.k8s.io/v1alpha1
kind: AdminNetworkPolicy
metadata:
  name: allow-agent-collector
spec:
  priority: 10
  subject:
    namespaces: {}        # all namespaces
  egress:
  - name: allow-agent
    action: Allow
    to:
    - namespaces:
        namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: <agent-collector-ns>
    ports:
    - portNumber:
        protocol: TCP
        port: <agent-collector-port>
```

ANPs sit ahead of standard NetworkPolicies in evaluation and can express cluster-scope allows without forcing tenants to rewrite their own posture.

### Reduce the agent's blast radius

If the agent supports a "cloud-native" mode where individual namespaces can be opted out, exclude the platform marketplace / operator-catalog namespace from injection. This avoids the probe race altogether and is the cleanest answer when the agent is not actually instrumenting the platform's own pods.

## Diagnostic Steps

1. Confirm the marketplace pod is failing on the startup probe, not for another reason:

   ```bash
   kubectl -n <marketplace-ns> describe pod <pod> \
     | grep -E 'Events|Startup probe|Liveness probe'
   ```

2. Time how long `grpc_health_probe` takes inside the pod with verbose output:

   ```bash
   kubectl -n <marketplace-ns> exec <pod> -- \
     bash -c 'date +"%T.%N" && time grpc_health_probe -v --addr=:50051 \
              && date +"%T.%N"'
   ```

   On an instrumented node with no egress for the agent, expect ~5 s wall-clock from a probe that should normally take milliseconds.

3. Confirm the agent really is in the path on that node:

   ```bash
   kubectl debug node/<host> -- \
     ps -ef | grep -i <agent-binary>
   ```

4. After applying the NetworkPolicy / ANP fix, re-time the probe:

   ```bash
   kubectl -n <marketplace-ns> exec <pod> -- \
     time grpc_health_probe --addr=:50051
   ```

   The execution should drop back to the millisecond range and pods should leave `CrashLoopBackOff` within one probe cycle.

5. If the pods continue to crashloop after egress is allowed, capture an `strace` of the probe binary to confirm there is no other connect attempt timing out:

   ```bash
   kubectl -n <marketplace-ns> exec <pod> -- \
     strace -e trace=network -c grpc_health_probe --addr=:50051
   ```

   Any blocking syscall taking seconds is the next candidate to allow-list.

---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Override the istio-proxy Sidecar Image in Sail-Operator Service Mesh
## Issue

A specific build of the `istio-proxy` sidecar must be deployed across the mesh — for example, an air-gapped registry mirror, a hot-fix tag that has not yet been promoted to a stable release channel, or a downstream-built proxy image hardened for the customer's own image-scanning pipeline. By default, the operator selects the proxy image automatically from the control-plane version, leaving no obvious way to substitute a different one.

## Root Cause

In the sail-operator-based Istio control plane, the `Istio` custom resource pins the data-plane proxy image through `.spec.version`. The operator looks up the image digest associated with that version label and rewrites `image:` on every `istio-proxy` container it injects. Editing the proxy image directly on a workload is therefore not durable: the operator overwrites the change on the next reconcile, and a sidecar that survived the rollout will be reverted at the next pod restart.

What is needed is a control-plane-scoped override that the operator honours when it composes the sidecar template, not a per-pod edit.

## Resolution

Set the proxy image at the control-plane level by populating `.spec.values.global.proxy.image` on the `Istio` resource. The operator merges this value into the sidecar template, so every newly injected pod and every restarted pod picks up the new image automatically.

1. Edit the `Istio` control-plane resource:

   ```bash
   kubectl -n istio-system edit istio default
   ```

2. Add the `values.global.proxy.image` block, pointing at the desired registry / tag (or, preferably, a sha256 digest for reproducibility):

   ```yaml
   spec:
     values:
       global:
         proxy:
           image: <my-registry>/istio-proxy@sha256:<digest>
   ```

   Pin to a digest rather than a tag whenever possible. Tag-based references are mutable and will silently change the running fleet the next time the registry is repopulated.

3. Roll the workloads in the mesh so the new sidecar image lands:

   ```bash
   kubectl -n <namespace> rollout restart deployment <name>
   kubectl -n <namespace> rollout status deployment <name> --timeout=5m
   ```

4. Verify a representative pod is running the override:

   ```bash
   kubectl -n <namespace> get pod <pod> \
     -o jsonpath='{.spec.containers[?(@.name=="istio-proxy")].image}'
   ```

   The output must match the digest configured in step 2.

If only a single namespace must use the override (for example a canary), prefer namespace-scoped configuration via the `IstioCNI` plus a per-namespace `Sidecar` resource instead of editing the cluster-wide `Istio` CR. Cluster-wide overrides apply to every workload that is part of the mesh, including ingress and egress gateways.

## Diagnostic Steps

If newly created pods do not pick up the override, walk the chain from operator to workload:

```bash
# Operator received the spec change?
kubectl -n istio-system get istio default \
  -o jsonpath='{.spec.values.global.proxy.image}'

# Operator rendered the sidecar template?
kubectl -n istio-system logs deploy/istio-operator --tail=200 \
  | grep -i "global.proxy.image"

# Sidecar injection webhook is healthy?
kubectl get mutatingwebhookconfiguration istio-sidecar-injector \
  -o yaml | grep failurePolicy
```

If the operator log shows the override but new pods still come up with the default image, the namespace label or pod label that triggers injection is missing — confirm the `istio-injection=enabled` label on the namespace, or `sidecar.istio.io/inject=true` on the pod template.

For pods that started before the change and were never restarted, the override only takes effect after the pod cycles. A `rollout restart` on the owning workload is the cleanest way to force the swap without downtime.

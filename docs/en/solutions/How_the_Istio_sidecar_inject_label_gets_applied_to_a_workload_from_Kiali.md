---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# How the Istio sidecar inject label gets applied to a workload from Kiali
## Overview

On ACP Service Mesh, sidecar injection for a Deployment is governed by the `sidecar.istio.io/inject` label on the pod template. Operators occasionally see this label appear with the value `"false"` on a workload they did not edit by hand, and ask where the change came from.

The short answer: Kiali, when used as the visual control plane for the mesh, can set this label. There is no controller in the mesh stack that flips it on its own — every appearance of `sidecar.istio.io/inject: "false"` traces back to either an explicit user action or an explicit declaration in a manifest / GitOps source.

## Issue

A user observes that a Deployment's pod template has acquired:

```yaml
spec:
  template:
    metadata:
      labels:
        sidecar.istio.io/inject: "false"
```

even though no one has knowingly edited that label. The associated pods now start without an Envoy sidecar, breaking mesh-aware policy and telemetry for the workload. The question is whether some controller is doing this automatically, and whether it can be stopped.

## Root Cause

The label is not set by any auto-reconciliation logic in the mesh control plane. There are exactly two ways for it to appear with the value `"false"` on a workload:

1. **Explicit manifest / GitOps source.** The label is present in the YAML that created or updated the Deployment. This includes Helm values, Kustomize patches, Argo CD `Application` sync sources, or hand-applied YAML.

2. **Action taken from the Kiali console.** Kiali exposes a per-workload action that adds this label. From the workload detail view, the **Actions** menu offers **Disable Auto Injection**; selecting it patches the underlying Deployment to add `sidecar.istio.io/inject: "false"` to the pod template, and the next rollout starts pods without the Envoy sidecar. The complementary action — **Enable Auto Injection** — removes the label (or sets it back to `"true"`, depending on the namespace policy).

Anything else (admission webhooks, default mutators, the Istio Operator, the Kiali Operator) does not touch this label on its own.

## Resolution

Trace the change to its real source instead of trying to undo it in place — otherwise the next reconcile or the next user click puts it right back.

Preferred path on ACP — go through the audit trail to identify who applied the label, then fix it at the source:

1. Use the platform audit log to find the Deployment update that added the label. Look for `update` events on `deployments` with the workload name and a timestamp matching when the change appeared:

   ```bash
   kubectl get events -A --field-selector involvedObject.name=<workload> | grep -i 'updated\|patched'
   ```

   If the platform exposes an audit-log search UI, filter on `verb=patch`, `objectRef.resource=deployments`, and the workload's namespace. The `user.username` field in the matching audit entry tells you who issued the patch.

2. If the audit entry shows a Kiali service account, the change came through the Kiali console — talk to whoever clicked **Disable Auto Injection** and decide whether to re-enable it. To restore injection from Kiali, open the same workload, choose **Actions > Enable Auto Injection**, and let the rollout cycle the pods. To do it from the API instead:

   ```bash
   kubectl -n <ns> patch deployment <name> --type=merge \
     -p '{"spec":{"template":{"metadata":{"labels":{"sidecar.istio.io/inject":"true"}}}}}'
   ```

   Or remove the label entirely so the workload falls back to the namespace-level policy:

   ```bash
   kubectl -n <ns> patch deployment <name> --type=json \
     -p '[{"op":"remove","path":"/spec/template/metadata/labels/sidecar.istio.io~1inject"}]'
   ```

3. If the audit entry shows a human user or a GitOps controller account, the source of truth is in a manifest somewhere — Argo CD `Application`, Helm values file, Kustomize overlay, etc. Edit the source manifest there; otherwise the next sync re-applies the `"false"` value and your patch is overwritten. The most common causes:

   - A team member added `sidecar.istio.io/inject: "false"` deliberately to skip mesh injection during local debugging and then committed the change.
   - A Helm chart ships the label set to `"false"` for one of its templates by default and someone enabled that chart unchanged.

4. Once the source is identified and corrected (whether by re-enabling injection from Kiali or by editing the upstream manifest), trigger a rollout so existing pods are recreated with the sidecar:

   ```bash
   kubectl -n <ns> rollout restart deployment/<name>
   kubectl -n <ns> rollout status deployment/<name>
   ```

   Verify the new pods carry the Envoy sidecar (`istio-proxy` container) before considering the change done.

If the cluster is not running Kiali at all (rare on ACP Service Mesh, since Kiali is part of the bundle, but possible in stripped-down installs), then **only path 1 above** can apply — the change came from a manifest, not from a UI click. In either case the root cause is an explicit action; nothing in the mesh stack injects the disable-label on its own.

## Diagnostic Steps

1. Confirm the label is on the *Deployment* pod template, not just on a single Pod. A label on the Deployment's `spec.template.metadata.labels` is what disables injection going forward; a label only on existing pods is just the carry-over from earlier rollouts:

   ```bash
   kubectl -n <ns> get deployment <name> \
     -o jsonpath='{.spec.template.metadata.labels.sidecar\.istio\.io/inject}{"\n"}'
   ```

   Output of `false` means the Deployment will keep producing sidecar-less pods until the label is changed or removed.

2. Cross-check the namespace-level policy. The Istio control plane combines the namespace label (`istio-injection`) and the per-workload label; understanding both prevents accidentally re-enabling injection at the workload level only to find the namespace is opted out:

   ```bash
   kubectl get namespace <ns> --show-labels | grep -E 'istio-injection|istio.io/rev'
   ```

3. Inspect the resource's `metadata.managedFields` to see which client last touched the label. This is the cheapest way to localise the change before opening the audit log:

   ```bash
   kubectl -n <ns> get deployment <name> -o yaml \
     | yq '.metadata.managedFields[] | select(.fieldsV1["f:spec"]["f:template"]["f:metadata"]["f:labels"]["f:sidecar.istio.io/inject"] != null) | {manager: .manager, time: .time}'
   ```

   The `manager` field will name the responsible client — `kiali`, `argocd-application-controller`, `kubectl-edit`, or similar — which is usually enough to know where to look next.

4. After re-enabling injection, verify the new pods have the sidecar:

   ```bash
   kubectl -n <ns> get pod -l app=<workload-label> \
     -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].name}{"\n"}{end}'
   ```

   Each new pod should list `istio-proxy` alongside the application container(s).

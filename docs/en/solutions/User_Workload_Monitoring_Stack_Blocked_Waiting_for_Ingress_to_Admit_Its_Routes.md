---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# User Workload Monitoring Stack Blocked Waiting for Ingress to Admit Its Routes
## Issue

After enabling user workload monitoring on ACP, the monitoring stack reports itself as degraded and never finishes progressing. A status condition similar to the one below is visible on the owning component:

```text
type: Degraded
status: "True"
reason: MultipleTasksFailed
message: |
  waiting for Thanos Ruler ingress to become ready failed: no status available,
  waiting for UserWorkload federate ingress to become ready failed: no status available
```

The Thanos-Ruler and user-workload federate pods never reach `Running` (or the pods exist but the supporting Ingress objects stay without an admitted status), so federating metrics from the user-workload Prometheus into the platform Prometheus is impossible until the ingress layer admits both routes.

## Root Cause

ACP exposes platform services through the ALB ingress stack (`networking/operators/alb_operator`). ALB — and the stock Kubernetes Ingress controllers it replaces on a stock cluster — only admits an Ingress when the target namespace matches the `namespaceSelector` of the ingress controller that is intended to serve it.

When the default ingress controller is configured with a `namespaceSelector` (for example, `matchLabels: {default: traffic}`) but the namespace hosting user workload monitoring does not carry that label, every Ingress created for Thanos-Ruler and the federation endpoint is ignored by the controller. The monitoring operator then loops forever on "waiting for ingress to become ready" because no admitting controller claims those Ingress resources.

## Resolution

Make the user-workload monitoring namespace visible to the ingress controller that should serve it. Two paths work — choose the one that matches the scope of the change.

1. **Label the target namespace (simplest, scoped fix).** Inspect the ingress controller's `namespaceSelector` and copy the matching label onto the namespace that hosts the user-workload monitoring components (for example `cpaas-monitoring` or whatever namespace the ACP deployment uses):

   ```bash
   kubectl -n <alb-namespace> get ingressclass <alb-class> -o yaml \
     | grep -A2 namespaceSelector
   # suppose the selector matches the label default=traffic

   kubectl label namespace <user-workload-ns> default=traffic --overwrite
   ```

   After the label lands, the ingress controller begins admitting the Thanos-Ruler and federate Ingress objects; the monitoring operator re-reconciles and clears the `Degraded` condition within a reconcile cycle.

2. **Broaden the controller selector.** If the monitoring namespace is not under your control or you want every platform namespace served by the same ingress class without manual labelling, update the ingress controller (or the `ALB` custom resource) to accept the platform namespace label scheme. On ACP ALB this is the `spec.config.ingressClass` / `projects` configuration; on a generic cluster it is the `namespaceSelector` on the ingress controller deployment.

For the OSS fallback path (plain Kubernetes Ingress with nginx-ingress or another controller), the same idea applies: the controller must either have no selector or a selector that matches the monitoring namespace. Either drop the selector or label the namespace to match.

Do not disable user workload monitoring to clear the alert — the root cause is routing admission, not the monitoring stack.

## Diagnostic Steps

1. Find the ingress controller namespace selector that is blocking admission:

   ```bash
   kubectl get ingressclass -o yaml \
     | grep -B1 -A4 namespaceSelector
   ```

2. Confirm the user-workload monitoring namespace is missing the required label:

   ```bash
   kubectl get namespace <user-workload-ns> --show-labels
   ```

3. List the Ingress objects the monitoring stack created and confirm their `status.loadBalancer` is empty:

   ```bash
   kubectl -n <user-workload-ns> get ingress \
     -o custom-columns=NAME:.metadata.name,CLASS:.spec.ingressClassName,ADDRESS:.status.loadBalancer.ingress[*].hostname
   ```

   An empty `ADDRESS` column on `thanos-ruler` and `federate` is the signal that the controller has not admitted them.

4. Check the monitoring operator's own status to confirm the loop the operator is stuck in:

   ```bash
   kubectl -n <user-workload-ns> get prometheus,alertmanager,thanosruler \
     -o yaml | grep -A3 conditions
   ```

5. After labelling, verify the ingress controller picked up the change by re-listing ingresses — the `ADDRESS` column should now populate — and confirm the monitoring stack's `Degraded` condition clears on its next reconcile.

If the condition remains after the ingress objects are admitted, inspect the pod status of `thanos-ruler` and the federate endpoint in the user-workload monitoring namespace: a pending scheduler event (missing node selector tolerations, missing PVC) is a separate root cause and is not related to ingress admission.

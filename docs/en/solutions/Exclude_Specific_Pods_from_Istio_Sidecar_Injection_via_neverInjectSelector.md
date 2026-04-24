---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

An Istio control plane is configured with automatic sidecar injection (namespaces labelled for injection, or a global default). Most workloads in those namespaces gain an `istio-proxy` sidecar automatically — correct behaviour for application pods that should participate in the mesh.

Some pods should **not** have a sidecar, however:

- Short-lived build / deploy helper pods (e.g. image-build pods, deployer pods) that only run long enough to finish one task.
- Job / CronJob pods whose command depends on exit-code semantics — the sidecar outlasts the job's primary container and prevents the Job from completing.
- Legacy workloads running on a different network stack that do not tolerate sidecar mTLS.

Adding `sidecar.istio.io/inject: "false"` to each affected pod's annotations works for individual pods, but does not scale when a pattern of pods (every deployer pod, every build pod) should be globally exempted.

The control-plane-side way to express "match this label pattern anywhere in the mesh and never inject" is the `neverInjectSelector` field on the `Istio` CR.

## Resolution

### Identify the label that uniquely identifies the pods to exclude

Pick a label that the pods carry but that regular application pods do not:

```bash
# Inspect the labels of a representative pod.
kubectl -n <ns> get pod <deployer-pod> --show-labels
# NAME                      LABELS
# nginx-container-7-deploy  platform.example.com/deployer-pod-for=nginx-container-7,
#                           platform.example.com/deployer-phase=Running
```

Typical unique-to-the-class labels include `platform.example.com/deployer-pod-for` for deployer pods, `platform.example.com/build-name` for build pods, or whatever label pattern your CI / automation uses on helper pods.

### Add the label to `neverInjectSelector` on the Istio CR

Edit the Istio CR that governs the control plane (or control-plane slice) responsible for the target namespaces:

```bash
kubectl -n istio-system edit istio <istio-cr-name>
```

Under `spec.values.sidecarInjectorWebhook.neverInjectSelector`, add an entry per label pattern to exclude. Each entry is a standard Kubernetes label selector — typically a `matchExpressions` block:

```yaml
apiVersion: sailoperator.io/v1
kind: Istio
metadata:
  name: istio-mesh
  namespace: istio-system
spec:
  values:
    sidecarInjectorWebhook:
      neverInjectSelector:
        # Exclude every pod with a deployer-for label (any value).
        - matchExpressions:
            - key: platform.example.com/deployer-pod-for
              operator: Exists
        # Exclude every pod with a build-name label (any value).
        - matchExpressions:
            - key: platform.example.com/build-name
              operator: Exists
        # Example: exclude pods explicitly tagged for exclusion.
        - matchLabels:
            sidecar.excluded: "true"
```

Save. The Istio operator reconciles the change to the injector webhook configuration; new pods matching any of the selectors are no longer injected.

### Confirm the exclusion

Existing pods already injected are unaffected — the sidecar was added at admission time and persists until the pod is recreated. Bounce the affected workload so fresh pods go through injection with the updated selector:

```bash
# For a Deployment / DeploymentConfig / StatefulSet:
kubectl -n <ns> rollout restart deployment/<name>
# For Jobs / CronJobs: the next pod they create will pick up the change.
```

Verify a freshly-created helper pod does not have the sidecar:

```bash
kubectl -n <ns> describe pod <helper-pod> | grep -E 'istio-proxy|sidecar\.istio\.io/status'
# No istio-proxy container; sidecar.istio.io/status annotation absent.
```

### Notes on selector semantics

- Each list entry is a **complete** label selector. A pod is excluded if it matches **any** entry (OR between entries).
- Within a single entry, `matchExpressions` and `matchLabels` combine with AND.
- `operator: Exists` matches any value for the key. `operator: In` with a `values` list matches only specific values. `operator: NotIn` is also supported.
- Selector errors (malformed structure) block the injector webhook from starting; verify with `kubectl -n istio-system logs deploy/istiod` if pods start missing sidecars globally after an edit.

### Alternatives and their trade-offs

- **Per-pod `sidecar.istio.io/inject: "false"` annotation.** Works for one-off exceptions. Does not scale; each pod needs the annotation.
- **Namespace-level `istio-injection: disabled` label.** Disables injection for every pod in the namespace. Useful when an entire namespace should be out of the mesh, too coarse when only helper pods in an injected namespace should be exempted.
- **`alwaysInjectSelector`.** The inverse knob. When the default is "no injection" and you want specific pods to be in-mesh, use `alwaysInjectSelector` with the same label-selector shape.

`neverInjectSelector` is the right tool when the default is "inject everything" and specific patterns must opt out.

## Diagnostic Steps

Confirm the sidecar is (or is not) being injected into a specific pod:

```bash
kubectl -n <ns> get pod <name> -o \
  jsonpath='{.metadata.annotations.sidecar\.istio\.io/status}{"\n"}'
```

Present → the sidecar is in the pod. Absent → the sidecar was not injected (either because the namespace is not labelled for injection, or because a selector excluded it, or because the pod has the explicit `inject: "false"` annotation).

Inspect the injector webhook's effective configuration:

```bash
kubectl get mutatingwebhookconfiguration istio-sidecar-injector -o yaml | \
  yq '.webhooks[].namespaceSelector'
```

Verify the namespace scope is as expected. Then check the reconciled Istio CR:

```bash
kubectl -n istio-system get istio <istio-cr-name> -o yaml | \
  yq '.spec.values.sidecarInjectorWebhook.neverInjectSelector'
```

The selector list should match what was added. If it is empty but should not be, the CR's edit did not reconcile — look for operator errors:

```bash
kubectl -n istio-system logs deploy/<istio-operator> --tail=200 | \
  grep -iE 'istio|neverInject|error'
```

After applying the selector and restarting the workload, the helper pods come up without the sidecar, run to completion (for Jobs), or serve traffic without going through the mesh (for long-running workloads). Mesh-level features that depended on the sidecar (mTLS, retry policies, telemetry) do not apply to these pods — which was the point of the exclusion.

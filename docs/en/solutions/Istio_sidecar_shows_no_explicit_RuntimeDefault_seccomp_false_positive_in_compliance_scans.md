---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A compliance scanner flags every pod that carries an `istio-proxy` sidecar as failing the rule *"Do not disable default seccomp profile"*, with severity *critical*. The application container itself is configured correctly:

```yaml
securityContext:
  seccompProfile:
    type: RuntimeDefault
```

…but the scanner inspects the sidecar separately and finds no `seccompProfile` field on it. Operators try to fix that on the mesh control-plane CR (the `IstioControlPlane` / `ServiceMeshControlPlane`-style CR shipped by the operator) — and the change is reverted on the next reconcile. The questions raised:

1. Is there a CR field that injects `seccompProfile: RuntimeDefault` into every sidecar?
2. Is the rule actually being violated, or is the scanner reporting a false positive?

## Root Cause

The mesh operator's control-plane CR — whatever flavour your platform ships (`Istio`, `IstioControlPlane`, `ServiceMeshControlPlane`, etc.) — does **not** expose an API field that injects a `seccompProfile` into the sidecar template. That is by design: the sidecar's pod-spec is rendered from a webhook-side template that fills in the runtime parameters the mesh needs (image, args, ports, lifecycle hooks) and leaves the security context to be set by the **pod admission policy** of the namespace it lands in.

In a cluster that enforces Pod Security Standards (or an equivalent admission constraint), the *baseline* / *restricted* policy applies `RuntimeDefault` seccomp to every container that does not specify one explicitly. The kernel-side seccomp filter is therefore active on the sidecar — the runtime is enforcing `RuntimeDefault` even though the field is absent from the pod spec.

The compliance scanner fails the check because it greps for an explicit `seccompProfile` entry in the *container* spec, not because seccomp is disabled at runtime. Two facts are true at once:

- The sidecar **does** run with `RuntimeDefault` seccomp at the kernel level.
- The sidecar **does not** declare it in its container spec, because the mesh's sidecar template does not set it and no API field would let you change that.

That mismatch is what the scanner is reading; it is a reporting issue, not a security regression.

## Resolution

Do **not** modify the mesh control-plane CR — there is no field for it, and any attempted patch is reverted on the next operator reconcile. Approach the requirement through namespace-level admission instead.

### 1. Confirm the namespace's admission policy enforces RuntimeDefault

The standard knob is the Pod Security `enforce` label on the namespace:

```bash
kubectl label ns <workload-namespace> \
  pod-security.kubernetes.io/enforce=restricted --overwrite
kubectl label ns <workload-namespace> \
  pod-security.kubernetes.io/enforce-version=latest --overwrite
```

`restricted` (and, in many clusters, `baseline`) injects `RuntimeDefault` seccomp into containers that don't specify one. Once the label is in place, every new pod — including newly-injected sidecars — is admitted only if it satisfies the policy, and the kernel filter is on regardless of what the YAML shows.

### 2. (Equivalent) use the workload's own pod template

If the namespace cannot be moved to `restricted`, set `seccompProfile: RuntimeDefault` at the **pod** level on the application's Deployment. The Pod-level setting becomes the default for every container in the pod, including the injected sidecar:

```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: app
          # ... no per-container seccomp needed; inherits from pod
```

When the sidecar is injected by the mesh webhook, the pod-level `securityContext` is already on the pod and the sidecar inherits it — the rendered pod has `RuntimeDefault` on every container, which is what the scanner is looking for.

### 3. Suppress the scan rule for the sidecar (compensating control)

If neither of the above is acceptable for the cluster, treat the finding as a false positive in the scanner's exception list — but only after you have demonstrated that seccomp is in fact in effect on the sidecar (see *Diagnostic Steps* below). The exception is documented as "scanner reads the spec, kernel enforces via admission policy" with a link to the steps that prove it.

## Diagnostic Steps

1. List the pods in the namespace and dump their effective `seccompProfile`. The field shows up *somewhere* on each running pod even when the manifest had it only at the pod level — the runtime serializes the merged spec:

   ```bash
   for p in $(kubectl get pod -n <ns> -o name); do
     echo "$p"
     kubectl get -n <ns> "$p" -o yaml \
       | yq '.spec.securityContext.seccompProfile,
             .spec.containers[].securityContext.seccompProfile'
   done
   ```

   Look for `RuntimeDefault` on each pod. If the pod-level field is set, that is what the sidecar inherits.

2. Read which security profile is actually attached to the running pod by reading its annotations and/or the cluster's pod admission decision log. The pod's annotations record which security profile/SCC admitted it:

   ```bash
   kubectl get pod -n <ns> <pod> \
     -o jsonpath='{.metadata.annotations}' | jq .
   ```

   The annotation key set varies by platform — the value will name the policy that admitted the pod, and the policy's definition spells out that `RuntimeDefault` is enforced.

3. Confirm the mesh CR has no API field for seccomp (so the operator-side path is genuinely closed). For the v2-style ServiceMeshControlPlane CRD, grep its `manifests/.../servicemeshcontrolplanes.crd.yaml` for `seccomp` — there is no match. Equivalent for the upstream `Istio` CRD: there is no `seccompProfile` knob on the `meshConfig` or proxy template. Setting it through the CR is therefore not reachable at any version.

4. Prove the kernel filter is on. From a debug shell inside the sidecar:

   ```bash
   kubectl exec -n <ns> <pod> -c istio-proxy -- \
     grep Seccomp /proc/1/status
   ```

   `Seccomp: 2` means the filter is loaded. That is the operational evidence that the scanner finding is a spec-level false positive, not a runtime gap.

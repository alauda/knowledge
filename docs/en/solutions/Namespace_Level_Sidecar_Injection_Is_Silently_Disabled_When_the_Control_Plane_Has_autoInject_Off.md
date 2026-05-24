---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Namespace-Level Sidecar Injection Is Silently Disabled When the Control Plane Has autoInject Off
## Issue

Workloads in a namespace that is labelled `istio-injection=enabled` start without the `istio-proxy` sidecar. Pods come up at `1/1 Ready` instead of the expected `2/2 Ready`, and the only way to get the sidecar injected is to add the per-pod annotation on every Deployment:

```yaml
spec:
  template:
    metadata:
      annotations:
        sidecar.istio.io/inject: "true"
```

The namespace label alone produces no sidecar. The mutating admission webhook is installed (the `MutatingWebhookConfiguration` exists and is bound to pod creation), but it never actually mutates the pods in this namespace.

## Root Cause

The Istio sidecar injector ships with two operating modes, controlled by a global toggle on the control-plane installation:

- **Opt-out (autoInject on)** — the default for most installations. Every namespace carrying `istio-injection=enabled` (or `istio.io/rev=<rev>` in revision-based installs) is injected automatically. A workload can exclude itself per-pod by setting `sidecar.istio.io/inject: "false"`.
- **Opt-in (autoInject off)** — the webhook ignores the namespace label entirely. Pods only get a sidecar if they explicitly carry `sidecar.istio.io/inject: "true"`.

When the control plane is configured with `autoInject: false` at install time (or an upgrade flipped the setting), the cluster is in opt-in mode. The namespace label becomes decorative — the webhook's match expression requires both the namespace label **and** the global toggle to be on. That combination is what the present symptom describes.

For the sidecar to land via the namespace label, three conditions must be true at the same time:

1. The control-plane CR (on ACP Service Mesh v2 / v1 extension: `ServiceMeshControlPlane`; on v2-extension built on upstream Istio: `Istio` or the IstioOperator CR) has `autoInject: true`.
2. The target namespace is a member of the mesh — either in the `ServiceMeshMemberRoll` on v1-style installs, or simply labelled with the mesh revision on newer installs.
3. The namespace carries `istio-injection=enabled` (or the matching revision label).

Missing any one of them silently disables automatic injection.

## Resolution

Fix the global toggle at the control-plane level rather than papering over it with per-Deployment annotations.

### On ACP Service Mesh v1 / v1 extension (SMCP API)

Edit the `ServiceMeshControlPlane` in the mesh's system namespace and set `spec.proxy.injection.autoInject` to `true`:

```bash
kubectl edit smcp -n istio-system
```

```yaml
apiVersion: maistra.io/v2
kind: ServiceMeshControlPlane
metadata:
  name: basic
  namespace: istio-system
spec:
  proxy:
    injection:
      autoInject: true
```

Wait for the SMCP's `status.readiness` to report that the new revision has been reconciled. The mutating webhook configuration is re-rendered with the opt-out match expression at that point.

### On ACP Service Mesh v2 / v2 extension (upstream Istio API)

Set the equivalent value in the `Istio` CR (or `IstioOperator` / values bundle used at install). Where the field lands depends on the installer shape in use, but it is ultimately wired to the `sidecarInjectorWebhook.enableNamespacesByDefault` / `autoInject` Helm value:

```yaml
spec:
  values:
    sidecarInjectorWebhook:
      enableNamespacesByDefault: true
```

Re-apply and let the operator reconcile.

### Re-prime the target namespace

Namespace membership and label must also be in place:

```bash
# For v1-style meshes with SMMR:
kubectl -n istio-system get smmr default -o jsonpath='{.spec.members}{"\n"}'
# Add the namespace if absent:
kubectl -n istio-system patch smmr default \
  --type='json' -p='[{"op":"add","path":"/spec/members/-","value":"my-ns"}]'

# Apply the injection label (works for both v1 and v2):
kubectl label namespace my-ns istio-injection=enabled --overwrite
```

Pods created **after** the control-plane change will get the sidecar; pre-existing pods keep whatever shape they were admitted with. Trigger a rollout to pick up the sidecar:

```bash
kubectl -n my-ns rollout restart deployment
```

Remove the `sidecar.istio.io/inject: "true"` pod annotations from Deployments once the namespace-level path works — leaving them in produces confusing behaviour later (they override the namespace label, so toggling the namespace off will not actually disable injection for those workloads).

## Diagnostic Steps

1. **Check the global autoInject setting.**

   ```bash
   # v1-style SMCP:
   kubectl -n istio-system get smcp -o yaml | \
     grep -A5 "proxy:"

   # v2 / upstream:
   kubectl -n istio-system get istio -o yaml | \
     grep -A3 "sidecarInjectorWebhook\|autoInject"
   ```

   The value `false` (or the field missing in an opt-in-by-default install) indicates opt-in mode.

2. **Confirm namespace membership (v1-style only).**

   ```bash
   kubectl -n istio-system get smmr default \
     -o jsonpath='{.spec.members}{"\n"}'
   ```

   On v2-style installs, membership is conveyed by the namespace label alone — this check does not apply.

3. **Verify the namespace label.**

   ```bash
   kubectl get ns my-ns --show-labels
   ```

   Look for `istio-injection=enabled` or `istio.io/rev=<rev>` (on revision-based installs).

4. **Inspect a misbehaving pod.**

   ```bash
   kubectl -n my-ns get pod <pod> -o jsonpath='{.spec.containers[*].name}{"\n"}'
   ```

   Output should include `istio-proxy`. If it lists only the application container, the webhook did not mutate the admission request.

5. **Tail the injection webhook's logs.**

   ```bash
   kubectl -n istio-system logs deploy/istiod --tail=100 | grep -i inject
   ```

   Entries of the form `"namespace not labelled for injection"` versus `"autoInject disabled"` pinpoint which of the three conditions above is missing.

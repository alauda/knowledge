---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500458
---

# Service creation times out when a ValidatingAdmissionPolicy denies IPAddress creation on ACP

## Issue

On Alauda Container Platform with kube-apiserver `v1.34.5` (image `registry.alauda.cn:60080/tkestack/kube-apiserver:v1.34.5`, kube-apiserver static pod running in `kube-system`), the `admissionregistration.k8s.io/v1` `ValidatingAdmissionPolicy` (VAP) and `ValidatingAdmissionPolicyBinding` (VAPB) types are built into the apiserver and the standard CEL evaluation pipeline is in effect. When a request matches a VAP+binding pair and the policy's CEL expression evaluates to a denial — or to a runtime error under `failurePolicy=Fail` — kube-apiserver rejects the request with shape `<resource> "<name>" is forbidden: ValidatingAdmissionPolicy '<policy>' with binding '<binding>' denied request: expression '<expr>' resulted in error: <message>`.

Under the multi-ServiceCIDR feature, kube-apiserver allocates a Service ClusterIP by creating an `IPAddress` (`networking.k8s.io/v1`) object through its internal `ipallocator`; on this cluster the `ServiceCIDR` `kubernetes` is wired with `CIDRS=10.4.0.0/16` and every live `IPAddress` carries the `ipaddress.kubernetes.io/managed-by=ipallocator.k8s.io` label plus a `spec.parentRef` of `{resource: services, namespace: <svc-ns>, name: <svc-name>}` pointing at the owning Service. Because the Service create depends on the backing `IPAddress` create, a VAP that denies `IPAddress` creation blocks the apiserver's internal ipallocator step, so the Service create call cannot complete its ClusterIP allocation.

## Root Cause

A `ValidatingAdmissionPolicy` whose CEL expression dereferences a field that is not present on the admission request's object — for example a policy that references `request.namespace` while the matched resource is cluster-scoped, such as `IPAddress` — surfaces a CEL runtime error of the documented form `no such key: <key>` when the policy references a field not present on the resource under evaluation. Under `failurePolicy=Fail` a CEL runtime error causes the request to be denied, so the denial surfaces with the upstream apiserver shape `ValidatingAdmissionPolicy '<policy>' with binding '<binding>' denied request: expression '<expr>' resulted in error: no such key: <key>`.

When the ipallocator's `IPAddress` create is denied this way, the apiserver's Service ClusterIP allocation step cannot complete because the backing `IPAddress` object never reaches the apiserver's storage. The fault is in the buggy policy on the cluster, not in `IPAddress` or in `Service`; `ValidatingAdmissionPolicy` and `ValidatingAdmissionPolicyBinding` are the upstream Kubernetes admission primitives at `admissionregistration.k8s.io/v1` and operate identically here.

## Resolution

The actual remediation is to delete the binding then the policy. The `ValidatingAdmissionPolicyBinding` is the object that activates a `ValidatingAdmissionPolicy` against matching requests (`spec.policyName` names the policy and `spec.validationActions` includes `Deny`); deleting the binding first stops the policy from being enforced, then deleting the policy itself removes the buggy CEL expression so no future binding can re-attach it. Both objects are plain Kubernetes resources at `admissionregistration.k8s.io/v1`, so the deletes run as ordinary `kubectl delete` commands with no platform wrapper.

```bash
kubectl delete validatingadmissionpolicybindings <binding-name>
kubectl delete validatingadmissionpolicy <policy-name>
```

After the binding and the policy are gone, kube-apiserver's ipallocator is no longer blocked by the denied `IPAddress` create path; subsequent Service creations complete their ClusterIP allocation through the standard apiserver code path and the timeouts stop.

## Diagnostic Steps

List the `ValidatingAdmissionPolicy` and `ValidatingAdmissionPolicyBinding` objects on the cluster to surface the offending policy by name; on this kube-apiserver build both types are served as built-in apiserver resources, so the commands work verbatim without any CRD installation step:

```bash
kubectl get validatingadmissionpolicy
kubectl get validatingadmissionpolicybinding
```

Read the kube-apiserver pod logs to capture both the Service-create timeout consequences and the underlying admission rejection that explains why the ClusterIP cannot be allocated. The kube-apiserver static pod lives in the `kube-system` namespace and is named `kube-apiserver-<control-plane-IP>`; its log stream emits the standard upstream klog lines:

```bash
kubectl -n kube-system get pods -l component=kube-apiserver
kubectl -n kube-system logs kube-apiserver-<control-plane-IP>
```

The log shape to grep for is the ipallocator denial line of the form `ipallocator.go:<line>] can not create IPAddress <ip>: ipaddresses.networking.k8s.io "<ip>" is forbidden: ValidatingAdmissionPolicy '<policy>' with binding '<binding>' denied request: expression '<expr>' resulted in error: <message>`. This is upstream apiserver source emitted from `pkg/registry/core/service/ipallocator/`; on a healthy cluster the sibling emitter `cidrallocator.go:277] updated ClusterIP allocator for Service CIDR <cidr>` is visible in the same kube-apiserver log stream and confirms the allocator is wired even when no denial line is present. When the denial line does appear, it names the policy and binding that need to be deleted under Resolution.

On the client side, the apiserver may return a timeout error to the Service create call while the backing `IPAddress` allocation remains blocked by the VAP; that client-visible symptom pairs with the `can not create IPAddress` log lines on the apiserver side, which can be read from the kube-apiserver pod in `kube-system`.

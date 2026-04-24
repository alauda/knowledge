---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The cluster needs to install a Kubernetes operator without going through the platform's Operator Lifecycle Manager (OLM). Common reasons include: a vendor only ships raw YAML manifests rather than a bundle/catalog entry; an air-gapped lab where the catalogd image cannot be reached; or an early-bring-up step before the lifecycle layer is ready. The question is whether bypassing the lifecycle manager is supported and, if so, what the minimum set of resources looks like.

## Root Cause

An operator is, structurally, just a controller pod that watches one or more Custom Resource Definitions and reconciles instances of those CRDs cluster-wide. The lifecycle manager (OLM / catalogd, mapped to ACP's `extend` area) wraps that controller with extra resources — `Subscription`, `ClusterServiceVersion`, `OperatorGroup` — to manage upgrades, channel selection, dependency resolution, and webhook reconciliation. None of those wrappers are required for the controller pod itself to function.

This means the cluster is *agnostic* to how an operator is installed: the lifecycle layer is the recommended on-ramp, but a plain Deployment + RBAC + CRD set is just as valid from the API server's perspective. Whether a specific vendor *supports* the bypass path is a per-vendor policy decision; some operators ship a documented "raw YAML" install option, others only support the lifecycle-manager flow.

## Resolution

### Preferred: install through the lifecycle layer (`extend`)

If the operator is published to a catalog reachable by the cluster, install it through the `extend` surface. The lifecycle manager handles upgrades, channel selection, and webhook certificates automatically. Skip ahead only if catalog-based installation is genuinely unavailable.

### Fallback: install the controller manifests directly

Five resource categories are required, in roughly this order:

1. **Custom Resource Definitions.** Establish the API surface the operator will reconcile. Apply every CRD before the controller starts, otherwise the controller's informers will fail to register.

   ```bash
   kubectl apply -f crds/
   ```

2. **Namespace and ServiceAccount.** The controller runs as a pod and needs an identity. A dedicated namespace makes RBAC scoping clearer.

   ```bash
   kubectl create namespace my-operator
   kubectl -n my-operator create serviceaccount my-operator
   ```

3. **ClusterRole and ClusterRoleBinding.** Grant only the permissions the controller actually uses (it will need `*` on its CRDs and read access to the resources it manages, e.g. `Pods`, `Services`, `ConfigMaps`).

   ```yaml
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRole
   metadata:
     name: my-operator
   rules:
     - apiGroups: ["mygroup.example.com"]
       resources: ["*"]
       verbs: ["*"]
     - apiGroups: [""]
       resources: ["pods", "services", "configmaps", "secrets", "events"]
       verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
   ---
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRoleBinding
   metadata:
     name: my-operator
   subjects:
     - kind: ServiceAccount
       name: my-operator
       namespace: my-operator
   roleRef:
     apiGroup: rbac.authorization.k8s.io
     kind: ClusterRole
     name: my-operator
   ```

   If the operator uses leader election, add a namespaced `Role`/`RoleBinding` granting `coordination.k8s.io/leases` in its own namespace.

4. **Operator Deployment.** The actual controller manager pod. Pin the image tag (no `:latest`), set `WATCH_NAMESPACE` (empty value or `*` for cluster-wide; a single namespace name to scope to one namespace), and bind it to the ServiceAccount created above.

   ```yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: my-operator
     namespace: my-operator
   spec:
     replicas: 1
     selector:
       matchLabels: { name: my-operator }
     template:
       metadata:
         labels: { name: my-operator }
       spec:
         serviceAccountName: my-operator
         containers:
           - name: manager
             image: example.com/my-operator:1.4.0
             env:
               - name: WATCH_NAMESPACE
                 value: "*"
               - name: POD_NAME
                 valueFrom:
                   fieldRef: { fieldPath: metadata.name }
   ```

5. **(Optional) Webhook configuration.** Operators that use admission webhooks need a `Service`, a TLS certificate (cert-manager or hand-provisioned), and a `ValidatingWebhookConfiguration` / `MutatingWebhookConfiguration` whose `caBundle` matches the cert. Skip this step if the bundle does not include webhooks.

Apply the manifests in the order above; the controller comes up once its CRDs and RBAC are in place.

### Trade-offs versus the lifecycle layer

Bypassing the lifecycle manager moves several responsibilities back to the operator's installer:

- **Upgrades** become a manual `kubectl apply` of new manifests; there is no channel/version negotiation.
- **CRD migrations** between operator versions must be reviewed by hand — the lifecycle manager's conversion-webhook reconciliation is no longer in the loop.
- **Webhook certificate rotation** must be handled by cert-manager or by the operator itself.
- **Dependency resolution** disappears: if operator A requires operator B, both have to be installed and ordered explicitly.

For long-lived workloads, return to the lifecycle layer once the original blocker (catalog reachability, vendor packaging) is resolved.

## Diagnostic Steps

Confirm the CRDs and the controller are healthy after the install:

```bash
kubectl get crd | grep mygroup.example.com
kubectl -n my-operator get deploy,pod
kubectl -n my-operator logs deploy/my-operator --tail=200
```

If the controller pod is running but reconciliation never fires, the most common causes are an RBAC gap (the ServiceAccount cannot `list` the CRD) or a stale `WATCH_NAMESPACE` value:

```bash
kubectl auth can-i list mygroup.example.com --as=system:serviceaccount:my-operator:my-operator -A
kubectl -n my-operator get deploy my-operator -o jsonpath='{.spec.template.spec.containers[0].env}' | jq .
```

Verify a CR triggers reconciliation end-to-end:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: mygroup.example.com/v1
kind: MyResource
metadata:
  name: smoke-test
  namespace: default
spec: {}
EOF
kubectl -n my-operator logs deploy/my-operator --tail=50 | grep smoke-test
```

If logs do not show the reconcile, recheck the CRD's `spec.scope` (cluster vs namespaced) against where the CR was created — a mismatch is silently ignored by the controller-runtime cache.

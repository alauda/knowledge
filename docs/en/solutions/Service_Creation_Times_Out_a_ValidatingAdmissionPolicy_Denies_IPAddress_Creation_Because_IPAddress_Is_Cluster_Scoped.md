---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Creating even the simplest `Service` object times out at the API server:

```text
Error from server (Timeout): error when creating "service.yaml":
  Timeout: request did not complete within requested timeout -
  context deadline exceeded
```

Higher-level operations that chain through `Service` creation fail the same way — for example, KubeVirt's `virtctl image-upload` creates an intermediate Service and blocks there:

```text
{"level":"error","controller":"upload-controller",
 "object":{"name":"app-vm","namespace":"virt-ns"},
 "error":"upload service API create errored: Timeout: request did not complete within requested timeout - context deadline exceeded"}
```

In the kube-apiserver logs, the explanation is repeated for every allocation attempt:

```text
can not create IPAddress 172.0.0.10:
  ipaddresses.networking.k8s.io "172.0.0.10" is forbidden:
  ValidatingAdmissionPolicy 'deny-ipaddress-in-default' with binding
  'deny-ipaddress-in-default-binding' denied request:
  expression 'request.namespace == "default" || object.metadata.namespace == "default"'
  resulted in error: no such key: namespace
```

Service creation hangs because the cluster's IP allocator can no longer create the backing `IPAddress` object.

## Root Cause

Starting with Kubernetes 1.27, the service-network allocator writes an `ipaddresses.networking.k8s.io` object for every allocated Service ClusterIP. The allocator runs inside `kube-apiserver`: when a Service comes in, the allocator picks a free IP, creates the matching `IPAddress`, and only then returns success for the Service create.

The `IPAddress` kind is **cluster-scoped**. Its objects have no `.metadata.namespace` field. Any admission policy that reads `request.namespace` or `object.metadata.namespace` on a cluster-scoped resource encounters an undefined key and the CEL expression evaluates to an error rather than true or false.

With the policy's `failurePolicy: Fail` (the default), every allocator write is rejected. The allocator retries, the Service create never completes, and the caller sees a context deadline. The apiserver log accumulates one `can not create IPAddress` line per retry, which compounds.

Where the policy came from: it was authored to block a different class of problem — typically a workaround that tried to prevent specific IP allocations in the `default` namespace. The CEL expression used `object.metadata.namespace` assuming the target was a namespaced resource. When the allocator began writing `IPAddress` (cluster-scoped) objects as part of normal Service creation, the policy's evaluation broke because the field is absent on cluster-scoped objects.

The fix is to remove the broken policy. Whatever original concern prompted it should be re-expressed either (a) targeting only the namespaced resources it was meant for, or (b) handled upstream in the workload that was creating the problematic allocations.

## Resolution

### Step 1 — locate the policy and its binding

```bash
kubectl get validatingadmissionpolicy 2>/dev/null
kubectl get validatingadmissionpolicybinding 2>/dev/null
```

Typical output on an affected cluster:

```text
NAME                            VALIDATIONS   PARAMKIND   AGE
deny-ipaddress-in-default       1                         2d1h
```

Inspect the binding to see which resources it applies to:

```bash
kubectl get validatingadmissionpolicy deny-ipaddress-in-default -o yaml
kubectl get validatingadmissionpolicybinding deny-ipaddress-in-default-binding -o yaml
```

Look for `matchConstraints.resourceRules` that include `ipaddresses` or `"*"` — the policy that breaks the allocator matches cluster-scoped kinds.

### Step 2 — delete the binding first, then the policy

Deleting in this order avoids a brief window during which the policy is orphaned but still matches the binding's selector:

```bash
kubectl delete validatingadmissionpolicybinding deny-ipaddress-in-default-binding
kubectl delete validatingadmissionpolicy         deny-ipaddress-in-default
```

### Step 3 — confirm Service creation works again

Create a scratch Service in a test namespace:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: probe-service
  namespace: default
spec:
  ports:
  - port: 80
    targetPort: 80
  selector:
    app: nothing
EOF
```

On a healthy cluster the create returns in under 500 ms with a real `.spec.clusterIP` assigned. Clean up afterwards:

```bash
kubectl -n default delete service probe-service
```

Watch the apiserver log; the `can not create IPAddress` lines should stop.

### Step 4 — replace the policy safely, if the original intent still applies

If the team that wrote the policy still needs to deny certain allocations, re-author the policy with a CEL expression that guards against missing fields. The pattern is either to scope `matchConstraints` to the namespaced kind the intent was about, or to use `has()` guards in CEL:

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: example-safe-policy
spec:
  matchConstraints:
    resourceRules:
      - apiGroups:   [""]
        apiVersions: ["v1"]
        operations:  ["CREATE","UPDATE"]
        resources:   ["services"]          # namespaced kind — do NOT list ipaddresses here
  validations:
    - expression: >
        !has(object.metadata.namespace) || object.metadata.namespace != "default"
      message: "Services in the default namespace are not allowed"
```

The key points:

- Restrict `matchConstraints.resourceRules.resources` to **only** the namespaced kinds you mean to target. Leaving it wildcard or including cluster-scoped kinds reintroduces the original bug.
- Use `has(object.metadata.namespace)` to short-circuit before reading the field. CEL's `has()` returns false for absent keys rather than erroring.
- Prefer `failurePolicy: Fail` for real policy, but validate the expression against both namespaced and cluster-scoped resources in a test cluster first.

## Diagnostic Steps

Check for the error signature in apiserver logs — the path is `allocator → IPAddress create → VAP denial`:

```bash
kubectl logs -n kube-system -l component=kube-apiserver --tail=500 | \
  grep -c 'can not create IPAddress.*ValidatingAdmissionPolicy'
```

Any non-zero count while Service creation is timing out is a reliable match for this runbook.

List the policies that could touch allocator writes:

```bash
# Policies whose matchConstraints could hit ipaddresses:
kubectl get validatingadmissionpolicy -o=jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.matchConstraints.resourceRules}{"\n"}{end}'
```

Any policy whose rules match `*` or explicitly list `ipaddresses` is a suspect.

Verify the same expression behaves as expected in a dry-run so you can judge the fix before deleting anything permanent:

```bash
# Example — dry-run server-side creation of a service as the apiserver would:
kubectl create service clusterip probe-dryrun \
  --tcp=80:80 \
  --dry-run=server --validate=strict \
  -o yaml
```

A cluster in the broken state returns the same timeout; a cluster after Step 2 returns the fully-allocated object.

Finally, check the `IPAddress` resource itself — its objects should exist one-per-allocated-ClusterIP:

```bash
kubectl get ipaddresses.networking.k8s.io | head
```

Rows equal to the number of services with a ClusterIP means the allocator is working again. A sparse list (far fewer IPAddresses than Services) indicates allocator writes are still being blocked — revisit Step 1 and look for a policy you missed.

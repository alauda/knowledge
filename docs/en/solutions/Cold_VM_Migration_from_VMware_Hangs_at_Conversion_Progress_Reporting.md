---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Cold VM Migration from VMware Hangs at Conversion-Progress Reporting
## Issue

A cold migration of a VMware VM into ACP Virtualization stalls at the final step. The migration plan sits at "converting…" forever. The `virt-v2v` pod in the target namespace completes its conversion work and opens an HTTP server to report the resulting VM XML, but the migration controller never completes the plan. Representative symptoms:

- `virt-v2v` pod log ends with `Starting server on:8080`, no crash, no further progress.
- Migration-controller log in the platform-migration namespace reports:

  ```text
  msg="Failed to update conversion progress"
  error="Get \"http://10.128.1.34:2112/metrics\": dial tcp 10.128.1.34:2112: i/o timeout"
  ```

## Root Cause

The VM-from-VMware workflow has two pods in two namespaces:

- The **migration controller** (Forklift controller) runs in the platform migration namespace (install-specific; on ACP it's the Virtualization migration component's namespace).
- The **virt-v2v + vddk** conversion pod runs in the **target** namespace — where the imported VM will live.

At the end of conversion, virt-v2v exposes two HTTP endpoints to the controller:

| Port | Purpose |
|---|---|
| `8080` | serves the produced VM XML (for the controller to read and create the VMI) |
| `2112` | exposes conversion progress metrics |

If the **target** namespace has a default-deny NetworkPolicy (or any policy that doesn't explicitly admit ingress from the migration-controller namespace), both of those endpoints are unreachable. The controller times out on `:2112/metrics`, the plan never reads the finished XML from `:8080`, and the migration hangs indefinitely.

Common-case predicate: the target namespace carries a standard "deny-by-default + allow-from-same-namespace + allow-from-ingress + allow-from-monitoring" set of policies — which is a reasonable security baseline but doesn't know about the migration controller.

## Resolution

Admit ingress from the migration-controller namespace on the target namespace. Apply only while migrations are active, or keep it as a standing policy if the target namespace routinely receives VM imports.

1. **Identify the migration-controller namespace.** It carries the virtualization migration controller pod. The exact name depends on the ACP Virtualization install:

   ```bash
   # Find the controller pod by label (common selector)
   kubectl get pod -A -l app.kubernetes.io/component=forklift-controller -o wide
   # Or by deployment name pattern
   kubectl get pod -A | grep -E 'forklift.*controller|migration.*controller'
   ```

   Whatever namespace shows up is the one to admit.

2. **Add the allow-ingress policy in the target namespace.** Pair the namespace selector with a pod selector so only the conversion pod is reachable:

   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata:
     name: allow-from-migration-controller
     namespace: <target-ns>
   spec:
     podSelector:
       matchExpressions:
         - key: forklift.konveyor.io/plan
           operator: Exists
     policyTypes:
       - Ingress
     ingress:
       - from:
           - namespaceSelector:
               matchLabels:
                 kubernetes.io/metadata.name: <migration-controller-ns>
         ports:
           - protocol: TCP
             port: 8080
           - protocol: TCP
             port: 2112
   ```

   The `podSelector` scopes the rule to the virt-v2v pods only (they carry the `forklift.konveyor.io/plan` label). This keeps the rest of the namespace's default-deny posture intact.

3. **Re-run the plan.** The controller picks up the next reconcile within ~10s and completes. No need to restart anything.

4. **For a standing solution**, include the allow-from-migration-controller policy in the namespace template / project template used for VM-import landing zones. Once a team knows their namespace will receive migrations, the policy should be pre-provisioned.

## Diagnostic Steps

Confirm the controller is timing out on the metrics endpoint:

```bash
kubectl -n <migration-controller-ns> logs deploy/<controller> --tail=200 \
  | grep -i 'Failed to update conversion progress'
```

Confirm virt-v2v reached the "ready-to-serve" state:

```bash
kubectl -n <target-ns> get pod -l forklift.konveyor.io/plan -o wide
kubectl -n <target-ns> logs <virt-v2v-pod> -c virt-v2v --tail=20
```

If the log ends with `Starting server on:8080` and no further activity, the conversion is done — the issue is network reachability, not the conversion itself.

Verify the namespace's inbound policy set:

```bash
kubectl -n <target-ns> get networkpolicy
kubectl -n <target-ns> describe networkpolicy
```

A "deny-all-by-default" rule combined with no explicit allow from the migration-controller namespace matches the failure mode. Apply the NetworkPolicy above; the plan resumes within one reconcile.

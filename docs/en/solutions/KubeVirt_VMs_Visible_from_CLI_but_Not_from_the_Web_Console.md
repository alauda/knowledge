---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Application users on Alauda Container Platform Virtualization can list and inspect their virtual machines through `kubectl`, `virtctl`, or any other API client, but the platform web console shows the namespace as empty (or hides the Virtualization tab entirely). The same user can run, for example:

```bash
kubectl -n project1 get vm
virtctl -n project1 console <vm>
```

and get correct results, while the console UI displays "no projects" or "no virtual machines" for the same identity.

## Root Cause

There are two layers of authorization at play and only the API layer has been granted.

- The CLI talks straight to the KubeVirt API. When the identity has the `kubevirt.io:view` role bound in `project1`, the API server returns the VM list and the call succeeds end-to-end.
- The web console is a plugin-based application. Before it loads any module — including the Virtualization plugin — it asks the API server which Projects/Namespaces the user can see. If the user has no `view` permission on the Namespace itself, the console gets back an empty Project list and never reaches the point where it would query KubeVirt resources. The Virtualization tab is therefore either invisible or empty.

So the user is missing the **generic** Namespace-scoped `view` role; the KubeVirt-specific `kubevirt.io:view` alone is not enough to make the console render the namespace.

## Resolution

Bind both roles to the user (or, more typically, to the group) in each namespace where they should see VMs through the console:

```bash
# CLI access only — KubeVirt resources visible to virtctl/kubectl
kubectl -n project1 create rolebinding kubevirt-view \
  --clusterrole=kubevirt.io:view \
  --group=group1

# Console access — Namespace shows up in the Project picker
# and the Virtualization tab populates
kubectl -n project1 create rolebinding view \
  --clusterrole=view \
  --group=group1
```

The first binding scopes only to KubeVirt CRDs (VirtualMachine, VirtualMachineInstance, etc.). The second is the standard Kubernetes `view` ClusterRole; it grants read on the namespace's pods, services, configmaps and so on, which is what the console enumerates to decide whether to render the namespace at all.

For a multi-tenant environment, replace `--group=group1` with the IdP group name shared by the tenant's users; new members of the group will then see VMs in the console without further per-user work.

For tighter scoping (read-only access to *only* KubeVirt CRDs and the bare minimum of Namespace metadata), define a custom ClusterRole that grants `get`, `list`, `watch` on `pods`, `services`, `configmaps`, `secrets` (or just `namespaces` if you want the Project picker to render the namespace name), then bind that instead of the broad `view` role.

## Diagnostic Steps

Before re-binding, prove the symptom matches:

1. From a CLI logged in as the affected user, confirm the API permissions are already in place:

   ```bash
   kubectl auth can-i get virtualmachines.kubevirt.io --as=<user> -n project1
   kubectl auth can-i get pods --as=<user> -n project1
   ```

   The first should return `yes`; the second is the one that decides whether the console will list the namespace. If `pods` returns `no`, the console will not show the namespace regardless of any KubeVirt-specific binding.

2. Check existing role bindings in the target namespace:

   ```bash
   kubectl -n project1 get rolebinding -o wide
   kubectl -n project1 get rolebinding -o json | jq -r '
     .items[]
     | select(.subjects[]?.name == "group1")
     | "\(.metadata.name) -> \(.roleRef.kind)/\(.roleRef.name)"'
   ```

   Expect to see only `kubevirt.io:view` listed for `group1`. The fix adds a `view` binding alongside it.

3. After applying the missing binding, have the user reload the console. The Project picker should now list `project1` and the Virtualization tab should populate. If it still does not, clear any cached login (the console caches the user's project list briefly) and re-check `kubectl auth can-i get pods --as=<user> -n project1`.

4. If the cluster runs with strict NetworkPolicy or service-mesh isolation in front of the platform console, also confirm the user's browser can reach the console pod — a 401/403 from the console backend caused by network policy looks the same as a missing RBAC binding from the user's point of view.

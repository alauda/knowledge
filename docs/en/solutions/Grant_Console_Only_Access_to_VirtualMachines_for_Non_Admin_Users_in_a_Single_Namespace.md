---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A common multi-tenant requirement on ACP Virtualization is to let an end user **open a VM's serial console or VNC session** — for day-to-day operations like logging into the guest OS, running `systemd` checks, or observing boot messages — without granting them enough authority to start, stop, reconfigure, or delete the VM itself.

The default cluster roles err on the coarse side. `view` lets a user see the objects but not reach the `/console` and `/vnc` subresources; `edit` or `admin` reach the console but also permit mutating the VM spec, live-migrating it, or deleting it entirely. Neither is a fit for the "support person who needs to SSH into the VM through the platform" persona.

## Resolution

Combine the built-in `view` ClusterRole (for visibility) with a small custom `Role` that grants only the two subresources KubeVirt exposes for interactive console access. Bind both in the target namespace.

This approach works uniformly on ACP Virtualization (in-core `virtualization`, based on upstream KubeVirt) and on any plain-Kubernetes cluster running KubeVirt — the subresource paths are identical.

1. **Grant `view` in the target namespace.** This lets the user list and describe VMs and VMIs, which the web console needs to render the VM page:

   ```bash
   kubectl create rolebinding vm-console-view \
     --clusterrole=view \
     --user=<user-name> \
     -n <namespace>
   ```

   Use `--group=<group-name>` instead of `--user=...` to grant to an OIDC/LDAP group rather than an individual.

2. **Define the console-only Role.** The two KubeVirt subresources for interactive console access are `virtualmachineinstances/console` (serial console) and `virtualmachineinstances/vnc` (VNC framebuffer). The verb for opening a session is `get`, but the way the websocket is established also requires `update`. The rest of the rules (`pods`, `pods/log`, `services`, `endpoints`, `events`) cover the incidental reads the console UI performs while rendering:

   ```yaml
   apiVersion: rbac.authorization.k8s.io/v1
   kind: Role
   metadata:
     name: kubevirt-console-access
     namespace: <namespace>
   rules:
     - apiGroups: ["kubevirt.io"]
       resources:
         - virtualmachines
         - virtualmachineinstances
       verbs: ["get", "list", "watch"]
     - apiGroups: ["subresources.kubevirt.io"]
       resources:
         - virtualmachineinstances/console
         - virtualmachineinstances/vnc
       verbs: ["get", "update"]
     - apiGroups: [""]
       resources:
         - pods
         - pods/log
         - services
         - endpoints
         - events
       verbs: ["get", "list", "watch"]
   ```

   Note what is **absent**: no `create`/`update`/`patch`/`delete` on `virtualmachines` (the user cannot change the spec), no verbs on `virtualmachineinstancemigrations` (cannot live-migrate), no verbs on `virtualmachineinstances` beyond `get/list/watch` (cannot stop or restart). The user's only write capability is to establish a console session.

3. **Bind the custom Role.**

   ```yaml
   apiVersion: rbac.authorization.k8s.io/v1
   kind: RoleBinding
   metadata:
     name: kubevirt-console-access-binding
     namespace: <namespace>
   subjects:
     - kind: User
       name: <user-name>
       apiGroup: rbac.authorization.k8s.io
   roleRef:
     kind: Role
     name: kubevirt-console-access
     apiGroup: rbac.authorization.k8s.io
   ```

   Bind a group instead by substituting `kind: Group` and `name: <group-name>`.

4. **Hand the user the access URL.** On ACP Virtualization the web console exposes the VM page and a built-in console tab; the user will land on an authenticated view of the VM list for the namespace only. Outside the web console, the same permissions are enough to drive `virtctl console <vm>` / `virtctl vnc <vm>` from the command line.

## Diagnostic Steps

Use `kubectl auth can-i` to verify the bindings end-to-end before handing them off:

```bash
# Should return "yes" — user can list VMs in the namespace.
kubectl auth can-i list virtualmachines.kubevirt.io \
  --as=<user-name> -n <namespace>

# Should return "yes" — user can open a serial console session.
kubectl auth can-i get virtualmachineinstances.subresources.kubevirt.io/console \
  --as=<user-name> -n <namespace>

# Should return "no" — user cannot stop or reconfigure the VM.
kubectl auth can-i patch virtualmachines.kubevirt.io \
  --as=<user-name> -n <namespace>

kubectl auth can-i delete virtualmachines.kubevirt.io \
  --as=<user-name> -n <namespace>
```

If the `list virtualmachines` check returns `no`, the `view` RoleBinding from step 1 did not land — check that the namespace and subject match.

If the `get .../console` check returns `yes` but the console session still refuses to open ("permission denied" from the UI), inspect the websocket handshake:

```bash
kubectl -n <namespace> logs deploy/virt-api --tail=50 | grep -i forbidden
```

The most common cause at that point is the user being bound in a different namespace than the VM lives in — Role and RoleBinding are namespace-scoped; cross-namespace bindings do not work. Re-create the binding in the same namespace as the VM.

If the user should get the same permission in more than one namespace, create one `RoleBinding` per namespace (preferred — keeps the blast radius tight), or convert the `Role` into a `ClusterRole` and bind it per-namespace with separate `RoleBinding` objects.

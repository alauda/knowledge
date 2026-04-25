---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A team needs to give an operations group on ACP Virtualization the ability to **power-cycle** virtual machines — start, stop, restart, pause, unpause — without granting the broader edit permissions that would let them resize disks, attach new PVCs, change CPU/memory, or alter the VM template.

The administrator wants:

- A named Kubernetes `Group` (mapped from ACP's identity provider) with the limited permission set.
- The permission scoped to a specific namespace (or set of namespaces), not cluster-wide.
- A clear separation: anything that mutates `spec.template.spec` (disks, CPU, memory, NICs) stays with the application owners; only runtime-state actions are delegated to the ops group.

## Root Cause

KubeVirt models VM lifecycle actions as **subresources** on the `virtualmachines` resource, not as edits to the VM spec:

- Power on: PUT `virtualmachines/start`
- Power off: PUT `virtualmachines/stop`
- Restart: PUT `virtualmachines/restart`
- Pause / unpause: PUT `virtualmachines/pause`, `virtualmachines/unpause`
- Console attach: GET `virtualmachineinstances/console`, `virtualmachineinstances/vnc`

Because subresources are first-class RBAC objects under `subresources.kubevirt.io`, a `Role` can grant **only** the subresource verbs without granting `update` / `patch` on the parent `virtualmachines` resource. That separation is the lever — the ops group gets `update` on the `start`/`stop`/`restart` subresources but never on the VM's `spec`. Disk edits, CPU edits, NIC edits all happen by patching `spec.template.spec` on the VM, which the ops group cannot do.

The other half is binding that `Role` to the right `Group`. ACP maps groups from its identity provider into Kubernetes via `Group` references in `RoleBinding`. The administrator declares the group name once and refers to it from the binding.

## Resolution

### Step 1 — define the group

ACP's identity provider (LDAP, OIDC, SAML, or built-in) is the source of truth for groups. The exact procedure to create the group depends on the IdP — refer to the ACP platform's auth-management docs for the LDAP / OIDC / built-in flow. The output of this step is a stable group name (for example, `vm-operators`) that the cluster sees in the `groups` claim of every member's token.

To verify the group is visible to the API server, log in as a member and check `kubectl auth whoami`:

```bash
kubectl auth whoami -o=jsonpath='{.status.userInfo.groups}'
# Expected: ["system:authenticated", "vm-operators", ...]
```

If `vm-operators` does not appear, the IdP-to-cluster mapping is missing — fix that first before continuing.

### Step 2 — write the Role with subresource-only verbs

Create a `Role` in the namespace where the VMs live. The verbs map cleanly to lifecycle actions:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: vm-power-cycle
  namespace: <vm-namespace>
rules:
  # Read access on the VM and its runtime instance — needed so they can list / show in tools:
  - apiGroups: ["kubevirt.io"]
    resources: ["virtualmachines", "virtualmachineinstances"]
    verbs: ["get", "list", "watch"]

  # Lifecycle subresources — start / stop / restart / pause / unpause:
  - apiGroups: ["subresources.kubevirt.io"]
    resources:
      - virtualmachines/start
      - virtualmachines/stop
      - virtualmachines/restart
      - virtualmachines/pause
      - virtualmachines/unpause
    verbs: ["update"]

  # OPTIONAL: VNC / serial console (read-only — investigation but no power):
  # - apiGroups: ["subresources.kubevirt.io"]
  #   resources:
  #     - virtualmachineinstances/console
  #     - virtualmachineinstances/vnc
  #   verbs: ["get"]
```

Note what is **not** here:

- No `update` / `patch` / `create` / `delete` on `virtualmachines` itself → spec edits and VM deletion are denied.
- No verbs on `persistentvolumeclaims`, `datavolumes`, `secrets`, `configmaps` → they cannot attach storage or change credentials.
- No `*` verb anywhere.

Apply:

```bash
kubectl apply -f vm-power-cycle.role.yaml
```

### Step 3 — bind the Role to the group

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: vm-power-cycle-binding
  namespace: <vm-namespace>
subjects:
  - kind: Group
    name: vm-operators                   # exact group name from Step 1
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: vm-power-cycle
  apiGroup: rbac.authorization.k8s.io
```

```bash
kubectl apply -f vm-power-cycle.rb.yaml
```

For the same permission on multiple namespaces, replicate the `Role` + `RoleBinding` per namespace. For an everywhere-scoped permission (rare for this use case), promote both to `ClusterRole` + `ClusterRoleBinding` — but that drops the namespace boundary, so reserve it for genuinely cluster-wide ops teams.

### Step 4 — verify with `kubectl auth can-i`

Log in as a group member (or use `--as-group=vm-operators --as=test1`) and confirm each verb is allowed or denied as intended:

```bash
NS=<vm-namespace>
USR=test1
GRP=vm-operators

# Should be ALLOWED:
kubectl --as "$USR" --as-group "$GRP" -n "$NS" auth can-i \
  update virtualmachines/start.subresources.kubevirt.io
kubectl --as "$USR" --as-group "$GRP" -n "$NS" auth can-i \
  update virtualmachines/stop.subresources.kubevirt.io
kubectl --as "$USR" --as-group "$GRP" -n "$NS" auth can-i \
  get virtualmachines.kubevirt.io

# Should be DENIED:
kubectl --as "$USR" --as-group "$GRP" -n "$NS" auth can-i \
  update virtualmachines.kubevirt.io                        # spec edit
kubectl --as "$USR" --as-group "$GRP" -n "$NS" auth can-i \
  patch virtualmachines.kubevirt.io
kubectl --as "$USR" --as-group "$GRP" -n "$NS" auth can-i \
  delete virtualmachines.kubevirt.io
kubectl --as "$USR" --as-group "$GRP" -n "$NS" auth can-i \
  create persistentvolumeclaims
```

Each ALLOWED line must print `yes`; each DENIED line must print `no`.

### Step 5 — exercise the actual lifecycle actions

Test the full path (not just RBAC) with `virtctl` from a member's session:

```bash
NS=<vm-namespace>
VM=<vm-name>

virtctl stop "$VM" -n "$NS"
virtctl start "$VM" -n "$NS"
virtctl restart "$VM" -n "$NS"
```

Each command should succeed. Trying anything outside the granted scope should fail with `forbidden`:

```bash
# Should fail:
kubectl -n "$NS" patch vm "$VM" --type=merge -p '{"spec":{"template":{"spec":{"domain":{"resources":{"requests":{"memory":"4Gi"}}}}}}}'
# Expected: Error from server (Forbidden): virtualmachines.kubevirt.io "<vm>" is forbidden:
#   User "test1" cannot patch resource "virtualmachines" in API group "kubevirt.io"
```

### Step 6 — document the boundary

Write down what the `vm-operators` group can and cannot do, and link the doc from the team's runbook. Useful as an audit reference and to head off the inevitable "I need to also …" requests:

```
vm-operators (namespace <ns>):
  ALLOWED: list/get/watch VM and VMI; start, stop, restart, pause, unpause
  DENIED:  edit VM spec, edit disks, attach/detach PVCs,
           change CPU/memory, modify network interfaces,
           create/delete VMs, console access (unless added in optional stanza)
```

If the team later asks for, say, console access, add the commented-out stanza in Step 2's Role and reapply — surface-area changes are explicit, one verb at a time.

## Diagnostic Steps

If a member reports "I cannot stop the VM", verify in this order:

```bash
# 1) Token actually carries the group:
kubectl auth whoami -o=jsonpath='{.status.userInfo.groups}'

# 2) Binding exists in the right namespace:
kubectl -n "$NS" get rolebinding vm-power-cycle-binding -o=yaml | yq '.subjects'

# 3) Role grants the subresource:
kubectl -n "$NS" get role vm-power-cycle -o=yaml | yq '.rules'

# 4) RBAC decision for the exact verb:
kubectl --as <user> --as-group <group> -n "$NS" auth can-i \
  update virtualmachines/stop.subresources.kubevirt.io --v=8 2>&1 | grep -E 'allow|deny|reason'
```

The `--v=8` output shows which Role and which Binding the API server matched. If no match appears, recheck Step 3.

If `kubectl auth can-i` says yes but `virtctl stop` still fails, the failure is in the lifecycle action itself (the VM is in a state that cannot transition, the virt-controller is unhealthy), not in RBAC. Inspect:

```bash
kubectl -n "$NS" get vmi "$VM" -o=jsonpath='{.status.phase}'
kubectl -n kubevirt logs deploy/virt-controller --tail=100 | grep "$VM"
```

Common transient failures: VM in `Migrating` state cannot stop until migration finishes; VM with stuck PVC unbinding cannot stop until the unmount completes. Neither is an RBAC issue.

If you need to grant the same permission to many groups, prefer one `ClusterRole` (defined once) with many `RoleBindings` (one per namespace × group pair) over many copies of the same `Role`. The `ClusterRole` + namespace-scoped `RoleBinding` pattern keeps the verb set in one place.

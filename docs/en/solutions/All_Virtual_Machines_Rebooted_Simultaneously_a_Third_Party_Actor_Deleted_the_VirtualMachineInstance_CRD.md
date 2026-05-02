---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# All Virtual Machines Rebooted Simultaneously — a Third-Party Actor Deleted the VirtualMachineInstance CRD
## Issue

At a single moment in time every running VM across the cluster shuts down cleanly and restarts, with no node-level symptom to explain it:

- Multiple production worker nodes host affected VMs; **every VM on every node** goes down together.
- No node rebooted. Kubelet, containerd, and the kernel are healthy — no crash, no panic.
- The VM guest OS logs show a graceful shutdown. A Linux guest records an **ACPI Power Button** event, systemd receives SIGTERM, sshd terminates — i.e. something on the host asked the VM to power off politely.
- No user action ran a `virtctl stop`, a `VirtualMachine/stop` API call, or any other deliberate VM shutdown.

The outage appears as an infrastructure incident (mass VM reboot) but the infrastructure below the VMI layer was healthy throughout.

## Root Cause

The trigger is the deletion of the `virtualmachineinstances.kubevirt.io` **CustomResourceDefinition** itself, not the VMI objects it owns.

A VMI object is the live-running representation of a VM — one VMI per running VM, backed by a virt-launcher pod and a QEMU process. Deleting the CRD removes every object of that kind from the API server in a single etcd transaction. The controller chain that follows:

1. `virt-handler` watches VMIs on every node. When its informer list loses every VMI, it treats each as deleted.
2. For each deleted VMI, virt-handler initiates graceful termination of the virt-launcher pod.
3. virt-launcher asks QEMU to perform a guest-driven shutdown — an ACPI Power Button event is injected into the VM.
4. The guest OS receives the power event, runs its shutdown sequence, and exits.
5. If a `VirtualMachine` object with `runStrategy: Always` still exists, its controller immediately recreates the VMI as soon as the CRD is re-registered, and the VM powers back on.

The key handoff is that **the whole fleet is tied to one CRD object**. Any actor that holds `delete customresourcedefinitions.apiextensions.k8s.io` permission can take every VMI down simultaneously, regardless of per-VM RBAC. Common sources:

- A **backup or data-protection integration** that enumerates CRDs, "backs up" their schema, then deletes and re-creates them as part of a restore or schema-migration routine. Field-seen examples: Commvault, legacy Velero recipes that treat CRDs as regular objects, home-grown controllers that replicate schemas between clusters.
- A CI pipeline with an over-broad cluster-admin token performing a dry-run `kubectl apply --force --prune` against a subset that accidentally includes CRD scope.

The kube-apiserver audit log is the only reliable source of truth for who deleted the CRD — the VMI objects disappear too fast for an operator to catch.

## Resolution

### Step 1 — confirm the CRD exists and is healthy now

Unless the attacker (or the integration that performed the delete) has restored the CRD, VMs are still down. Check:

```bash
kubectl get crd virtualmachineinstances.kubevirt.io -o=jsonpath='{.metadata.creationTimestamp}'
```

A timestamp that matches the outage window confirms the CRD was deleted-then-recreated around that time; the `generation: 1` value confirms it is a fresh object.

```bash
kubectl get crd virtualmachineinstances.kubevirt.io -o yaml | \
  grep -E 'creationTimestamp|generation:'
```

If the CRD is missing, re-install it via the KubeVirt operator — never hand-apply a raw CRD yaml, because the operator-installed schema carries conversion webhooks and owner references that a hand-applied copy does not.

```bash
# The KubeVirt operator reconciles the CRD on a KubeVirt CR change. Touch it
# to trigger a reconcile:
kubectl get kubevirt -A -o name | head -1 | xargs -I{} kubectl annotate {} \
  reconcile-trigger="$(date +%s)" --overwrite
```

### Step 2 — identify every affected VM

With the CRD back, the VMs whose `VirtualMachine.runStrategy: Always` (or `RerunOnFailure`) will be auto-recreated. VMs with `runStrategy: Manual` remain stopped until explicitly restarted.

```bash
# VMs that are defined but currently have no matching VMI:
kubectl get vm -A -o=jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}  runStrategy={.spec.runStrategy}  status={.status.printableStatus}{"\n"}{end}' | \
  grep -v Running
```

For each VM in `Stopped` state whose owner intends it to be running, issue:

```bash
virtctl start <vm-name> -n <ns>
```

(or the equivalent `VirtualMachine` spec toggle if your platform provides a higher-level start API).

### Step 3 — find the actor from the audit log

The verb-level proof is in the apiserver audit log. Filter for a `delete` on the CRD resource with the exact name:

```bash
# Path varies by deployment; common locations:
#   node-local:     /var/log/kube-apiserver/audit.log
#   aggregated:     whatever Loki/LogCenter ships to
# Example jq filter:
cat audit.log | jq -c 'select(
  .verb == "delete" and
  .objectRef.resource == "customresourcedefinitions" and
  .objectRef.name == "virtualmachineinstances.kubevirt.io"
)' | head -5
```

A typical incident shows three audit events within a few seconds:

1. `list` on `customresourcedefinitions?fieldSelector=metadata.name=virtualmachineinstances.kubevirt.io` — the actor first read the schema.
2. `delete` on the same CRD — the impacting action.
3. `create` on `customresourcedefinitions` with the same name — the actor "restored" the CRD from a bespoke copy (not via virt-operator).

All three share a `user.username` field. In the field-seen Commvault incident this was `system:serviceaccount:commvault:cvadmin`, bound to `cluster-admin`.

### Step 4 — revoke or scope the actor

Once the ServiceAccount (or user, or OIDC principal) is known, reduce their permissions so the same action cannot recur:

```bash
# Inspect the ClusterRoleBinding that grants admin-level access:
kubectl get clusterrolebinding -o=jsonpath='{range .items[*]}{.metadata.name}{" "}{.roleRef.name}{"\n"}{end}' | \
  grep cluster-admin
```

The backup integration almost certainly does not need `delete customresourcedefinitions` — that permission level is meant for operator lifecycle, not for data protection. Define a purpose-specific Role that grants only what the backup actually needs (typically `get`, `list`, and for Velero-style backups `create` on selected resource kinds), and rebind the ServiceAccount.

### Step 5 — contact the third-party owner

The behaviour of "list a CRD, delete it, re-create from a saved copy" is documented as a backup/restore pattern in several commercial products. Their support will usually acknowledge the pattern and point you at a configuration flag to exclude CRDs from the backup scope — this is normally the correct resolution rather than modifying the product's behaviour in your cluster.

### Step 6 — add an audit rule to catch the next attempt

Prevent recurrence by adding a dedicated audit filter that records **every** delete on a VM-family CRD at `RequestResponse` level, so the next occurrence is immediately visible rather than rebuilt from Metadata-level records after the fact:

```yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  - level: RequestResponse
    verbs: ["delete"]
    resources:
      - group: apiextensions.k8s.io
        resources: ["customresourcedefinitions"]
        resourceNames:
          - virtualmachineinstances.kubevirt.io
          - virtualmachines.kubevirt.io
          - virtualmachineinstancemigrations.kubevirt.io
```

Apply via the cluster's audit-policy mechanism (usually a control-plane configuration change). Pair this with an alert that fires on any hit.

## Diagnostic Steps

Confirm the guest-side graceful-shutdown signature. If the guest OS logs show a power-button event and a clean unit shutdown, the VMs did **not** crash — something asked them to stop:

```text
Jan 27 15:45:49 vm02 systemd-logind[964]: Power key pressed.
Jan 27 15:45:49 vm02 systemd-logind[964]: Powering Off...
Jan 27 15:45:49 vm02 sshd[1190081]: Received signal 15; terminating.
```

Correlate with the virt-handler log on the worker nodes during the outage window:

```bash
NODE=<worker-node-name>
kubectl logs -n <kubevirt-ns> -l kubevirt.io=virt-handler --field-selector spec.nodeName="$NODE" --since=30m | \
  grep -E 'Signaled graceful shutdown|grace period|VMI deleted'
```

A log line of the shape `{"component":"virt-handler","name":"vm02","msg":"Signaled graceful shutdown"}` for **every** VM on the node within the same second is the virt-handler reacting to the CRD deletion.

Check the CRD metadata — a recent `creationTimestamp` and `generation: 1` together mean the CRD was replaced, not just modified:

```bash
kubectl get crd virtualmachineinstances.kubevirt.io -o yaml | \
  grep -E 'creationTimestamp|generation:'
```

Example values after the incident:

```yaml
creationTimestamp: "2026-01-27T10:47:37Z"
generation: 1
```

If your cluster has API audit centralisation (Loki / LogCenter / etc.), query the aggregated audit stream for the `delete`/`create` pair on the CRD and the shared `user.username`. That single query answers Step 3 without needing to pull individual node logs.

Finally, cross-check whether the owner is `virt-operator` or a third party. Legitimate CRD re-creation by the KubeVirt operator comes from `system:serviceaccount:<ns>:kubevirt-operator`. Anything else — especially a ServiceAccount in a namespace named after a commercial product — is the actor to engage with.

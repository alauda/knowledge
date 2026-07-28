---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Whereabouts logs "IPAM conf mismatch" when network_name is unset on multiple NADs
## Issue

The Whereabouts controller logs the following error in a loop, even though
the cluster's pods on the affected secondary networks appear to be running
correctly:

```text
error syncing '<ns>/<nad-name>': found IPAM conf mismatch for
network-attachment-definitions with same network name, requeuing
```

The error fires whenever there is more than one
`NetworkAttachmentDefinition` (NAD) using Whereabouts as its IPAM and the
NADs do not declare an explicit `ipam.network_name`. The controller
requeues forever and produces noise that buries any real reconciliation
errors.

## Root Cause

Whereabouts identifies an IP allocation pool by the `ipam.network_name`
field, **not** by the NAD's name. The reconciler walks every NAD that uses
the Whereabouts IPAM type and groups them by `network_name`, then verifies
that the IPAM configuration of every NAD in the same group matches.

When `network_name` is omitted, the field defaults to an empty string. All
NADs in the cluster that omit the field therefore land in the same group
keyed on `""`. If those NADs declare different IP ranges, prefixes, or
gateways — which is the normal case when each secondary network has its
own subnet — the comparison fails and the reconciler emits the
mismatch error for every pair in that group.

The data plane keeps working because the per-pod IP allocation still uses
the local NAD's IPAM block; the controller's mismatch detection is purely
a reconciliation-level check. The error is therefore harmless to running
pods but noisy in logs and in alerting that gates on Whereabouts
controller errors.

## Resolution

Give every NAD that uses Whereabouts an explicit, unique
`ipam.network_name`. Pick a name that reflects the network the NAD
represents — typically the same string used for `metadata.name`, or a
shorter team-prefixed identifier:

```json
{
  "cniVersion": "0.3.1",
  "type": "macvlan",
  "master": "ens5",
  "ipam": {
    "type": "whereabouts",
    "network_name": "team-a-public",
    "range": "192.0.2.0/24"
  }
}
```

Embed that JSON in the NAD `spec.config`:

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: team-a-public
  namespace: team-a
spec:
  config: '{"cniVersion":"0.3.1","type":"macvlan","master":"ens5","ipam":{"type":"whereabouts","network_name":"team-a-public","range":"192.0.2.0/24"}}'
```

Apply the change for every NAD that previously omitted `network_name`,
then restart the Whereabouts controller so it re-evaluates the
configuration:

```bash
kubectl rollout restart deployment whereabouts-controller -n <multus-ns>
```

The mismatch errors stop within the first reconcile interval after the
restart.

A note on existing IP allocations: changing `network_name` on a NAD that
already has live pods using IPs from its range can shift those pods into
a different IP allocation pool from the controller's point of view.
Whereabouts may not see a previously assigned IP as in-use under the new
name, which raises a small risk of duplicate assignment. The safe order
is:

1. Drain or delete the pods on the NAD whose `network_name` is being set.
2. Update the NAD with the new `network_name`.
3. Recreate the pods so they take fresh IP assignments under the new
   pool name.

For a NAD that has never had pods on it (a brand new attachment, or one
freshly cleaned up), the change is risk-free.

## Diagnostic Steps

1. Identify all NADs that use Whereabouts:

   ```bash
   kubectl get net-attach-def -A -o json \
     | jq -r '.items[] | select(.spec.config | fromjson | .ipam.type == "whereabouts") | "\(.metadata.namespace)/\(.metadata.name)"'
   ```

2. For each, check whether `network_name` is set:

   ```bash
   kubectl get net-attach-def <name> -n <ns> -o json \
     | jq -r '.spec.config | fromjson | .ipam.network_name // "(unset)"'
   ```

   `(unset)` results are the candidates that contribute to the mismatch.

3. Confirm the controller stops emitting the error after the change:

   ```bash
   kubectl logs -n <multus-ns> deploy/whereabouts-controller \
     --since=2m | grep -i "IPAM conf mismatch"
   ```

   Empty result confirms the issue is resolved.

4. Spot-check that pods on a representative NAD still receive valid IPs
   from the expected range:

   ```bash
   kubectl get pod <pod> -n <ns> -o jsonpath='{.metadata.annotations.k8s\.v1\.cni\.cncf\.io/networks-status}' | jq .
   ```

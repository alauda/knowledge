---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A hosted-control-plane (HCP) cluster is asked to upgrade its NodePool to a
new platform version. The NodePool reports `Updating` but no node is ever
upgraded:

```text
- lastTransitionTime: "..."
  message: 'Nodepool update in progress. Target Config version: ed87300a.
            Total Nodes: 3. Upgraded: 0'
  observedGeneration: 30
  reason: AsExpected
  status: "True"
```

Worker nodes are all `Ready` and joined; the cluster is healthy enough to
serve workloads but does not progress through the upgrade.

## Root Cause

The HCP control plane provisions the new node set by deploying short-lived
infrastructure pods on the management cluster — node-bootstrap helpers,
ignition fetchers, machine-image servers, and the like. Those pods
legitimately require elevated privileges (host PID/IPC/network namespace
access, hostPath mounts into `/etc` or `/var/lib`, the `privileged` security
context, allowed privilege escalation) to write boot artefacts and to drive
the new node through its bring-up sequence.

When the management cluster also runs the StackRox runtime-security agent
(the StackRox / Container Security operator) with a policy in **enforce**
mode that denies privileged-container creation, the StackRox admission
webhook intercepts those infrastructure pods and refuses them. The pods
never start, the upgrade controller has no driver for the node bring-up
sequence, and the NodePool stays stuck at `Upgraded: 0` indefinitely.

The same pattern applies to any admission policy that hard-denies
privileged pods globally — Kyverno policies, gatekeeper constraints, OPA
rules, custom validating webhooks. The fingerprint is always the same: the
NodePool spins, no nodes actually upgrade, and the management-cluster audit
log shows the platform pods being rejected at admission time.

## Resolution

Scope the runtime-security policy so it does not block the HCP control
plane's own infrastructure namespaces. There are three escalating options
in order of preference:

### Option A (recommended) — namespace-scoped exclusion

Identify the namespace pattern the HCP control plane uses for its
infrastructure pods (`hosted-cluster-*`, `hcp-*`, or whatever the hosted
cluster name templated). Add that pattern to the StackRox policy's
exclusion / deployment-scope list so the policy still enforces against
user workloads but skips the HCP control-plane infra pods:

```yaml
# StackRox policy — deployment-scope exclusion fragment
exclusions:
  - name: "hcp-control-plane-infra"
    deployment:
      scope:
        namespace: "hosted-cluster-.*"
```

This is the safest option: enforcement remains in place for everything
that is not part of the HCP machinery.

### Option B — switch the policy to `inform` mode

If a scoped exclusion is impractical, drop the policy from `enforce` to
`inform`. Admission stops being blocking; the policy still emits violation
events for review. Restore `enforce` after the upgrade completes.

### Option C — temporarily disable the policy

A last-resort workaround when neither of the above is available. Disable
the privileged-container policy altogether for the duration of the
upgrade, then re-enable.

After the policy is adjusted, the platform infrastructure pods admit
cleanly, the NodePool's bring-up controller drives each node through the
upgrade sequence, and `Upgraded: <n>` advances toward `Total Nodes`.

## Diagnostic Steps

1. Confirm the upgrade controller is healthy. Inspect the NodePool resource
   on the management cluster:

   ```bash
   kubectl get nodepool <name> -n <hcp-ns> -o yaml | yq '.status'
   ```

   `Upgraded: 0` for an extended period with no error condition is the
   characteristic stall.

2. Inspect the hosted control plane namespace for events suggestive of
   admission rejection:

   ```bash
   kubectl get events -n <hcp-ns> --sort-by=.lastTimestamp | tail -50
   ```

   Look for `FailedCreate` events on Deployments / Jobs with messages such
   as `admission webhook "..." denied the request`.

3. Confirm an admission policy is the cause. Identify the rejecting webhook
   in the event message and inspect its policy:

   ```bash
   kubectl get validatingwebhookconfigurations
   ```

4. Inspect the StackRox (or other policy-engine) violation log for the
   relevant timeframe and confirm rejected platform pods are present.

5. After the policy is adjusted, watch the NodePool advance:

   ```bash
   kubectl get nodepool <name> -n <hcp-ns> -w
   ```

   `Upgraded` should increase by one each time a node finishes its
   bring-up.

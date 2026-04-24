---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After upgrading the migration toolkit operator (Forklift / MTV style) from a 2.9.x release to a 2.10.x release, the `forklift-cli-download` pod — a small helper pod the toolkit runs to let operators download its CLI binary — enters `CrashLoopBackOff`. The pod is terminated repeatedly by the kernel OOM-killer:

```yaml
containerStatuses:
  - name: forklift-cli-download
    ready: false
    lastState:
      terminated:
        exitCode: 137
        reason:   OOMKilled
        finishedAt: "..."
    resources:
      limits:   { cpu: 100m, memory: 128Mi }
      requests: { cpu: 50m,  memory: 64Mi }
```

The resource limit (`memory: 128Mi`) is lower than the working set the post-upgrade binary needs at start-up, so the kernel kills it during initialisation. Every attempt to hand-edit the `Deployment` to raise `limits.memory` works for seconds — and then the toolkit operator reconciles the Deployment back to its canonical spec, which has the same 128Mi limit. The reconcile loop keeps the limit tight regardless of user edits.

A cluster alert accompanies the crash: `forklift-cli-download has not matched the expected number of replicas`.

## Root Cause

The toolkit's operator owns the `Deployment` for the CLI download pod and reconciles its `resources` block from a hard-coded template. The 2.9.x → 2.10.x upgrade bumped the binary shipped inside the pod (different build, different startup working set) but did not increase the Deployment's resource limits in parallel — the old 128Mi limit that was comfortably above the old binary's working set is now below the new binary's.

Because the Deployment is operator-managed, every direct `kubectl patch` against the Deployment (or against the underlying template in whatever the operator exposes) is reverted on the next reconcile tick. Users see:

1. `kubectl patch deployment forklift-cli-download ... memory=512Mi` → pod rolls with 512Mi, briefly runs.
2. Operator reconcile tick (typically within a minute) → Deployment's memory reverts to 128Mi.
3. Rollout starts, new pods lose the OOM budget, CrashLoop resumes.

The cycle is deterministic; no direct edit to the Deployment or the pod is stable.

The correct fix is at the operator's own configuration surface — either a `ForkliftController` CR (or whichever top-level CR the toolkit exposes) has a field for overriding the CLI pod's resources, or a newer operator release carries the corrected template. The bug is tracked; fix status depends on the toolkit's release notes.

## Resolution

### Preferred — upgrade the toolkit operator to a release where the limits are adequate

The tracked fix adjusts the Deployment template so the 2.10.x binary's working set fits. Follow the operator-upgrade channel to the release that carries the fix. After the upgrade, the CLI pod reaches `Ready` within its first reconcile.

Verify:

```bash
kubectl -n <forklift-ns> get csv -o custom-columns='NAME:.metadata.name,VERSION:.spec.version'
kubectl -n <forklift-ns> get pod -l app=forklift-cli-download
# forklift-cli-download-<hash>   1/1   Running   0   3m
```

No more OOMKilled events on the pod over a full reconcile cycle confirms the fix took.

### Workaround — override resources via the ForkliftController CR

Recent operator builds expose a spec field on the `ForkliftController` (or equivalent top-level CR) that lets operators set resource overrides for the managed Deployments. The exact field path varies by release; common locations include:

```yaml
apiVersion: forklift.konveyor.io/v1beta1
kind: ForkliftController
metadata:
  name: forklift-controller
  namespace: <forklift-ns>
spec:
  controller_cli_resources:            # name varies — check CRD schema
    limits:
      memory: 512Mi
      cpu:    100m
    requests:
      memory: 256Mi
      cpu:    50m
```

Verify by inspecting the CRD's schema to find the right path:

```bash
kubectl get crd forkliftcontrollers.forklift.konveyor.io -o json | \
  jq '.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties | keys'
```

If a field that looks like a resources override exists for the CLI download component, set it; the operator renders the Deployment with the new values and stops reverting.

### Workaround — suppress the alert, accept the unavailable component

The CLI-download pod serves a single purpose: letting users download the toolkit's CLI binary. If the cluster has alternative distribution channels for the CLI (internal artifact repo, bundled in a different container image), the CrashLoop is functionally tolerable until the upgrade arrives. Silence the accompanying alert:

```yaml
# Alertmanager silence
matchers:
  - name: alertname
    value: KubeDeploymentReplicasMismatch
  - name: deployment
    value: forklift-cli-download
startsAt: ...
endsAt:   ...
comment: "Known OOM bug in <operator-version>; tracked upstream. Silence until upgrade."
```

Short-lived; re-evaluate when the operator upgrade lands.

### Do not

- **Do not patch the Deployment directly.** The operator reverts the patch. Every edit is a hall of mirrors — it looks applied, then reverts, which masks whether the change helped.
- **Do not scale the Deployment to zero replicas.** That silences the alert but stops the CLI from being served to users, which may break other tooling that expects the endpoint.

## Diagnostic Steps

Confirm the OOM signature is on the specific pod:

```bash
NS=<forklift-ns>
POD=$(kubectl -n "$NS" get pod -l app=forklift-cli-download \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$NS" describe pod "$POD" | grep -A5 -E 'Last State|Reason|Exit Code'
```

`OOMKilled` with `exitCode: 137` and `Last State: Terminated` pattern is the symptom.

Verify the operator is reverting limit patches. Edit the Deployment (reversibly, for diagnostic only):

```bash
kubectl -n "$NS" patch deployment forklift-cli-download \
  --type=merge -p '{"spec":{"template":{"spec":{"containers":[{"name":"forklift-cli-download","resources":{"limits":{"memory":"512Mi"}}}]}}}}'

# Wait 60 seconds then check the rendered spec.
sleep 60
kubectl -n "$NS" get deployment forklift-cli-download -o jsonpath='{.spec.template.spec.containers[0].resources.limits.memory}{"\n"}'
# If it still says 128Mi, the operator reverted.
```

A reverted patch confirms the operator-managed nature of the Deployment; the fix has to be through the CR (workaround) or the upgrade (preferred), not hand-patching.

Read the toolkit operator's log for reconcile activity on the Deployment:

```bash
kubectl -n "$NS" logs -l name=forklift-operator --tail=200 | \
  grep -iE 'cli-download|Deployment.*forklift' | tail -20
```

Lines about reconciling the Deployment back to its desired state confirm the operator is authoritative.

After the fix (upgrade or CR override), monitor the pod's stability across a meaningful window — the first minute after the fix rolls should show `Running` with `restartCount` stable, and no further OOM events through a business day.

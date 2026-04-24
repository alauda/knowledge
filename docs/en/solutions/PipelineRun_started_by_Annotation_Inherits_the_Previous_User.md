---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Re-triggering a Pipeline through the console action that re-runs the most recent invocation produces a PipelineRun whose `started-by` annotation lists the **previous** invoker rather than the currently logged-in user. The PipelineRun executes correctly and finishes Succeeded, but downstream audit and chargeback that key off that annotation attribute the run to the wrong identity.

A reproduction looks like this:

```text
NAME                                  SUCCEEDED   REASON      STARTTIME
user-identity-test-pipeline-lualln    True        Succeeded   2m55s
user-identity-test-pipeline-ua4luq    True        Succeeded   6m15s
user-identity-test-pipeline-ycmy3o    True        Succeeded   2m14s
```

The first run is started by `admin` from the console. After logging out and back in as `testuser`, clicking *re-run last* creates a new PipelineRun whose annotation still reads:

```yaml
metadata:
  annotations:
    chains.tekton.dev/signed: "true"
    pipeline.acp.io/started-by: admin
```

A direct *Start* (not *re-run*) by `testuser` annotates correctly:

```yaml
metadata:
  annotations:
    chains.tekton.dev/signed: "true"
    pipeline.acp.io/started-by: testuser
```

## Root Cause

The console *re-run last* action constructs the new PipelineRun by deep-copying the previous PipelineRun's metadata and stripping only the obviously-unique fields (name, UID, status). The `started-by` annotation was treated as plain user metadata and copied verbatim, so the new PipelineRun inherits the prior invoker rather than being re-stamped with the bearer token of the user actually triggering the action.

Upstream tracks this as a defect in the Pipelines distribution. The fix re-evaluates `started-by` from the current request's authenticated user at clone time and is shipped in Pipelines 1.19+.

## Resolution

ACP delivers Tekton through the `devops` capability area. The fix is consumed via a platform-managed Pipelines version bump rather than per-PipelineRun configuration:

1. **Confirm the running Pipelines version.** From the platform's `devops` page, check the installed Pipelines bundle. If it is older than 1.19, schedule the upgrade through the platform — do not hand-patch the Pipelines components.

   ```bash
   kubectl -n tekton-pipelines get deploy tekton-pipelines-controller \
     -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
   ```

2. **Upgrade Pipelines through the platform's `devops` surface.** The upgrade redeploys the controller, webhook, and any Chains/Triggers components together so signing keys and hooks stay consistent. Restarting only the controller without bumping the bundle leaves CRD versions out of sync.

3. **Workaround until the upgrade lands.** Treat *re-run last* as untrusted for audit purposes. Either:

   - require operators to use *Start* (which always populates the current user) instead of *re-run last*; or
   - drive re-runs through `kubectl create -f` against a freshly templated PipelineRun, which produces a clean annotation set; or
   - add an admission policy (Kyverno or Gatekeeper) that overwrites the `started-by` annotation on PipelineRun create with the request username from the AdmissionReview, so the annotation is normalised regardless of how the resource was authored.

4. **Re-validate audit downstream.** After the upgrade, re-run the same scenario (admin starts, logout, testuser hits *re-run last*) and confirm the new PipelineRun annotation matches `testuser`. Check that any chargeback or signing pipeline that consumes the annotation still parses the new value.

## Diagnostic Steps

Inspect the offending annotation on a recent re-run:

```bash
kubectl -n <ns> get pipelinerun <name> \
  -o jsonpath='{.metadata.annotations}' | jq '."started-by" // .'
```

Compare with the AdmissionReview-recorded user. If the platform records audit events for resource creation, look up the userInfo the API server saw for the create call:

```bash
kubectl -n <ns> get pipelinerun <name> \
  -o jsonpath='{.metadata.managedFields[?(@.operation=="Apply")].manager}{"\n"}'
```

If the manager string corresponds to the console process and the annotation does not match the impersonated user, the bug is reproduced. Re-run with a fresh `kubectl create -f` and verify that the same annotation now reflects the kubectl user — that confirms the bug is in the console clone path, not in admission or in the controller.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Triggering an ad-hoc Job from an existing CronJob (the standard "run it now" pattern) fails with a RESTMapping error similar to:

```text
error: failed to create job: jobs.batch "curator-now" is forbidden:
cannot set blockOwnerDeletion in this case because cannot find RESTMapping
for APIVersion apps/v1 Kind CronJob: no matches for kind "CronJob"
in version "apps/v1"
```

The CronJob itself is healthy and continues to fire on its own schedule; only the manual `kubectl create job <name> --from=cronjob/<name>` invocation fails.

## Root Cause

`kubectl create job --from=cronjob/<name>` constructs the new Job and sets an `ownerReference` back to the source CronJob. To do that safely, it asks the API server to resolve the CronJob's `apiVersion`/`kind` pair via the discovery cache and then writes that pair into the Job's `metadata.ownerReferences[].apiVersion`.

In affected client versions, the `apiVersion` recorded on the owner reference is `apps/v1` rather than the correct `batch/v1` (or, on older clusters, `batch/v1beta1`). The API server then refuses to create the Job because the apiserver has no `apps/v1` registration for the kind `CronJob` — that kind has only ever lived under the `batch` group. The error message is exactly that mismatch: `no matches for kind "CronJob" in version "apps/v1"`.

This is purely a client-side bug; the CronJob, the Job spec, and the API server are all behaving correctly. The fix is to rewrite the bad `apiVersion` on its way to the API server, or to use a kubectl version that does not have the bug.

## Resolution

### Preferred: upgrade the kubectl client

The defect was a `kubectl create job --from=cronjob/...` regression in specific client builds, and it has been fixed in current upstream kubectl. Confirm the client version with:

```bash
kubectl version --client -o yaml
```

If the client predates the fix, install a current `kubectl` (the binary is independent of the cluster — any v1.x client within one minor release of the server is supported). After upgrading, retry the original command:

```bash
kubectl -n <namespace> create job <run-name> \
  --from=cronjob/<cronjob-name>
```

### Workaround: rewrite the apiVersion on the way through

Where the client cannot be replaced (CI pipelines pinned to an older binary, restricted bastions), generate the Job manifest with `--dry-run`, fix the `apiVersion` in flight with `sed`, and apply the corrected document. For a cluster that exposes CronJob under `batch/v1` (the modern, stable group):

```bash
NS=<namespace>; CJ=<cronjob-name>; RUN=<run-name>
kubectl -n "$NS" create job "$RUN" --from=cronjob/"$CJ" \
  --dry-run=client -o yaml \
  | sed 's|apiVersion: apps/v1|apiVersion: batch/v1|' \
  | kubectl -n "$NS" apply -f -
```

For very old clusters where CronJob is still served at `batch/v1beta1`, substitute that string in the `sed` expression instead. Confirm the served version on the cluster first:

```bash
kubectl api-resources | grep -i cronjob
```

The `APIVERSION` column tells which group/version to substitute in.

### One-off alternative: hand-craft the Job

For occasional, scripted runs, skip `--from=cronjob/` entirely and copy the relevant fields out of the CronJob into a standalone Job manifest:

```bash
NS=<namespace>; CJ=<cronjob-name>
kubectl -n "$NS" get cronjob "$CJ" -o json \
  | jq '{
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name: ("\(.metadata.name)-manual-\(now|tostring|.[0:10])"),
                    namespace: .metadata.namespace },
        spec: .spec.jobTemplate.spec
      }' \
  | kubectl -n "$NS" apply -f -
```

This produces a Job with no `ownerReference` back to the CronJob, which side-steps the bad RESTMapping entirely. The trade-off: the CronJob's `successfulJobsHistoryLimit` does not garbage-collect the manual run, so prune it explicitly when finished.

## Diagnostic Steps

Confirm what `kubectl` actually wrote into the failing manifest before the API server rejected it:

```bash
kubectl -n <namespace> create job <run-name> \
  --from=cronjob/<cronjob-name> \
  --dry-run=client -o yaml \
  | grep -A2 ownerReferences
```

A buggy client emits `apiVersion: apps/v1` in the owner reference; a correct client emits `apiVersion: batch/v1`. The fix path is determined by which one appears here.

To verify the cluster's CronJob serving version (which dictates which value `sed` should substitute):

```bash
kubectl get --raw /api/v1 \
  | jq '.resources[] | select(.kind=="CronJob")'
kubectl get --raw /apis \
  | jq '.groups[] | select(.name=="batch") | .preferredVersion'
```

Modern clusters return `batch/v1` as the preferred version; clusters still on the legacy beta will return `batch/v1beta1`. Match the workaround `sed` accordingly.

If after the workaround the Job is created but immediately fails with `serviceaccount "<name>" not found`, the CronJob's `jobTemplate.spec.template.spec.serviceAccountName` does not exist in the target namespace — the original CronJob was probably created in a different namespace, or the SA was pruned. Recreate the SA, or set `--from=cronjob/<name>` against a CronJob in the namespace where the SA actually lives.

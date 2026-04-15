---
products: 
   - Alauda Container Platform
kind:
   - Solution
ProductsVersion:
   - 4.x
id: KB260400002
---
# Cluster Image Registry Cleanup: Administrator Guide for Manual and Scheduled Tasks

## Introduction

This document describes the administrative procedures for pruning images from the **internal registry** of a target ACP cluster. It covers both immediate manual execution and recurring automated execution through a Kubernetes `CronJob`.

The goals of this solution are:

- Safely remove images that are no longer used by the cluster.
- Control cleanup behavior with retention time, revision count, and whitelist rules.
- Start with a dry run, then perform confirmed cleanup only after validation.
- Trigger registry garbage collection (GC) when required.
- Configure scheduled tasks for recurring automatic cleanup.

## Terminology

This document uses the following terms consistently:

- **Internal registry**: the image registry deployed and managed as part of the target ACP cluster.
- **Registry endpoint**: the HTTP(S) endpoint that `ac adm prune images` uses to communicate with the registry.
- **External registry endpoint**: a manually specified registry endpoint provided through `--registry-url` when automatic detection of the internal registry endpoint is unavailable or unsuitable.

Unless otherwise stated, image pruning in this document targets the **internal registry** of the current cluster.

## Prerequisites

- ACP CLI (`ac`) is installed.
- You have administrative privileges on the target ACP cluster.
- You can access the target cluster.
- You can access the internal registry of the target cluster.
- If running inside a Pod or CronJob:
  - `serviceAccountName` must be configured.
  - The ServiceAccount must have permissions to inspect workloads, access registry APIs, and, if GC is enabled, access the `image-registry` Pod exec endpoint.

## Architecture Overview

```text
┌────────────────────┐
│ CronJob / Job / Pod│
│ ac adm prune images│
└─────────┬──────────┘
          │
          │ scan in-use images
          ▼
┌────────────────────┐
│ Kubernetes API     │
│ Pods/Deployments...│
└─────────┬──────────┘
          │
          │ fetch registry metadata
          ▼
┌────────────────────┐
│ Image Registry API │
│ repos/tags/digests │
└─────────┬──────────┘
          │
          │ filter and delete manifests
          ▼
┌────────────────────┐
│ Prune Result       │
│ (Optional GC)      │
└────────────────────┘
```

## Default Behavior

All parameters are optional. By default, `ac adm prune images` runs in **dry-run mode**. In this mode, the command evaluates cluster image usage, queries registry metadata, and prints prune candidates, but it does **not** delete any image manifests.

Actual deletion is performed only when `--confirm` is explicitly specified.

## Parameter Reference

| Parameter | Purpose | Typical example |
|-----------|---------|-----------------|
| `--keep-younger-than=<duration>` | Keep recently created images | `168h` |
| `--keep-tag-revisions=<N>` | Keep the latest N revisions per repository | `5` |
| `--all` | Ignore retention-based filters and prune all unused images. Whitelist rules still apply. | `--all` |
| `--whitelist=<regex>` | Exclude repositories matching the regular expression from pruning. Repeatable; any match protects the repository. | `^cpaas-system/.*` |
| `--dry-run` | Run in inspection mode and print prune candidates without deleting anything. This is the default behavior. | `--dry-run` |
| `--confirm` | Perform actual deletion of eligible image manifests. Without this flag, no deletion is performed. | `--confirm` |
| `--prune-registry` | Trigger registry garbage collection after pruning in non-dry-run mode. This flag has no effect in dry-run mode. | `--prune-registry` |
| `--registry-url=<url>` | Override automatic registry endpoint detection with a manually specified endpoint. | `http://image-registry.cpaas-system` |

## Parameter Rules and Constraints

The following rules apply when combining pruning parameters:

- `--confirm` is required for actual deletion. Without `--confirm`, the command only reports prune candidates.
- `--dry-run` and `--confirm` represent mutually exclusive execution intent. In practice, use dry-run for inspection and `--confirm` for deletion.
- `--all` instructs the command to ignore retention-based filters such as `--keep-younger-than` and `--keep-tag-revisions`, and to prune all images that are not currently in use, subject to whitelist rules.
- `--whitelist=<regex>` protects matching repositories from pruning. It can be specified multiple times. If a repository matches any whitelist rule, it is excluded from deletion.
- `--prune-registry` is meaningful only in non-dry-run execution. It triggers registry garbage collection after the prune workflow, even when no manifests were deleted during that run.
- `--registry-url=<url>` overrides automatic registry endpoint detection. Use it only when automatic discovery does not produce the correct endpoint or when an externally reachable endpoint must be used.

## Recommended Usage Order

For production environments, use the following rollout order:

1. Run a dry run with the intended retention and whitelist rules.
2. Review the reported prune candidates.
3. Re-run the same command with `--confirm` only after the candidate set is validated.
4. Enable `--prune-registry` only during a planned maintenance window or off-peak period if registry garbage collection is required.

## Implementation Steps

### Step 1: Log in and select the target cluster

```bash
ac login <acp-url>
ac config get-clusters
ac config use-cluster <cluster-name>
```

### Step 2: Run a dry run to review prune candidates

Before performing any deletion, run the command in its default dry-run mode to review prune candidates and validate retention rules.

```bash
ac adm prune images
```

If `ac` cannot automatically detect the correct registry endpoint, specify the external registry endpoint with `--registry-url`.

```bash
ac adm prune images --registry-url=<external-registry-url>
```

### Step 3: Run confirmed cleanup with a retention policy

The following example keeps images younger than 7 days, keeps the latest 5 revisions per repository, excludes repositories in the `cpaas-system` namespace, and performs confirmed cleanup.

```bash
ac adm prune images \
  --keep-younger-than=168h \
  --keep-tag-revisions=5 \
  --whitelist='^cpaas-system/.*' \
  --confirm
```

### Step 4: Trigger GC when required

The following example keeps images younger than 3 days, keeps the latest 3 revisions per repository, and triggers registry GC during a confirmed cleanup run.

```bash
ac adm prune images \
  --keep-younger-than=72h \
  --keep-tag-revisions=3 \
  --prune-registry \
  --confirm
```

## Configure Scheduled Cleanup with CronJob

### Base CronJob Template

The following CronJob runs image prune inspection against the internal registry once per day at 2:00 AM. Because `--confirm` is not specified, it runs in dry-run mode by default.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ac-prune-images-cronjob
  namespace: cpaas-system
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: ac-images-pruner-sa
          restartPolicy: Never
          containers:
            - name: ac
              image: <platform-registry-url>/alauda/ac:<tag>
              args:
                - adm
                - prune
                - images
```

Notes:

- `<platform-registry-url>`: the registry endpoint of your target ACP platform.
- `<tag>`: the AC image tag provided by your target ACP platform.
- `serviceAccountName: ac-images-pruner-sa`: the ServiceAccount must be able to inspect workload resources to identify in-use images, read `registry.alauda.io/images` for dry-run analysis, delete `registry.alauda.io/images` for confirmed cleanup, and execute into the registry Pod when registry garbage collection is enabled.

## Why These Permissions Are Required

The prune workflow needs to inspect both cluster workloads and registry-side image metadata before it can safely determine which images are unused.

The example RBAC grants permissions for the following purposes:

- **Workload discovery**:  
  `get`, `list`, and `watch` permissions on resources such as Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs, and ReplicationControllers are required so the command can discover image references currently in use by the cluster.

- **Registry image inspection**:  
  `get` access to `registry.alauda.io/images` is required so the command can retrieve image metadata during dry-run analysis.

- **Image deletion**:  
  `delete` access to `registry.alauda.io/images` is required only when `--confirm` is used, because confirmed pruning removes eligible image manifests.

- **Registry garbage collection support**:  
  `create` access to `pods/exec` is required only when registry garbage collection is enabled, because the workflow may need to execute GC-related operations through the registry Pod.

## RBAC Scope Recommendation

Grant only the permissions required by your selected execution mode:

- For **dry-run only**, `get` access to `registry.alauda.io/images` is sufficient; `delete` is not required.
- For **confirmed pruning**, both `get` and `delete` are required.
- For **registry GC**, `pods/exec` permission is additionally required.

## Fully Runnable Example (Recommended Starting Point)

Start with the following example if you want a complete, end-to-end dry-run setup that can be applied and validated immediately. It is intended to be the primary reference configuration before you tune schedules or pruning policies for production.

First, create the ServiceAccount and ClusterRole required by the CronJob.

```yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ac-images-pruner-sa
  namespace: cpaas-system
  labels:
    cpaas.io/cleanup: ac-images-pruner
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ac-images-pruner-role
  labels:
    cpaas.io/cleanup: ac-images-pruner
rules:
  - apiGroups: [""]
    resources: ["pods", "replicationcontrollers"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets", "replicasets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
  - apiGroups: ["registry.alauda.io"]
    resources: ["images"]
    verbs: ["get", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ac-images-pruner-rolebinding
  labels:
    cpaas.io/cleanup: ac-images-pruner
subjects:
  - kind: ServiceAccount
    name: ac-images-pruner-sa
    namespace: cpaas-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ac-images-pruner-role
```

Then create the `CronJob`.

This example runs image pruning every 6 hours, keeps images created within the last 7 days, keeps the latest 5 revisions per repository, and excludes repositories under the `cpaas-system` namespace. Because `--confirm` is not included, it is a dry-run configuration.

```yaml
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ac-prune-images-cronjob
  namespace: cpaas-system
  labels:
    cpaas.io/cleanup: ac-images-pruner
spec:
  schedule: "0 */6 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    metadata:
      labels:
        cpaas.io/cleanup: ac-images-pruner
    spec:
      template:
        metadata:
          labels:
            cpaas.io/cleanup: ac-images-pruner
        spec:
          serviceAccountName: ac-images-pruner-sa
          restartPolicy: Never
          containers:
            - name: ac
              image: <platform-registry-url>/alauda/ac:<tag>
              args:
                - adm
                - prune
                - images
                - --keep-younger-than=168h
                - --keep-tag-revisions=5
                - --whitelist=^cpaas-system/.*
              securityContext:
                allowPrivilegeEscalation: false
                runAsNonRoot: true
                runAsUser: 65532
```

Apply the resources:

```bash
ac apply -f ac-prune-images-cronjob.yaml
```

Trigger one manual Job for immediate validation:

```bash
ac create job --from=cronjob/ac-prune-images-cronjob \
  ac-prune-images-cronjob-manual -n cpaas-system
```

Check the execution result:

```bash
ac get job -n cpaas-system ac-prune-images-cronjob-manual
```

## Important Considerations and Best Practices

Use the following guidance when adapting the runnable example to a production environment:

- Always start with dry-run mode before enabling `--confirm`.
- Validate whitelist rules carefully before using `--all` or aggressive retention settings.
- Use a dedicated ServiceAccount with only the permissions required by the selected execution mode.
- Schedule confirmed cleanup and registry GC during off-peak periods.
- Keep at least a small retention window and revision count in production unless a fully validated aggressive policy is required.
- Manually trigger and validate one Job before relying on CronJob-based recurring cleanup.
- Review logs regularly to confirm that prune candidates match expectations and that no protected repositories are affected.
- Prefer a single operational CLI in the document and in daily operations. If ACP environments standardize on `ac`, use `ac` consistently for deployment, verification, and cleanup tasks.

## Recommended Policy Patterns

The following policy patterns can be used as a reference when tuning schedule and pruning behavior for different operational goals.

| Scenario | Recommended schedule | Suggested flags | Notes |
|----------|----------------------|-----------------|-------|
| Daily inspection | `0 2 * * *` | `--keep-younger-than=168h --keep-tag-revisions=5 --whitelist=^cpaas-system/.*` | Dry-run only; suitable for daily visibility into prune candidates |
| Weekly production cleanup | `30 3 * * 0` | `--keep-younger-than=336h --keep-tag-revisions=10 --whitelist=^cpaas-system/.* --confirm` | Recommended baseline policy for production |
| Monthly aggressive cleanup | `0 4 1 * *` | `--all --whitelist=^cpaas-system/.* --whitelist=^pro-ns1/base/.* --confirm` | Use only after thorough whitelist validation |
| Weekly cleanup with GC | `0 1 * * 6` | `--keep-younger-than=720h --keep-tag-revisions=5 --prune-registry --confirm` | Schedule during an off-peak window |

## Verification

After deploying the CronJob, verify the configuration, one-time execution result, and prune behavior in the following order.

### 1. Verify resource creation

Confirm that the scheduled task and its related resources were created successfully.

```bash
ac get cronjob -n cpaas-system -l cpaas.io/cleanup=ac-images-pruner
ac get job -n cpaas-system -l cpaas.io/cleanup=ac-images-pruner
ac get pod -n cpaas-system -l cpaas.io/cleanup=ac-images-pruner
```

Check for:

- the expected CronJob name and schedule
- a Job created by the CronJob or by manual trigger
- a Pod in `Completed` state after execution

### 2. Verify job completion status

Inspect the Job and Pod status in detail.

```bash
ac describe job -n cpaas-system <job-name>
ac describe pod -n cpaas-system <pod-name>
```

Expected result:

- Job reaches `Complete`
- Pod phase is `Succeeded`
- container `exitCode` is `0`
- `restartCount` remains `0`

### 3. Verify command output in logs

Review the Job logs to confirm what the prune command actually did.

```bash
ac logs job/<job-name> -n cpaas-system
```

For a dry run, confirm that the logs show:

- cluster image scanning completed successfully
- registry metadata was fetched successfully
- candidate images were listed
- no actual deletion was performed

For a confirmed run, additionally confirm that the logs show:

- eligible manifests were deleted
- whitelist rules were honored
- registry GC was triggered only when `--prune-registry` was specified

### 4. Verify policy behavior before enabling confirmed cleanup

Before enabling `--confirm` in production, manually validate that the reported candidates match the intended policy.

Specifically verify:

- recently created images are retained according to `--keep-younger-than`
- the most recent revisions are retained according to `--keep-tag-revisions`
- repositories matching any `--whitelist` rule are excluded
- active workloads are not referencing any image reported as a prune candidate

### 5. Verify registry endpoint selection

If `--registry-url` is used, confirm that the endpoint is reachable from the Job Pod and matches the intended registry.

Suggested checks:

```bash
ac describe pod -n cpaas-system <pod-name>
ac logs job/<job-name> -n cpaas-system
```

Confirm that:

- the Job used the expected endpoint
- there are no authentication or connectivity errors
- the endpoint corresponds to the target cluster registry

### 6. Verify registry GC separately when enabled

If `--prune-registry` is enabled, review the logs carefully to confirm that garbage collection was started successfully.

Recommended checks:

- GC is executed only in a maintenance or off-peak window
- no permission error occurs for `pods/exec`
- no registry availability issue is observed during or after GC

Typical successful Pod logs (example):

```text
[1/5] Scanning cluster for used images...
      Found 75 unique image references in use.
[2/5] Fetching metadata from registry...
      Scanned 9 repositories, found 1 image instances.
[3/5] Pruning 1 image manifests...
      DRY RUN: Would delete pro-ns1/demo/bash:5
[4/5] Summary
      Candidates for pruning: 1
[5/5] Skipping registry garbage collection because --prune-registry is not set.
```

## Troubleshooting

Use the following table to identify common problems and the fastest checks to perform.

| Symptom | Possible cause | What to check first | Suggested action |
|---------|----------------|---------------------|------------------|
| `no current context set` | No usable in-cluster fallback and no valid CLI context in the container | Check the AC version and whether the Pod is expected to run with in-cluster credentials | Upgrade to a compatible AC version and verify ServiceAccount token mounting and in-cluster auth behavior |
| `forbidden` / `cannot list ...` | Missing RBAC permissions for workload discovery | Run `ac auth can-i list pods --as system:serviceaccount:cpaas-system:ac-images-pruner-sa` and similar checks for required resources | Grant missing `get/list/watch` permissions for workload resources and required permissions on `registry.alauda.io/images` |
| `forbidden` when deleting images | ServiceAccount has read access but not delete access | Check whether the run uses `--confirm` and whether `delete` is granted on `registry.alauda.io/images` | Add `delete` permission for confirmed cleanup |
| `401` / `403` when fetching registry tags or manifests | Registry endpoint is reachable but authentication or authorization fails | Check logs for the exact registry endpoint in use and verify the ServiceAccount authorization path | Verify registry proxy authn/authz configuration, token handling, and whether `--registry-url` points to the correct endpoint |
| `failed to list registry pods` | Missing access to the registry Pod namespace or missing permissions | Check whether the registry Pod exists in `cpaas-system` and whether the ServiceAccount can access related resources | Verify namespace, resource names, and RBAC for GC-related Pod access |
| `pods/exec is forbidden` | GC is enabled but exec permission is missing | Confirm whether `--prune-registry` is enabled and whether `pods/exec` has `create` permission | Add `create` permission on `pods/exec` |
| No prune candidates found | Retention policy is too conservative, whitelist is too broad, or the cluster is actively using most images | Review logs and compare the reported candidate set with the configured `--keep-*` and `--whitelist` values | Start with dry-run, then relax retention or narrow whitelist rules gradually |
| Unexpected images appear as candidates | Registry endpoint mismatch, policy misconfiguration, or workload scan does not reflect actual usage | Verify the selected registry endpoint, whitelist patterns, and workload visibility | Re-run in dry-run mode with explicit `--registry-url` if needed and review RBAC coverage |
| CronJob does not create Jobs | Invalid schedule, suspended CronJob, or controller issue | Run `ac describe cronjob -n cpaas-system <cronjob-name>` | Verify the schedule expression, ensure the CronJob is not suspended, and check cluster controller health |
| Job exists but Pod does not start | Image pull failure, admission rejection, or security policy mismatch | Run `ac describe job` and `ac describe pod` | Verify AC image availability, image pull access, and Pod security settings |
| Pod restarts or fails repeatedly | Container runtime error or command failure | Check `restartCount`, Pod events, and logs | Fix command arguments, image version, or cluster policy issues before retrying |

## Quick Diagnostic Workflow

When a scheduled prune task fails, use the following sequence:

1. Confirm the CronJob exists and the schedule is valid.
2. Confirm a Job was created successfully.
3. Confirm the Pod was created and inspect Pod events.
4. Review container logs for the prune workflow stage and exact error text.
5. Verify ServiceAccount RBAC with `ac auth can-i`.
6. If `--registry-url` is set, verify endpoint reachability and authorization.
7. If `--prune-registry` is enabled, verify `pods/exec` permission and registry Pod availability.

## Cleanup Demo Resources

```bash
# Delete namespace-scoped resources (such as CronJob, Job, Pod, and ServiceAccount)
ac delete cronjob,job,pod,serviceaccount \
  -n cpaas-system \
  -l cpaas.io/cleanup=ac-images-pruner \
  --ignore-not-found

# Delete cluster-scoped resources (such as ClusterRole and ClusterRoleBinding)
ac delete clusterrole,clusterrolebinding \
  -l cpaas.io/cleanup=ac-images-pruner \
  --ignore-not-found
```

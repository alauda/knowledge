---
products: 
   - Alauda Container Platform
kind:
   - Solution
ProductsVersion:
   - 4.x
---

# Administrator Guide to Cluster Image Registry Cleanup and Scheduled Task Configuration

## Introduction

This document provides a practical and production-ready approach for cleaning images in ACP's internal cluster image registry and automating the cleanup process with `CronJob`.

Goals of this solution:

- Safely remove images that are no longer used by the cluster.
- Control cleanup behavior with retention time, revision count, and whitelist rules.
- Start with Dry Run, then execute confirmed cleanup.
- Trigger registry garbage collection (GC) when needed.
- Configure scheduled tasks for automatic recurring cleanup.

## Prerequisites

- ACP CLI (`ac`) is installed.
- You can access the target cluster.
- You can access the registry.
- If running in Pod/CronJob:
  - `serviceAccountName` must be configured.
  - The ServiceAccount must have permissions to list workloads, access registry APIs, and (if GC is enabled) access the `image-registry` Pod exec endpoint.

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

## Parameter Reference

All parameters are optional. If you run the command without any parameters, it only outputs candidate images and does not delete anything.

| Parameter | Purpose | Typical example |
|-----------|---------|-----------------|
| `--keep-younger-than=<duration>` | Keep recently created images | `168h` |
| `--keep-tag-revisions=<N>` | Keep latest N versions per repository | `5` |
| `--all` | Ignore retention time and revision count, prune all unused images | `--all` |
| `--whitelist=<regex>` | Exclude matching repositories from pruning (repeatable) | `^cpaas-system/.*` |
| `--dry-run` | Show candidates only, no deletion (default) | `--dry-run` |
| `--confirm` | Execute actual deletion | `--confirm` |
| `--prune-registry` | Trigger registry GC in non-dry-run mode, even if no manifests were deleted | `--prune-registry` |
| `--registry-url=<url>` | Set registry endpoint | `http://image-registry.cpaas-system` |

## Implementation Steps

### Step 1: Log in and select target cluster

```bash
ac login <acp-url>
ac config get-clusters
ac config use-cluster <cluster-name>
```

### Step 2: Run Dry Run first

```bash
ac adm prune images
```

If `ac` is not able to detect the internal registry endpoint automatically, you can specify the external registry endpoint with the `--registry-url` parameter.

```bash
ac adm prune images --registry-url=<external-registry-url>
```

### Step 3: Run confirmed cleanup with policy

Keep younger than 7 days, keep latest 5 revisions per repository, and exclude images in `cpaas-system` namespace, confirm the cleanup operation.

```bash
ac adm prune images \
  --keep-younger-than=168h \
  --keep-tag-revisions=5 \
  --whitelist='^cpaas-system/.*' \
  --confirm
```

### Step 4: Trigger GC when required

Keep younger than 3 days, keep latest 3 revisions per repository, and trigger registry GC in non-dry-run mode, confirm the cleanup operation.

```bash
ac adm prune images \
  --keep-younger-than=72h \
  --keep-tag-revisions=3 \
  --prune-registry \
  --confirm
```

## Configure Scheduled Cleanup with CronJob

### Base CronJob Template

Run image-prune inspection against `image-registry.cpaas-system` once per day at 2:00 AM using a CronJob (dry-run by default).

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
- `<platform-registry-url>`: registry endpoint of your target ACP platform.
- `<tag>`: AC image tag from your target ACP platform.
- `serviceAccountName: ac-images-pruner-sa`: ServiceAccount must have permissions to list workloads, access the `image-registry` Pod (for GC), and access `registry.alauda.io/images` (`get` for dry-run, `delete` for confirmed cleanup). 

### Fully Runnable Example (Dry Run Recommended)

Firstly, create the ServiceAccount and ClusterRole to grant permissions to the CronJob.

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

Then, create the `CronJob`.

(Dry-run template) This CronJob runs image pruning every 6 hours, keeps images created within the last 7 days and the latest 5 revisions per repository, and excludes repositories under `cpaas-system` namespace from cleanup.

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

Apply resources:

```bash
ac apply -f ac-prune-images-cronjob.yaml
```

Trigger one manual Job for immediate validation:

```bash
ac create job --from=cronjob/ac-prune-images-cronjob \
  ac-prune-images-cronjob-manual -n cpaas-system
```

Check execution result:

```bash
ac get job -n cpaas-system ac-prune-images-cronjob-manual
```

## Scenario-Based Demos

### Scenario 1: Daily inspection (Dry Run only)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ac-prune-images-daily
  namespace: cpaas-system
  labels:
    cpaas.io/cleanup: ac-images-pruner
spec:
  schedule: "0 2 * * *"
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

### Scenario 2: Weekly steady cleanup (recommended for production)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ac-prune-images-weekly
  namespace: cpaas-system
  labels:
    cpaas.io/cleanup: ac-images-pruner
spec:
  schedule: "30 3 * * 0"
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
                - --keep-younger-than=336h
                - --keep-tag-revisions=10
                - --whitelist=^cpaas-system/.*
                - --confirm
              securityContext:
                allowPrivilegeEscalation: false
                runAsNonRoot: true
                runAsUser: 65532
```

### Scenario 3: Monthly aggressive cleanup (with whitelist protection)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ac-prune-images-monthly-aggressive
  namespace: cpaas-system
  labels:
    cpaas.io/cleanup: ac-images-pruner
spec:
  schedule: "0 4 1 * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 2
  failedJobsHistoryLimit: 5
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
                - --all
                - --whitelist=^cpaas-system/.*
                - --whitelist=^pro-ns1/base/.*
                - --confirm
              securityContext:
                allowPrivilegeEscalation: false
                runAsNonRoot: true
                runAsUser: 65532
```

### Scenario 4: Weekly cleanup with GC (off-peak window)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ac-prune-images-with-gc
  namespace: cpaas-system
  labels:
    cpaas.io/cleanup: ac-images-pruner
spec:
  schedule: "0 1 * * 6"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 2
  failedJobsHistoryLimit: 5
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
                - --keep-younger-than=720h
                - --keep-tag-revisions=5
                - --prune-registry
                - --confirm
              securityContext:
                allowPrivilegeEscalation: false
                runAsNonRoot: true
                runAsUser: 65532
```

## Verification

Run these commands after deployment:

```bash
ac get cronjob -n cpaas-system -l cpaas.io/cleanup=ac-images-pruner
ac get job -n cpaas-system -l cpaas.io/cleanup=ac-images-pruner
ac get pod -n cpaas-system -l cpaas.io/cleanup=ac-images-pruner
```

Expected result:

- Pod status is `Completed`.
- `exitCode` is `0`.
- No restart loop under `restartPolicy: Never`.

Check logs for details:

```bash
ac logs job/ac-prune-images-daily -n cpaas-system
```

Typical successful `Pod` logs (example):

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

## Cleanup resources of the demo

```bash
# Delete namespace-scoped resources (such as CronJob, Job, Pod, ServiceAccount, etc)
kubectl -n cpaas-system delete cronjob,job,pod,serviceaccount \
  -l cpaas.io/cleanup=ac-images-pruner --ignore-not-found

# Delete cluster-scoped resources (such as ClusterRole, ClusterRoleBinding, etc)
kubectl delete clusterrole,clusterrolebinding \
  -l cpaas.io/cleanup=ac-images-pruner --ignore-not-found
```

## Troubleshooting

| Symptom | Possible cause | Suggested action |
|---------|----------------|------------------|
| `no current context set` | Image does not include in-cluster fallback and no `ac login` session exists in container | Upgrade to a compatible AC version and verify SA token mount |
| `forbidden` / `cannot list ...` | ServiceAccount lacks RBAC for scan resources or registry image resource | Add required list/get/watch scan permissions and `registry.alauda.io/images` permissions (`get`, and `delete` if using `--confirm`) |
| `401` / `403` when fetching registry tags/manifests in Pod | In-cluster ServiceAccount token is not authorized by registry proxy | Verify proxy authn/authz config and grant required RBAC to the calling ServiceAccount |
| `failed to list registry pods` | No access to registry Pod in `cpaas-system` | Verify RBAC and namespace settings |
| Registry auth-related errors | Registry auth policy does not match current token mode | Verify `--registry-url` and registry token/anonymous policy |
| No prune candidates | Retention settings are too strict or whitelist is too broad | Run Dry Run and tune `--keep-*` and `--whitelist` |

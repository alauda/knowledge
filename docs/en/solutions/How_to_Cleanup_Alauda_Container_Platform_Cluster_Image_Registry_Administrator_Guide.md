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

This document provides a practical and production-ready approach for cleaning images in ACP's internal registry of cluster and automating the cleanup process with `CronJob`.

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
  - The ServiceAccount must have permissions to list workloads and access the registry path.

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
| `--prune-registry` | Trigger registry GC after deletion | `--prune-registry` |
| `--registry-url=<url>` | Set registry endpoint | `http://image-registry.cpaas-system` |

## Implementation Steps

### Step 1: Log in and select target cluster

```bash
ac login <acp-url>
ac config use-cluster <cluster-name>
```

### Step 2: Run Dry Run first

```bash
ac adm prune images
```

### Step 3: Run confirmed cleanup with policy

```bash
ac adm prune images \
  --keep-younger-than=168h \
  --keep-tag-revisions=5 \
  --whitelist='^cpaas-system/.*' \
  --confirm
```

### Step 4: Trigger GC when required

```bash
ac adm prune images \
  --keep-younger-than=72h \
  --keep-tag-revisions=3 \
  --prune-registry \
  --confirm
```

## Configure Scheduled Cleanup with CronJob

### Base CronJob Template

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
              image: <registry-url>/alauda/ac:<tag>
              args:
                - adm
                - prune
                - images
```

Notes:
- `<registry-url>`: registry endpoint of your target ACP environment.
- `<tag>`: AC image tag from your target ACP environment.

### Fully Runnable Example (Dry Run Recommended)

The following resources include the minimal runnable set and can be copied directly.

```yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ac-images-pruner-sa
  namespace: cpaas-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ac-images-pruner-read
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
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ac-images-pruner-read-binding
subjects:
  - kind: ServiceAccount
    name: ac-images-pruner-sa
    namespace: cpaas-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ac-images-pruner-read
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ac-prune-images-cronjob
  namespace: cpaas-system
spec:
  schedule: "0 */6 * * *"
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
              image: <registry-url>/alauda/ac:<tag>
              args:
                - adm
                - prune
                - images
                - --keep-younger-than=168h
                - --keep-tag-revisions=5
                - --whitelist=^cpaas-system/.*
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
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: ac-tester-sa
          restartPolicy: Never
          containers:
            - name: ac
              image: <registry-url>/alauda/ac:<tag>
              args:
                - adm
                - prune
                - images
                - --keep-younger-than=168h
                - --keep-tag-revisions=5
                - --whitelist=^cpaas-system/.*
```

### Scenario 2: Weekly steady cleanup (recommended for production)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ac-prune-images-weekly
  namespace: cpaas-system
spec:
  schedule: "30 3 * * 0"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: ac-tester-sa
          restartPolicy: Never
          containers:
            - name: ac
              image: <registry-url>/alauda/ac:<tag>
              args:
                - adm
                - prune
                - images
                - --keep-younger-than=336h
                - --keep-tag-revisions=10
                - --whitelist=^cpaas-system/.*
                - --confirm
```

### Scenario 3: Monthly aggressive cleanup (with whitelist protection)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ac-prune-images-monthly-aggressive
  namespace: cpaas-system
spec:
  schedule: "0 4 1 * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 2
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: ac-tester-sa
          restartPolicy: Never
          containers:
            - name: ac
              image: <registry-url>/alauda/ac:<tag>
              args:
                - adm
                - prune
                - images
                - --all
                - --whitelist=^cpaas-system/.*
                - --whitelist=^pro-ns1/base/.*
                - --confirm
```

### Scenario 4: Weekly cleanup with GC (off-peak window)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ac-prune-images-with-gc
  namespace: cpaas-system
spec:
  schedule: "0 1 * * 6"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 2
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: ac-tester-sa
          restartPolicy: Never
          containers:
            - name: ac
              image: <registry-url>/alauda/ac:<tag>
              args:
                - adm
                - prune
                - images
                - --keep-younger-than=720h
                - --keep-tag-revisions=5
                - --prune-registry
                - --confirm
```

## Verification

Run these commands after deployment:

```bash
ac get cronjob -n cpaas-system
ac get job -n cpaas-system
ac get pod -n cpaas-system
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
[5/5] Dry run mode, skipping trigger registry garbage collection.
```

## Troubleshooting

| Symptom | Possible cause | Suggested action |
|---------|----------------|------------------|
| `no current context set` | Image does not include in-cluster fallback and no `ac login` session exists in container | Upgrade to a compatible AC version and verify SA token mount |
| `forbidden` / `cannot list ...` | ServiceAccount lacks RBAC for scan resources | Add required list/get/watch permissions to `ClusterRole` |
| `failed to list registry pods` | No access to registry Pod in `cpaas-system` | Verify RBAC and namespace settings |
| Registry auth-related errors | Registry auth policy does not match current token mode | Verify `--registry-url` and registry token/anonymous policy |
| No prune candidates | Retention settings are too strict or whitelist is too broad | Run Dry Run and tune `--keep-*` and `--whitelist` |

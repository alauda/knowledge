---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "3.14"
  - "3.20"
  - "4.2"
  - "4.3"
---

# GitLab instance upgrade fails, breaks after a Data Services move, reverts GitlabOfficial edits, or cannot be deleted

## Issue

A GitLab instance managed by the GitLab Operator shows one of these problems when it is upgraded or reconfigured:

- After a platform upgrade (for example 4.2.1 to 4.3.3), the GitLab Operator is upgraded and **Upgrade** is clicked on the instance; the instance shows Deploy Failed with:

  ```text
  failed upgrade (pre-upgrade hooks failed: resource Job/<gitlab-namespace>/<instance>-gitlab-official-upgrade-check not ready. status: Failed, message: Job Failed. failed: 3/1) and failed rollback: original object ConfigMap with the name "gitlab-webservice-puma" not found
  ```

- During the GitLab 14 upgrade procedure, the task-runner Deployment stays `Pending` after it is patched with the backup PVC, with no logs and no events; later the backup fails with permission errors.
- After GitLab's Redis and PostgreSQL are moved to Data Services management, some GitLab services fail to start, and the PostgreSQL instance in Data Services shows status Unknown.
- Edits to the GitLab custom resource deployed by the operator keep being reverted.
- Deleting the GitLab instance has no effect (seen on 3.14.1), and a DevOps Tools Operator deployment fails at the same time.
- During the GitLab upgrade the `task-runner` image is missing, and the default registry does not have it either.

## Root Cause

### Cause 1: an intermediate GitLab version was skipped

GitLab supports upgrades only through specific intermediate versions, and the operator enforces this in the `upgrade-check` pre-upgrade hook. When only the latest GitLab Operator is applied (for example operator 17.11.1 before and 18.8.1 after), the instance tries to go straight from GitLab 18.2.8 (chart `9.2.8-beta.1.g17490f65`) to 18.8.11 (chart `9.8.7-beta.1`), and the hook log shows:

```text
MIN_VERSION=18.5
CHART_MIN_VERSION=9.5
GITLAB_VERSION=18.8.11
It seems you are upgrading the GitLab Helm Chart from 9.2.8-beta.1.g17490f65 (GitLab 18.2.8) to 9.8.7-beta.1 (GitLab 18.8.11).
It is required to upgrade to the latest 9.5.x version first before proceeding.
```

followed by `exit 1`. The upgrade path for the operator and the instance is, in order, using the latest patch version of each minor release: `17.8.z` → `17.11.z` → `18.2.z` (requires the PostgreSQL 16 upgrade) → `18.5.z` → `18.8.z`. The `failed rollback ... ConfigMap "gitlab-webservice-puma" not found` part of the message is the Helm rollback after the failed hook; the hook failure is the cause.

### Cause 2: the GitLab 14 task-runner is `Pending` because `backup-pvc` is not bound

The upgrade procedure from GitLab 14.0.12 patches the `<instance>-task-runner` Deployment with the annotation `skip-sync: "true"` and replaces `/spec/template/spec/volumes/1` with a volume `task-runner-tmp` that uses the PVC `backup-pvc`. When no PV is bound to `backup-pvc`, the new Pod (image `gitlab-task-runner-ce:14.0.12`) stays `Pending` with `Node: <none>`, condition `PodScheduled False`, and `Events: <none>`. After a PV is bound, the backup can still fail when the backup directory was created and given permissions on one node but the PV, PVC, and Pod end up on another node.

### Cause 3: the Data Services PostgreSQL shows Unknown after the move

The PostgreSQL instance in Data Services (for example `<instance>-database`, PostgreSQL 12) shows status Unknown with:

```text
Please manually upgrade the PostgreSQL version.The current major version 12 is less than the minimal required version 14
```

The exact cause of the failing GitLab services was not confirmed. Restarting the PostgreSQL database and then the failing GitLab Pods brings the components back. The message itself states that the managed instance is below the minimal major version that Data Services requires (14), so the instance still needs a major version upgrade.

### Cause 4: edits were written under `status` instead of `spec`

`status` is written by the operator and reflects the observed state, so any value placed there is overwritten. Parameters set under `spec` (for `GitlabOfficial`, `spec.helmValues`) take effect and stay.

### Cause 5: deleting the instance has no effect while the GitLab CSV is still installed

Deleting the GitLab instance directly does nothing. After the ClusterServiceVersion (CSV) that belongs to GitLab is deleted, the instance uninstall proceeds normally. Why the remaining CSV blocks the uninstall was not determined.

### Cause 6: the `task-runner` image tag does not resolve to the platform registry

When the instance is updated according to the upgrade documentation with `task-runner: enabled: "true"` and no explicit image, the resulting task-runner Deployment does not reference the image in the platform's built-in registry, so the image cannot be pulled. Setting the actual image tag restores normal operation.

## Resolution

### Cause 1: an intermediate GitLab version was skipped

Download and apply each operator version on the path, and upgrade the instance after each one, before moving to the next: `17.8.z` → `17.11.z` → `18.2.z` → `18.5.z` → `18.8.z`. Perform the PostgreSQL 16 upgrade before the instance goes to 18.2.z. After installing the intermediate operator, check the instance status (Diagnostic Steps, step 1) before continuing.

> **Warning:** Each instance upgrade runs database migrations and restarts GitLab; GitLab is unavailable during each step. Precondition: a full GitLab backup (database together with `<instance>-rails-secret`) and a maintenance window that covers all steps. Rollback: restore the backup into an instance of the original version.

### Cause 2: the GitLab 14 task-runner is `Pending` because `backup-pvc` is not bound

1. Create a PV that matches the PVC and pins it to one node. A `local` PV with `nodeAffinity` makes the scheduler place the task-runner Pod on the node that holds the backup directory:

   ```yaml
   apiVersion: v1
   kind: PersistentVolume
   metadata:
     name: gitlab-backup-pv
   spec:
     capacity:
       storage: <size>                     # at least the request of backup-pvc
     accessModes:
       - ReadWriteOnce                     # same as backup-pvc
     persistentVolumeReclaimPolicy: Retain
     storageClassName: <pvc-storageclass>  # same as backup-pvc; "" if it has none
     claimRef:
       namespace: <gitlab-namespace>
       name: backup-pvc
     local:
       path: <backup-directory>
     nodeAffinity:
       required:
         nodeSelectorTerms:
           - matchExpressions:
               - key: kubernetes.io/hostname
                 operator: In
                 values:
                   - <node-name>
   ```

   ```bash
   kubectl apply -f gitlab-backup-pv.yaml
   kubectl -n <gitlab-namespace> get pvc backup-pvc
   kubectl -n <gitlab-namespace> get pod -o wide | grep task-runner
   ```

2. On `<node-name>`, create `<backup-directory>` and give write access to the user that the task-runner container runs as (Diagnostic Steps, step 3 shows `runAsUser` and `fsGroup`). The backup succeeds once the permissions are granted on the node where the task-runner Pod actually runs.

### Cause 3: the Data Services PostgreSQL shows Unknown after the move

> **Warning:** Restarting PostgreSQL interrupts GitLab and every other client of the instance until it is back. Precondition: only when the Data Services PostgreSQL shows Unknown with the version message and GitLab Pods fail, and a recent backup exists. A restart changes no data.

```bash
kubectl -n <pg-namespace> get pods | grep <instance>-database
kubectl -n <pg-namespace> delete pod <instance>-database-0
kubectl -n <pg-namespace> get pods -w
kubectl -n <gitlab-namespace> get pods | grep -vE 'Running|Completed'
kubectl -n <gitlab-namespace> delete pod <failing-gitlab-pod>
```

The GitLab components return to normal. Then plan the PostgreSQL major version upgrade that the status message asks for, following the Data Services documentation.

### Cause 4: edits were written under `status` instead of `spec`

```bash
kubectl -n <gitlab-namespace> edit gitlabofficial <instance>
```

Put the parameters under `spec.helmValues` (for example `spec.helmValues.gitlab.webservice.resources` or `spec.helmValues.global.hosts`), save, and confirm that the operator applies them. Remove anything you added under `status`.

### Cause 5: deleting the instance has no effect while the GitLab CSV is still installed

> **Warning:** Deleting the CSV removes the GitLab operator Deployment that OLM created from it; no GitLab instance in the cluster is reconciled until the operator is installed again. Precondition: only when deleting the instance has had no effect (Diagnostic Steps, step 6) and you intend to remove GitLab. Save the CSV YAML first. Rollback: install the GitLab operator again from OperatorHub.

```bash
kubectl get csv -A | grep -i gitlab
kubectl -n <operator-namespace> get csv <gitlab-csv> -o yaml > <gitlab-csv>-before.yaml
kubectl -n <operator-namespace> delete csv <gitlab-csv>
```

Then delete the instance again and confirm that its resources are removed.

### Cause 6: the `task-runner` image tag does not resolve to the platform registry

Read the registry and path that the other GitLab components of the instance use, and give the task-runner the same registry with the explicit tag of the task-runner image that matches the GitLab version (for GitLab 14.0.12, `gitlab-task-runner-ce:14.0.12`). In the GitLab chart values the fields are `gitlab.task-runner.image.repository` and `gitlab.task-runner.image.tag`; in the `GitlabOfficial` resource they sit under `spec.helmValues`:

```yaml
spec:
  helmValues:
    gitlab:
      task-runner:
        enabled: "true"
        image:
          repository: <platform-registry>/<gitlab-image-path>/gitlab-task-runner-ce
          tag: <gitlab-version>
```

```bash
kubectl -n <gitlab-namespace> edit gitlabofficial <instance>
```

Set the image on the instance rather than on the Deployment; a change made only in the Deployment can be reverted by the operator (Cause 4).

## Diagnostic Steps

1. Read the instance status and the failed hook Job:

   ```bash
   kubectl -n <gitlab-namespace> get gitlabofficial <instance> -o jsonpath='{.status}{"\n"}'
   kubectl -n <gitlab-namespace> get jobs | grep upgrade-check
   kubectl -n <gitlab-namespace> logs job/<instance>-gitlab-official-upgrade-check --tail=50
   ```

   `It is required to upgrade to the latest 9.5.x version first` (or another `MIN_VERSION`) is Cause 1.

2. Compare the operator version with the instance version:

   ```bash
   kubectl get csv -A | grep -i gitlab
   kubectl -n <gitlab-namespace> get gitlabofficial <instance> -o yaml | grep -iE 'version' | head
   ```

3. For a `Pending` task-runner, check the Pod and the PVC:

   ```bash
   kubectl -n <gitlab-namespace> describe pod <task-runner-pod> | grep -E 'Status:|Node:|PodScheduled|ClaimName'
   kubectl -n <gitlab-namespace> get pvc backup-pvc
   kubectl -n <gitlab-namespace> get deploy <instance>-task-runner -o jsonpath='{.spec.template.spec.securityContext}{"\n"}'
   ```

   A PVC in `Pending` with no bound volume is Cause 2. After the PV is bound, compare the node of the Pod with the node where the directory permissions were set.

4. For failures after a Data Services move, check the PostgreSQL instance status:

   ```bash
   kubectl get postgresqls.acid.zalan.do -A | grep <instance>
   kubectl -n <pg-namespace> get postgresqls.acid.zalan.do <instance>-database -o jsonpath='{.status}{"\n"}'
   ```

   `The current major version 12 is less than the minimal required version 14` is Cause 3. A replica whose log shows `system ID is invalid`, or an operator status of `could not sync cluster ... no switchover candidate found`, is a PostgreSQL replica problem that is not covered here.

5. For reverted edits, check where the changed values are:

   ```bash
   kubectl -n <gitlab-namespace> get gitlabofficial <instance> -o yaml | grep -n -E '^spec:|^status:'
   ```

   Values that you added below the `status:` line are Cause 4.

6. For an instance whose deletion has no effect, check whether the GitLab operator CSV is still present:

   ```bash
   kubectl get csv -A | grep -i gitlab
   kubectl get gitlabofficial -A
   ```

7. For a task-runner that cannot pull its image, compare its image with the other components:

   ```bash
   kubectl -n <gitlab-namespace> get deploy -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.template.spec.containers[*].image}{"\n"}{end}'
   kubectl -n <gitlab-namespace> get events --field-selector reason=Failed | grep -i task-runner
   ```

   A task-runner image that is not in the platform registry used by the other components, or has no tag, is Cause 6.

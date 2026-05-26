---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500016
---

# Scaffolding a namespaced, RBAC-scoped scheduled backup workload on ACP

## Issue

On Alauda Container Platform (Kubernetes `v1.34.5`), a scheduled backup workload needs a self-contained home: a dedicated namespace to hold its pods, an RBAC identity scoped to whatever the chosen backup tool requires, and a periodic trigger. A dedicated namespace is created to hold the backup pods so the workload is isolated from other tenants and its lifecycle can be managed as a unit [ev:c1]. The supporting identity is expressed as standard Kubernetes RBAC, which behaves identically on ACP [ev:c2].

## Resolution

Create the dedicated namespace first; it is a plain Kubernetes `Namespace` object [ev:c1]:

```bash
kubectl create namespace acp-etcd-backup
```

Provision the workload identity as a `ServiceAccount`, a `ClusterRole`, and a `ClusterRoleBinding`. These use the standard `rbac.authorization.k8s.io/v1` API and the standard RBAC kinds (`ClusterRole`, `ClusterRoleBinding`, `Role`, `RoleBinding`), which exist on ACP unchanged, so no platform-specific tailoring of the RBAC objects is needed [ev:c2]. The rule set below is illustrative scaffolding — it grants read access to nodes and management of pods and `pods/log`; scope the actual `resources` and `verbs` down to exactly what the chosen backup tool needs [ev:c2]:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: backup-sa
  namespace: acp-etcd-backup
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: backup-runner
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "create", "delete", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: backup-runner
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: backup-runner
subjects:
  - kind: ServiceAccount
    name: backup-sa
    namespace: acp-etcd-backup
```

Schedule the workload as a `CronJob` in the `batch/v1` API, running under the `backup-sa` ServiceAccount in the dedicated namespace [ev:c6]. The manifest below provides the generic scaffolding — schedule, identity, and pod shell; populate the container `image` and `command` with the backup tooling appropriate for the target [ev:c6]:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-cronjob
  namespace: acp-etcd-backup
spec:
  schedule: "0 */6 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: backup-sa
          restartPolicy: Never
          containers:
            - name: backup
              image: <backup-image>
              command: ["/bin/sh", "-c", "<backup-command>"]
```

The scaffolding above runs the backup container under the default pod-security profile of the dedicated namespace; the `image` and `command` placeholders are populated with a backup tool that operates within those defaults [ev:c6]. This article does not assert any elevated pod-level privilege for the backup workload — if a specific backup tool documents a host-level or privileged requirement, confirm against the target cluster's pod-security policy whether that level is admitted before relying on it, as cluster pod-security enforcement may reject it.

## Diagnostic Steps

Validate the setup by manually triggering the CronJob and confirming the resulting pod and job complete successfully [ev:c6]. The `batch/v1` API supports creating an ad-hoc Job from an existing CronJob with the `--from=cronjob/<name>` flag, so the schedule does not have to be awaited [ev:c6]:

```bash
kubectl create job test-backup \
  --from=cronjob/backup-cronjob -n acp-etcd-backup
```

Confirm the manually triggered run completed by inspecting the pods, jobs, and cronjobs in the namespace [ev:c6]:

```bash
kubectl get cronjobs,jobs,pods -n acp-etcd-backup
```

A completed Job and a pod in `Completed` status indicate the namespace, RBAC, and CronJob scaffolding are wired together correctly [ev:c6].

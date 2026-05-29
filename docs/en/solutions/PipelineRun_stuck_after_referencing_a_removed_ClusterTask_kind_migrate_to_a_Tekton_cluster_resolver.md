---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# PipelineRun stuck after referencing a removed ClusterTask kind — migrate to a Tekton cluster resolver

## Issue

On Alauda Container Platform (Kubernetes `v1.34.5`, Alauda DevOps Pipelines / `tektoncd-operator` CSV `tektoncd-operator.v4.2.0`, OperatorBundle channel `latest` from catalog `platform`, TektonConfig release `v0.76.0-c46274a`), a `Pipeline` that still references a Task via `taskRef.kind: ClusterTask` cannot be admitted as a v1 `Pipeline` on this build: there is no `clustertasks.tekton.dev` CRD registered, and the v1 Pipeline admission webhook (`validation.webhook.pipeline.tekton.dev`) treats `taskRef.kind: ClusterTask` as a custom task ref and rejects the apply with `invalid value: custom task ref must specify apiVersion: spec.tasks[0].taskRef.apiVersion`. The same gate is what prevents a `PipelineRun` against any older copy of that `Pipeline` (one that was admitted on an earlier build where `ClusterTask` was still a recognised kind) from making forward progress through resolution to schedule a `TaskRun` Pod — `kubectl get pipeline -n <ns> -o yaml | grep -iE 'ClusterTask|resolver'` is the first sweep to find any remaining `ClusterTask` references in the namespace.

## Root Cause

`ClusterTask` is no longer a first-class kind in the `tektoncd-operator` shipped on ACP. The standard tekton.dev v1 CRDs that are present in `v4.2.0` are `pipelines`, `pipelineruns`, `tasks`, `taskruns`, `customruns`, `stepactions`, and `verificationpolicies`; the cluster-scoped legacy `clustertasks.tekton.dev` is not in that set, and `kubectl get clustertask -A` returns `error: the server doesn't have a resource type "clustertask"`. Because the kind is gone, the v1 Pipeline schema no longer recognises `kind: ClusterTask` as a built-in `taskRef.kind` and falls through to the custom-task-ref branch, which requires `apiVersion` — the admission webhook then rejects the apply outright, and any prior Pipeline that still carries that field cannot resolve a Task during PipelineRun reconciliation.

The supported replacement is the upstream Tekton remote-resolution framework (the "Resolvers" set), and in particular the **cluster resolver**, which fetches a `Task` (or `Pipeline`) from another namespace on the same cluster by name. On ACP DevOps Pipelines `v4.2.0` the cluster resolver is enabled by default: the `TektonConfig` singleton named `config` has `spec.pipeline.enable-cluster-resolver: true` (alongside `enable-bundles-resolver`, `enable-git-resolver`, `enable-hub-resolver`), and the broader `enable-api-fields` knob that gates remote-resolution feature surface ships as `beta` out of the box on this version.

## Resolution

Migrate any `Pipeline` whose `taskRef` still names `kind: ClusterTask` to use `taskRef.resolver: cluster` with the three params the cluster resolver expects (`name`, `kind`, `namespace`). The original `ClusterTask` references a cluster-scoped task by name; the resolver references the corresponding namespaced `Task` (typically the Task that ships in the `tektoncd-operator` install namespace `tekton-pipelines`, or wherever your tasks live).

Before-and-after, applied to the same step:

```yaml
# legacy (rejected on ACP DevOps Pipelines v4.2.0)
spec:
  tasks:
    - name: test-task
      taskRef:
        kind: ClusterTask
        name: <task-name>
```

```yaml
# migrated — uses the cluster resolver
spec:
  tasks:
    - name: test-task
      taskRef:
        resolver: cluster
        params:
          - name: name
            value: <task-name>
          - name: kind
            value: task
          - name: namespace
            value: tekton-pipelines      # or whatever namespace holds the Task
```

The cluster resolver is enabled by default on ACP DevOps Pipelines `v4.2.0` (`TektonConfig` `config` ships `spec.pipeline.enable-cluster-resolver: true` and `spec.pipeline.enable-api-fields: beta`), so no `TektonConfig` patch is required for a fresh install. If your environment has been customised and `enable-api-fields` is no longer `beta`, restore it on the singleton `TektonConfig` named `config`:

```bash
kubectl patch tektonconfig config --type=merge \
  -p '{"spec":{"pipeline":{"enable-api-fields":"beta","enable-cluster-resolver":true}}}'
```

Verify the migration end-to-end by re-applying the migrated `Pipeline` and creating a `PipelineRun` against it: the cluster resolver fetches the referenced `Task` from the specified namespace, the controller materialises a `TaskRun`, and `kube-scheduler` places the `TaskRun` Pod on a worker node, after which the step executes normally.

## Diagnostic Steps

Confirm the legacy `kind: ClusterTask` is still in use in any `Pipeline` in the affected namespace:

```bash
kubectl get pipeline -n <namespace> -o yaml | grep -iE 'ClusterTask|resolver'
```

`ClusterTask` rows in the output are exactly the references that need to be migrated; `resolver` rows are already on the supported path. For a cluster-wide sweep, drop the `-n <namespace>` and add `-A`.

Confirm that the cluster has no `clustertasks.tekton.dev` CRD and that the v1 Pipeline admission webhook rejects `kind: ClusterTask`, so the migration is mandatory rather than optional on this build:

```bash
kubectl get crd | grep -i clustertask    # expect: no rows
kubectl get clustertask -A               # expect: error: the server doesn't have a resource type "clustertask"
```

Confirm the resolver-side prerequisites on the `TektonConfig` singleton — both knobs should already be in place on a default ACP install:

```bash
kubectl get tektonconfig config \
  -o jsonpath='enable-api-fields={.spec.pipeline.enable-api-fields} enable-cluster-resolver={.spec.pipeline.enable-cluster-resolver}{"\n"}'
```

Expected output on ACP DevOps Pipelines `v4.2.0`:

```
enable-api-fields=beta enable-cluster-resolver=true
```

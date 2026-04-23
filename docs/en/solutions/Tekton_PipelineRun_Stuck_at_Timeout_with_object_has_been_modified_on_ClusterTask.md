---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A PipelineRun enters `PipelineRunTimeout` without ever scheduling a TaskRun pod. The controller emits a stream of errors like:

```text
Operation cannot be fulfilled on pipelineruns.tekton.dev "<name>":
  the object has been modified; please apply your changes to the
  latest version and try again
```

New pipelines fail the same way; existing PipelineRuns accumulate in `Timeout` state. The Pipeline definition references tasks via `taskRef: { kind: ClusterTask, name: ... }`.

## Root Cause

**ClusterTask** is a deprecated Tekton resource. Tekton Pipelines 1.17 and later remove the controller path that reconciled `ClusterTask`-referenced tasks into each PipelineRun. The controller tries to patch the PipelineRun, finds the referenced ClusterTask unresolved, the patch races against the reconciler's own update, and the stream of `object has been modified` errors prevents any TaskRun from being scheduled — eventually the PipelineRun hits its timeout with zero work actually run.

The deprecation is upstream, so ACP's `devops` (based on Tekton) follows the same removal timeline.

## Resolution

Migrate Pipeline definitions from `ClusterTask` references to the **resolver** mechanism. Resolvers are the supported way to reference a task from another source — including a cluster-shared task library — and they've been the recommended path since Pipelines 1.13.

1. **Enable beta API fields** (default in recent Tekton; verify):

   ```yaml
   apiVersion: operator.tekton.dev/v1alpha1
   kind: TektonConfig
   metadata:
     name: config
   spec:
     pipeline:
       enable-api-fields: beta
   ```

2. **Rewrite ClusterTask references to use the `cluster` resolver.**

   Old (broken):

   ```yaml
   spec:
     tasks:
       - name: build
         taskRef:
           kind: ClusterTask
           name: build-app
   ```

   New (works):

   ```yaml
   spec:
     tasks:
       - name: build
         taskRef:
           resolver: cluster      # instead of kind:
           params:
             - name: kind
               value: task
             - name: name
               value: build-app
             - name: namespace
               value: <shared-task-namespace>    # where the Task lives
   ```

   The resolver version references a namespaced `Task`, not a cluster-scoped `ClusterTask`. Tasks that used to be `ClusterTask` should be re-created as regular `Task` resources in a shared namespace (conventionally the Tekton install namespace or a dedicated `tekton-tasks` namespace).

3. **Move the tasks themselves.** For each ClusterTask you referenced:

   ```bash
   kubectl get clustertask <name> -o yaml \
     | sed 's/^kind: ClusterTask/kind: Task/' \
     | sed -E 's/^([[:space:]]*)name: (.*)/\1name: \2\n\1namespace: <shared-task-namespace>/' \
     | kubectl apply -f -
   ```

   (Double-check the YAML after the sed; ClusterTask → Task conversion is rarely 1:1 if the tasks depend on cluster-scoped state.)

4. **Cancel and restart stuck PipelineRuns.** The stuck ones won't recover — their reconciliation is wedged. Cancel them, then trigger fresh runs against the migrated Pipelines:

   ```bash
   kubectl -n <ns> delete pipelinerun -l <selector>   # or specific names
   ```

5. **Prevent regression.** Reject `kind: ClusterTask` in your Pipeline repo via a policy check — either a Kyverno/Gatekeeper rule or a simple pre-merge grep in CI. Catch new definitions before they reach the cluster.

## Diagnostic Steps

Confirm the PipelineRun's failure mode:

```bash
kubectl -n <ns> describe pipelinerun <name> | sed -n '/Status:/,/Events:/p'
# Timeout, no TaskRuns, events include "object has been modified"
```

Check the Pipeline definition for ClusterTask references:

```bash
kubectl -n <ns> get pipeline <name> -o yaml \
  | grep -E 'kind: ClusterTask|resolver:'
```

Any `kind: ClusterTask` line is a candidate for migration. Any `resolver: cluster` that already exists alongside should be double-checked for correct params.

See which tasks still live as ClusterTask cluster-wide (the migration scope):

```bash
kubectl get clustertask -o custom-columns=NAME:.metadata.name,AGE:.metadata.creationTimestamp
```

Cancel an individual stuck PipelineRun for investigation:

```bash
kubectl -n <ns> patch pipelinerun <name> --type=merge \
  -p '{"spec":{"status":"Cancelled"}}'
```

After migration, PipelineRuns against the new definitions should start scheduling TaskRun pods immediately (seconds), not time out. If a PipelineRun still hangs without scheduling pods but now has no ClusterTask references, look instead at the Task's resolver status (`kubectl describe taskrun <name>`) for resolver-side errors.

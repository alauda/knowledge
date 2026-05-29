---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Missing ServiceAccount blocks Deployment rollout and yields an empty observed image set

## Issue

On Alauda Container Platform (ACP base v4.3.x, kube v1.34.5), `apps/v1` Deployment and ReplicaSet are namespaced core api-resources and the controller relies on `.spec.template.spec.serviceAccountName` to create pods. When the named ServiceAccount does not exist in the Deployment's namespace, the apiserver's in-tree ServiceAccount admission plugin denies each pod-create call the ReplicaSet controller issues, so the new ReplicaSet never produces a running pod.

Because no pod of the new ReplicaSet ever reaches Ready, a container security scanner — or any system that observes the running pod set for the Deployment and projects images from `.items[*].spec.containers[*].image` — reports an empty image set for the affected workload. The desired image list on `.spec.template.spec.containers[*].image` is non-empty, but the observed image set is empty because the selector matches zero pods.

## Root Cause

The apiserver returns a Forbidden response to the ReplicaSet controller's pod-create call with the verbatim message `pods "<name>" is forbidden: error looking up service account <ns>/<sa>: serviceaccount "<sa>" not found` whenever the referenced ServiceAccount does not exist in the namespace.

The ReplicaSet controller surfaces that admission denial as a `Warning` Event with `reason=FailedCreate` and `.involvedObject.kind=ReplicaSet`, carrying the apiserver's error string verbatim in `.message`.

If the new ReplicaSet never produces pods, the Deployment controller eventually flips its `Progressing` condition to `status=False, reason=ProgressDeadlineExceeded` once `.spec.progressDeadlineSeconds` (default 600s on ACP `apps/v1` Deployments) elapses without progress, and the Deployment is left with zero ready pods.

## Resolution

Create the missing ServiceAccount in the Deployment's namespace. The next pod-create call from the ReplicaSet controller passes the SA admission plugin, the new pods start, and the rollout completes:

```bash
kubectl create sa <name> -n <ns>
```

Alternatively, edit the Deployment so that `.spec.template.spec.serviceAccountName` (and the legacy alias `.spec.template.spec.serviceAccount`) points at an existing ServiceAccount in the namespace. The `default` ServiceAccount is auto-created by the SA controller in every ACP namespace and is a safe fallback when no dedicated SA is required:

```bash
kubectl edit deployment/<name> -n <ns>
```

Once pods are running, a scanner that walks the Deployment's pods reports the correct image set for the workload:

```bash
kubectl get pods -n <ns> -l <deployment-selector>
```

## Diagnostic Steps

List the namespace's events and look for the ReplicaSet's `Warning FailedCreate` records — the `.message` field carries the apiserver's `error looking up service account` string, which names the missing SA directly:

```bash
kubectl get event -n <ns>
kubectl get event -n <ns> --field-selector reason=FailedCreate
```

Inspect the Deployment YAML to read off both the misconfigured `serviceAccountName` and the `Progressing` condition on a single object — when the rollout is stuck on the missing SA, the `serviceAccountName` field points at the absent ServiceAccount and `.status.conditions[]` carries the `ProgressDeadlineExceeded` reason after the 600s default elapses:

```bash
kubectl get deployment/<name> -n <ns> -o yaml
```

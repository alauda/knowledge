---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500759
---

# TektonConfig stuck Not Ready after Tekton operator upgrade on ACP

## Issue

On Alauda Container Platform with the Alauda DevOps Pipelines operator (the platform-catalog `tektoncd-operator` bundle, version `v4.2.0`, displayName "Alauda DevOps Pipelines") installed, a single cluster-scoped `TektonConfig` named `config` drives the operator's component reconciliation. Its READY column is the operator's aggregate health signal: `kubectl get tektonconfig` returns `NAME / VERSION / READY / REASON`, and after a successful install the row reads `config / v0.76.0-c46274a / True` on a stock platform install. After an operator upgrade (or a reconcile that fails to converge), `TektonConfig` can flip to `READY=False` with a `REASON` line of the form `Components not in ready state: <Component>: <message>` — for example, when the Pipelines-as-Code component fails to settle, the reason is `OpenShiftPipelinesAsCode: reconcile again and proceed` and `kubectl get tektonconfig` shows `False` until the operator can reconcile the component to ready.

## Root Cause

`TektonConfig.status` aggregates per-component readiness into a top-level `Ready` condition. On the running operator the status shape is:

```
status:
  conditions:
  - type: PreInstall        status: "True"
  - type: PreUpgrade        status: "True"
  - type: ComponentsReady   status: "True"
  - type: PostInstall       status: "True"
  - type: PostUpgrade       status: "True"
  - type: Ready             status: "True"
```

A stuck component flips `ComponentsReady` (and therefore `Ready`) to `False`, and the human-readable `REASON` column on `kubectl get tektonconfig` carries the failing component's name and message. Each component the operator manages — Pipelines, Triggers, Chains, Hub, Pruner, the validating/mutating webhook, and the Pipelines-as-Code component — is materialised as a small set of `TektonInstallerSet` resources owned by the per-component CR (`TektonPipeline`, `TektonTrigger`, `TektonChain`, `OpenShiftPipelinesAsCode`, etc.). On a healthy install the inventory looks like:

```
$ kubectl get tektoninstallersets
NAME                                READY   REASON
chain-config-llr4g                  True
chain-kk7dg                         True
chain-secret-t69kk                  True
pipeline-main-deployment-brfzx      True
pipeline-main-static-65bjt          True
tekton-hub-api-fsx8g                True
tekton-hub-db-gj427                 True
tekton-hub-db-migration-pqj66       True
tekton-hub-ui-j6dc9                 True
tektoncd-pruner-p4wml               True
trigger-main-deployment-hbpmc       True
trigger-main-static-jjtxz           True
validating-mutating-webhook-m475r   True
```

Each `TektonInstallerSet` carries `ownerReferences` back to its component CR, and the operator's webhook injects a single finalizer `tektoninstallersets.operator.tekton.dev` on creation. The component CR (and `TektonConfig`'s aggregate) cannot become ready while its `TektonInstallerSet`s are not — so a wedged installer set that the operator can't move past surfaces directly as the article's `Components not in ready state` reason on `TektonConfig`.

The Pipelines-as-Code component specifically is exposed as the cluster-scoped CR `openshiftpipelinesascodes.operator.tekton.dev` (short names `opac` / `pac`); the operator bundle ships this CRD on the platform install, but the `OpenShiftPipelinesAsCode` operand is not auto-instantiated as part of the default `TektonConfig` profile. When a `pac` operand has been created and its installer sets are wedged, deleting those installer sets lets the operator recreate them and re-reconcile the component to ready.

## Resolution

Two recovery paths apply, depending on whether the wedge is generic (an installer set whose finalizer cannot be removed by its owner) or component-specific (the operator's reconcile loop for one component is failing).

**Force-remove a stalled `TektonInstallerSet` finalizer.** When a `TektonInstallerSet` is marked for deletion but the owning component controller cannot drop its finalizer, the resource sits with a `deletionTimestamp` set and a single finalizer entry `tektoninstallersets.operator.tekton.dev`. Patching the finalizer list to `null` releases the API server-side delete:

```bash
kubectl patch tektoninstallerset <name> \
  --type=merge -p '{"metadata":{"finalizers":null}}'
```

On the running operator the finalizer pattern is exactly that — a single entry that the controller normally drops itself on a clean delete; the `null` patch is the manual override when the controller does not.

**Re-reconcile a stuck Pipelines-as-Code component.** When the failing component is Pipelines-as-Code, list the `TektonInstallerSet`s that belong to the `pac` operand (their names are prefixed with the component, e.g. `openshiftpipelinesascode-main-deployment-*`, `openshiftpipelinesascode-main-static-*`, `openshiftpipelinesascode-post-*`) and delete them; the operator's component controller recreates them from its embedded manifests and the component returns to ready:

```bash
kubectl get tektoninstallerset \
  -l operator.tekton.dev/created-by=OpenShiftPipelinesAsCode
kubectl delete tektoninstallerset <pac-installerset-names>
```

If any of those deletes stall, apply the finalizer-null patch above. After the installer sets are recreated, `TektonConfig` returns to `READY=True` once `ComponentsReady` flips back, and the diagnostic that started this — `kubectl get tektonconfig` — should show the row without the `Components not in ready state` reason.

## Diagnostic Steps

Check `TektonConfig`'s aggregate health and the failing component name in the same line:

```bash
kubectl get tektonconfig
```

The `READY` column is the aggregate `Ready` condition; the `REASON` column carries the first failing component's name and message (e.g. `OpenShiftPipelinesAsCode: reconcile again and proceed`) when `READY=False`.

For the full condition breakdown — `ComponentsReady`, `PreInstall`, `PreUpgrade`, `PostInstall`, `PostUpgrade`, `Ready` — read `TektonConfig.status.conditions` directly:

```bash
kubectl get tektonconfig config -o jsonpath='{.status.conditions}' | jq .
```

A `False` on `ComponentsReady` localises the failure to one of the per-component installer sets.

List the installer sets and inspect the one that backs the failing component:

```bash
kubectl get tektoninstallerset
kubectl describe tektoninstallerset <name>
```

Look for `metadata.deletionTimestamp` (the resource is stuck terminating) and the single `tektoninstallersets.operator.tekton.dev` finalizer entry — that combination is what the `--type=merge -p '{"metadata":{"finalizers":null}}'` patch is meant to clear.

When the failing component is Pipelines-as-Code, also confirm the `OpenShiftPipelinesAsCode` operand exists and inspect its installer sets:

```bash
kubectl get openshiftpipelinesascodes
kubectl get tektoninstallerset \
  -l operator.tekton.dev/created-by=OpenShiftPipelinesAsCode
```

If `openshiftpipelinesascodes` returns `No resources found`, the `pac` component was never instantiated on this cluster and the `OpenShiftPipelinesAsCode: reconcile again and proceed` symptom can only appear after an operand is created — the operator ships the CRD on the platform install but does not create the operand under the default `TektonConfig` profile.

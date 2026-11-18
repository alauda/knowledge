---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12.x
  - 3.14.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Workload changes reverted, not applied, or restarting Pods: OAM, Helm template sync, StatefulSet partition, reloader on ACP

## Issue

A workload is changed and the cluster does something else:

- A manual edit of a Deployment that an OAM application created is reverted.
- A manual edit of the `resources` of a Deployment in an OAM application without `apply-once` is not reverted, while the controller log keeps printing `patching object`.
- A native application or a Helm-deployed application (for example Redis) is updated without anyone touching it: its history shows a new revision, its Pods restart several times, and manual configuration changes are lost.
- An application deployed with Helm is now maintained by editing its Deployments in the UI, and the question is whether it must be detached from its template.
- After a parameter change in the console, a StatefulSet Pod does not restart.
- Updating a ConfigMap makes a Deployment restart by itself.

Each case is a controller doing what it is configured to do, or a known product defect.

## Root Cause

### Cause 1: the OAM application restores the Deployment it rendered

An OAM application with a custom template manages the service lifecycle and restores the Deployment it rendered to the template's desired state (seen on 4.0.2). An in-place edit of a ComponentDefinition does not reach existing applications, which keep the version they reference, and there is no dry-run interface to preview the render of a new template.

### Cause 2: OAM synchronizes only the fields the template defines

The application controller re-applies the template periodically; its log repeats `"patching object" name="<name>" resource="apps/v1, Kind=Deployment"` for the Service, PersistentVolumeClaim, ConfigMap, Deployment and `StartStopScalerTrait` of the application, for example every five minutes. Fields that the template does not define, such as `resources` in this case, are outside the synchronized state, so a manual value stays.

### Cause 3: a captain restart re-synchronizes Helm-based applications and redeploys them

When `captain` (captain-controller) restarts, a defect in its check for whether a HelmRequest changed triggers a resynchronization of the downstream Helm templates, which re-applies the application's resources. The result is a new application revision without user action, Pods that restart, and manual changes that are reverted. The Kubernetes audit log then shows `patch` requests on the application's resources, for example `/api/v1/namespaces/<namespace>/services/<service>?fieldManager=manager`, by user `system:serviceaccount:kube-system:admin` with user agent `Go-http-client/2.0`, setting `app.kubernetes.io/managed-by: Helm` on objects annotated with `meta.helm.sh/release-name`. A Redis StatefulSet hit this way can also leave a deleted Pod outside the StatefulSet's management, so the new Pod cannot start. The defect is in ACP 3.12 and 3.14 and is fixed in 3.15 and later.

### Cause 4: a Helm-deployed application maintained in the UI must be detached from its template

As long as the application is still attached to its Helm template, the Helm-managed state (the values) can be applied again, for example when `captain` on the global cluster restarts (Cause 3), and UI edits are overwritten.

### Cause 5: rollingUpdate.partition is higher than the Pod ordinal

With `updateStrategy.type: RollingUpdate` and `rollingUpdate.partition: <n>`, only Pods whose ordinal is greater than or equal to the partition are updated when the template changes. A StatefulSet with one replica (ordinal 0) and `partition: 4` replaces no Pod after a change, for example to a ConfigMap script mounted as `/scripts/start.sh` with `subPath: start.sh`.

### Cause 6: the workload carries reloader.stakater.com/auto: "true"

That annotation makes the workload restart whenever its ConfigMap changes, so it reads the new configuration. Some platform component charts set it in their packages; on business workloads it was added by the workload owner. There is no global switch.

## Resolution

### Cause 1: the OAM application restores the Deployment it rendered

1. Export the application, then add the `apply-once` policy so the rendered Deployments can be changed while the template keeps publishing:

   ```bash
   kubectl get applications.core.oam.dev -n <namespace> <application> -o yaml > "$HOME/<application>-oam.yaml"
   kubectl edit applications.core.oam.dev -n <namespace> <application>
   ```

   ```yaml
   spec:
     policies:
       - name: apply-once
         type: apply-once
         properties:
           enable: true
   ```

   > **Warning:** With `apply-once` the application no longer restores drift; manual edits stay until the next publish changes those fields. Precondition: direct edits to the rendered workloads are intended. Rollback: apply the exported YAML, which removes the policy and brings back the revert.

2. For a template change, keep the existing ComponentDefinition and publish a new versioned one instead of editing it in place: keep `web-service-v1`, publish `web-service-v2` with the new parameters (for example CPU and memory defaults `*"500m"` and `*"512Mi"`), then change the component `type` in the Application from `web-service-v1` to `web-service-v2` and apply. The Deployment is re-rendered; the Application does not have to be deleted.

Detaching the application from its template also stops the revert, but gives up the template.

### Cause 2: OAM synchronizes only the fields the template defines

Expected behavior. Check which fields the template defines:

```bash
kubectl get pods -A | grep -i vela
kubectl logs -n <namespace> <application-controller-pod> --tail=200 | grep -F 'patching object'
kubectl get applications.core.oam.dev -n <namespace> <application> -o yaml | grep -n -A5 'resources'
```

To have the template enforce `resources`, define them in the OAM template.

### Cause 3: a captain restart re-synchronizes Helm-based applications and redeploys them

1. Match the unexpected revision with a `captain` restart and with the audit log entries described above:

   ```bash
   kubectl get pods -n cpaas-system | grep captain
   kubectl get helmrequest -A | grep <application>
   ```

2. Stop template sync for the affected application by annotating its HelmRequest (in the console: Platform Management > Cluster > Resource Management, search for the `helmrequest`, edit its YAML; or with `kubectl` on the cluster that holds it):

   ```bash
   kubectl get helmrequest -n <namespace> <helmrequest> -o yaml > "$HOME/<helmrequest>-hr.yaml"
   kubectl annotate helmrequest -n <namespace> <helmrequest> captain-no-sync="true"
   ```

   > **Warning:** `captain-no-sync: "true"` stops captain from synchronizing this HelmRequest, so later template or values changes are not deployed until it is removed. Precondition: the syncs of this HelmRequest restart the application. Rollback: `kubectl annotate helmrequest -n <namespace> <helmrequest> captain-no-sync-`; the next sync can redeploy the application and restart its Pods.

3. Long term: upgrade to 3.15 or later, where the defect is fixed. For Redis, prefer Operator mode over Helm mode, and keep the main configuration of business charts in values so a resync does not lose it.

### Cause 4: a Helm-deployed application maintained in the UI must be detached from its template

Use the application's detach-from-template (`脱离模板`) action before maintaining its Deployments and StatefulSets directly in the UI. Afterwards Helm values are no longer applied to it.

### Cause 5: rollingUpdate.partition is higher than the Pod ordinal

```bash
kubectl get sts -n <namespace> <name> -o jsonpath='{.spec.replicas}{" "}{.spec.updateStrategy}{"\n"}'
kubectl get sts -n <namespace> <name> -o jsonpath='{.status.currentRevision}{" "}{.status.updateRevision}{"\n"}'
```

A partition greater than or equal to the replica count, with `currentRevision` different from `updateRevision`, means no Pod moves to the new template.

> **Warning:** Setting the partition to 0 rolls every Pod of the StatefulSet to the new template, one at a time from the highest ordinal. Precondition: the partition was not left in place on purpose for a staged rollout, and the restarts are acceptable. Rollback: set the partition back; Pods already replaced stay on the new revision.

```bash
kubectl patch sts -n <namespace> <name> --type merge -p '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":0}}}}'
kubectl rollout status sts -n <namespace> <name>
```

### Cause 6: the workload carries reloader.stakater.com/auto: "true"

```bash
kubectl get deployment,sts,ds -A -o yaml | grep -n reloader.stakater.com
```

Remove the annotation from each business workload that should not restart on ConfigMap changes; leave the platform components as their charts set them.

> **Warning:** Without the annotation, a ConfigMap change no longer restarts the workload, and an application that reads its configuration only at start keeps the old values until it is restarted another way. Rollback: add the annotation again.

```bash
kubectl annotate deployment -n <namespace> <name> reloader.stakater.com/auto-
```

## Diagnostic Steps

```bash
kubectl get deploy,sts -n <namespace> <name> -o yaml | grep -n -E 'ownerReferences|reloader|partition|captain|app.oam.dev|meta.helm.sh'
kubectl get helmrequest -A | grep <application>
kubectl get applications.core.oam.dev -A | grep <application>
```

```text
edit of an OAM-rendered Deployment reverted                                   -> Cause 1
edit of resources not reverted, controller logs patching object               -> Cause 2
new revision or Pod restarts with no user action, right after captain restart -> Cause 3
Helm-deployed application to be maintained in the UI                          -> Cause 4
StatefulSet change did not roll the Pod, partition >= replicas                -> Cause 5
ConfigMap update restarts the workload, reloader annotation present           -> Cause 6
```

For Cause 3, the audit log entries by `system:serviceaccount:kube-system:admin` with `fieldManager=manager` at the time of the new revision, and no user request, confirm the resync.

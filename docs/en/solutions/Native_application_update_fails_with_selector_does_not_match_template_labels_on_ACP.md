---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Native application update fails with selector does not match template labels on ACP

## Issue

A native application shows `失败` (Failed) in the console after an update, although its Deployments show `运行中` (Running) with all replicas ready. The update never reaches the Deployment.

The `archon` component logs on the global cluster show the update being rejected by the Kubernetes API server:

```text
handler.go:66] Handle request error: Deployment.apps "<deployment-name>" is invalid: spec.template.metadata.labels: Invalid value: {"app.cpaas.io/name":"<application-name>.<namespace>", ...}: `selector` does not match template `labels`
```

The same log can also contain lines such as `Warning: unknown field "spec.componentTemplates[N].apiVersion"`. The line that names the rejected Deployment is the `selector` error above.

## Root Cause

### Cause 1: the Deployment selector pins `app.cpaas.io/name` to a value the platform overwrites

When the platform updates a native application, it writes the standard label `app.cpaas.io/name=<application-name>.<namespace>` into the Pod template of each Deployment that belongs to the application.

A Deployment that was created earlier with a selector containing a different value for the same key, for example `app.cpaas.io/name=<deployment-name>`, conflicts with that label. After the platform overwrites the Pod template label, `spec.selector.matchLabels` no longer matches `spec.template.metadata.labels`. Kubernetes validation rejects any Deployment whose selector does not match its own template labels, so the update fails and the native application is marked as failed.

The existing Pods keep running because the old ReplicaSet is untouched, which is why the Deployments still report Running.

`spec.selector` of an `apps/v1` Deployment is immutable. The selector cannot be corrected in place: the Deployment has to be recreated with a selector that agrees with the platform label.

A configuration error in another resource of the same application can also leave the native application in an abnormal state. The `archon` log names the resource and the reason in each case, so read it before changing anything.

## Resolution

### Cause 1

1. Fix the source that generates the Deployment selector, for example the `selectorLabels` helper of the Helm chart or the template used to render the Deployment. If the selector uses the `app.cpaas.io/name` label, set its value in the `<application-name>.<namespace>` format, which is the value the platform injects:

   ```yaml
   selector:
     matchLabels:
       app.cpaas.io/name: <application-name>.<namespace>
   ```

2. Save the current Deployment before removing it:

   ```bash
   kubectl -n <namespace> get deployment <deployment-name> -o yaml > <deployment-name>-backup.yaml
   ```

3. Delete the existing Deployment and redeploy the application, so the Deployment is created again with the corrected selector.

   > **Warning:** Deleting the Deployment deletes its Pods. The workload is unavailable until the new Deployment's Pods are Ready. Do this only when the `archon` log shows `` `selector` does not match template `labels` `` for this Deployment and the business allows the workload to be rebuilt. Roll back by applying the saved `<deployment-name>-backup.yaml` (remove `metadata.resourceVersion`, `metadata.uid` and `status` first).

   ```bash
   kubectl -n <namespace> delete deployment <deployment-name>
   ```

   Then redeploy the native application from the console, or re-run the release that renders the corrected template.

4. Confirm that the native application status changes from `失败` (Failed) to Running, and that `archon` no longer logs the error for this Deployment.

## Diagnostic Steps

1. Find the `archon` Pods on the global cluster and search their logs for the rejected update:

   ```bash
   kubectl get pods -A | grep archon
   kubectl -n <archon-namespace> logs <archon-pod> --tail=500 | grep -E 'Handle request error|does not match'
   ```

   Expected for this cause: `Deployment.apps "<deployment-name>" is invalid: spec.template.metadata.labels ... `selector` does not match template `labels``. If the error names another resource of the application, fix that resource instead.

2. Compare the Deployment selector with the value the platform injects:

   ```bash
   kubectl -n <namespace> get deployment <deployment-name> \
     -o jsonpath='{.spec.selector.matchLabels}{"\n"}{.spec.template.metadata.labels}{"\n"}'
   ```

   Expected for this cause: the selector contains `app.cpaas.io/name` with a value other than `<application-name>.<namespace>`, for example the bare Deployment name.

3. Check the other Deployments of the same application. A Deployment whose selector does not use `app.cpaas.io/name`, or already uses `<application-name>.<namespace>`, updates normally, which separates this cause from a general application controller problem.

---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Creating a custom application from YAML fails with applications.app.k8s.io already exists on ACP

## Issue

Creating a custom application from the YAML page of the console fails with a **Resource already exists** error. Renaming the application and creating it again fails the same way, while applying the same resources with `kubectl` works.

The error details show:

```json
{
  "StatusCode": 409,
  "reason": "AlreadyExists",
  "message": "applications.app.k8s.io \"<name>\" already exists",
  "details": { "group": "app.k8s.io", "kind": "applications" }
}
```

An `Application` with that name does exist afterwards. It was created by the same click, and its YAML shows it never assembled:

```yaml
spec:
  assemblyPhase: Failed
  componentKinds:
  - group: app.k8s.io
    kind: Application
  - group: apps
    kind: StatefulSet
status:
  conditions:
  - type: Error
    reason: Create components failed
    message: applications.app.k8s.io "<name>" already exists
  totalComponents: 0
```

## Root Cause

### Cause 1: a full `Application` object was pasted into the custom application YAML

The YAML field of the custom application page expects the workload resources only, for example a StatefulSet. The console wraps that input in its own `app.k8s.io/v1beta1` `Application` object with the name entered on the page.

When the pasted YAML is itself an `Application` (`apiVersion: app.k8s.io/v1beta1`, `kind: Application`), the request contains an extra Application layer. The console first creates its own `Application`, then tries to create the pasted `Application` as one of its components. That component has the same name as the Application just created, so the API server returns `409 AlreadyExists`. The outer Application ends in `assemblyPhase: Failed` with `Create components failed`, and no workload is created.

Renaming does not help because the console Application and the pasted Application get the same name again.

## Resolution

### Cause 1

1. Remove the failed Application left behind by the earlier attempts, so the name can be used again.

   > **Warning:** Deleting an `Application` can also delete resources that belong to it. Do this only when the Application shows `assemblyPhase: Failed`, the condition `Create components failed`, and `totalComponents: 0`, which means no component was created. If the Application has components, do not delete it; check what it owns first. There is nothing to roll back for a failed Application with no components.

   ```bash
   kubectl -n <namespace> get application <name> -o yaml
   kubectl -n <namespace> delete application <name>
   ```

2. Create the custom application again and paste only the workload YAML, for example the StatefulSet. Do not include an `apiVersion: app.k8s.io/v1beta1` / `kind: Application` object or its `componentKinds`, `assemblyPhase` or `status` fields.

   ```yaml
   apiVersion: apps/v1
   kind: StatefulSet
   metadata:
     name: <workload-name>
   spec:
     ...
   ```

3. Check that the new Application assembles and lists its workload:

   ```bash
   kubectl -n <namespace> get application <name> -o jsonpath='{.spec.assemblyPhase}{"\n"}'
   ```

## Diagnostic Steps

1. Look at the YAML that was pasted into the page. If it starts with `apiVersion: app.k8s.io/v1beta1` and `kind: Application`, this is the cause.

2. Find the Application that the failed attempt created. Use the full resource name: the short name `app` is not registered and returns `error: the server doesn't have a resource type "app"`.

   ```bash
   kubectl get application --all-namespaces | grep <name>
   kubectl -n <namespace> get application <name> -o yaml
   ```

   Expected for this cause: `componentKinds` contains `group: app.k8s.io, kind: Application`, the condition reason is `Create components failed` with the message `applications.app.k8s.io "<name>" already exists`, and `totalComponents: 0`.

3. If the pasted YAML contains no `Application` object and the error still appears, rule out a duplicate submission: open the browser developer tools, select **Network**, enable **Preserve log**, and click create. Two POST requests with the same URL and body, the first returning `201` and the second `409 Conflict`, are a duplicate submission, which is a different problem from this cause.

---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Project webhook alert notifications miss custom headers because webhook-header-secret is only in cpaas-system on ACP

## Issue

Alert notifications sent to a third-party Webhook endpoint work for notification rules created by the platform administrator, but fail for notification rules created under **Project Management** (often the ones that cover a workload cluster). The receiving endpoint rejects the request because a required custom header is missing, for example:

```text
Required request header <header-name> ... is not present
```

The platform-level setup follows the product documentation: a Secret `webhook-header-secret` of type `NotificationSender` exists in `cpaas-system` on the `global` cluster, and the platform receiver group carries the annotation `cpaas.io/notification.webhook.config: webhook-header-secret`. The question is then whether workload clusters and projects use the same Secret, and where to configure it.

## Root Cause

The custom headers of a Webhook notification come from a `NotificationSender` Secret that the receiver group (`NotificationGroup`, `ait.alauda.io`) references by name through the `cpaas.io/notification.webhook.config` annotation. Each key under the Secret's `data` becomes an HTTP header name.

The product documentation only describes creating that Secret in `cpaas-system`, which is where platform-level receiver groups live. Notification rules and receiver groups created under **Project Management** are tenant-isolated and are stored in the namespace whose name is the project name. A receiver group in that namespace cannot reference a Secret in `cpaas-system`, so the headers are never added and the endpoint rejects the request.

There is no separate per-cluster configuration: what matters is the namespace of the receiver group, not the cluster that raised the alert.

## Resolution

Create the header Secret in the namespace named after the project, on the `global` cluster, and reference it from the project's receiver group.

1. On a control plane node of the `global` cluster, find the receiver group used by the failing notification rule and note its namespace (the project name):

   ```bash
   kubectl get notificationgroups.ait.alauda.io -A
   ```

2. Create the Secret in that namespace. Use the same header names as the platform Secret; every value must be base64-encoded:

   ```yaml
   apiVersion: v1
   kind: Secret
   metadata:
     name: webhook-header-secret
     namespace: <project-name>
   type: NotificationSender
   data:
     <header-name>: <base64-encoded-header-value>
   ```

   ```bash
   kubectl apply -f webhook-header-project.yaml
   ```

   To reuse the values of the platform Secret, print them with `kubectl get secret webhook-header-secret -n cpaas-system -o yaml` and copy the `data` section.

3. Make sure the project receiver group references the Secret. Edit it and add the annotation if it is missing:

   ```bash
   kubectl edit notificationgroups.ait.alauda.io -n <project-name> <notification-group-name>
   ```

   ```yaml
   metadata:
     annotations:
       cpaas.io/notification.webhook.config: webhook-header-secret
   ```

4. Trigger or wait for an alert covered by the project notification rule and confirm that the endpoint no longer reports the missing header.

Repeat the steps for every project whose notification rules send to a Webhook endpoint that requires custom headers.

## Diagnostic Steps

1. List the receiver groups with their namespace and header annotation. A failing group in a project namespace whose annotation points to a Secret that does not exist in that namespace matches this issue:

   ```bash
   kubectl get notificationgroups.ait.alauda.io -A \
     -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,HEADER_SECRET:.metadata.annotations.cpaas\.io/notification\.webhook\.config'
   ```

2. Check that the referenced Secret exists in the same namespace as the receiver group and has the expected type and keys:

   ```bash
   kubectl get secret webhook-header-secret -n <project-name> -o jsonpath='{.type}{"\n"}{.data}{"\n"}'
   ```

   Expected: `NotificationSender` and the header names the endpoint requires. `NotFound` means the Secret exists only in `cpaas-system`.

3. If the platform receiver group in `cpaas-system` fails in the same way, the Secret is not namespace-mismatched. Check instead that the annotation is present on that group and that the Secret contains the header the endpoint asks for.

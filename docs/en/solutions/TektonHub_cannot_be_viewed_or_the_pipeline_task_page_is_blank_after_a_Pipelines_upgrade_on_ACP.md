---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "3.14"
  - "3.16"
  - "4.2"
  - "4.3"
---

# TektonHub cannot be viewed, or the pipeline task page is blank after a Pipelines upgrade on ACP

## Issue

- TektonHub cannot be opened, and uninstalling the Tekton operator and installing it again fails.
- After a Pipelines upgrade the pipeline task page is blank, and `kubectl get tektonhub.operator.tekton.dev -A` returns `No resources found`, although `TektonConfig.spec.profile` is already `all`.

## Root Cause

### Cause 1: TektonHub cannot be viewed and the operator reinstall fails because the Triggers webhook Role is missing

The Tekton Triggers webhook runs with its own ServiceAccount, which is granted its permissions by a `Role` and `RoleBinding`. When those two objects are missing (for example after an uninstall that removed them), the webhook cannot work, the operator install does not finish, and TektonHub stays unreachable. Restoring the `Role` and `RoleBinding` and restarting the webhook brings the operator install and TektonHub back.

### Cause 2: pipeline task page blank after a Pipelines upgrade because AUTOINSTALL_TEKTONHUB is false

The task page reads tasks from TektonHub. ConfigMap `tekton-config-defaults` in namespace `tekton-operator` has `AUTOINSTALL_TEKTONHUB` set to `"false"`. With that default the operator does not create the TektonHub custom resource, even with profile `all`, so no Hub exists and the page is blank. The value is injected into the operator's environment and is not reloaded while the Pod runs, so the operator Pod has to be recreated after the change; deleting the Pod is preferred over `rollout restart`.

This applies to Tekton operator versions that still ship the built-in TektonHub. Check that the installed Pipelines version provides TektonHub before turning the flag on.

## Resolution

### Cause 1: TektonHub cannot be viewed and the operator reinstall fails because the Triggers webhook Role is missing

1. Find the Triggers webhook and confirm that its `Role` and `RoleBinding` are absent:

   ```bash
   kubectl get deploy,pods -A | grep -iE 'triggers-webhook|tekton-triggers'
   kubectl get role,rolebinding -A | grep -i trigger
   kubectl -n <triggers-namespace> logs deploy/<triggers-webhook> --tail=80
   ```

   A missing Role for the webhook ServiceAccount, or a `forbidden` error in that log, matches this cause.

2. Export the same `Role` and `RoleBinding` from a healthy cluster that runs the same Tekton operator version, or take them from the Triggers release manifests of that version, and apply them here.

   > **Warning:** Applying a Role and RoleBinding grants the verbs in that file to the webhook ServiceAccount. A copy from a different operator version can be too wide or too narrow. Precondition: only when the Tekton operator reinstall fails after an uninstall and these Triggers webhook objects are missing. Keep the YAML you applied. Rollback: delete the Role and RoleBinding you added.

   ```bash
   kubectl apply -f <triggers-webhook-role.yaml>
   kubectl apply -f <triggers-webhook-rolebinding.yaml>
   ```

3. Restart the webhook.

   > **Warning:** Restarting the Triggers webhook drops admission for trigger resources until the new Pod is Ready; creating or changing EventListeners and other trigger objects fails in that window. Precondition: only after the Role and RoleBinding from step 2 are in place. Rollback: none for the restart; delete the objects from step 2 if they were the wrong ones.

   ```bash
   kubectl -n <triggers-namespace> rollout restart deploy/<triggers-webhook>
   kubectl -n <triggers-namespace> rollout status deploy/<triggers-webhook>
   ```

4. Retry the operator install. TektonHub should open, and the webhook Pod should stay Ready.

### Cause 2: pipeline task page blank after a Pipelines upgrade because AUTOINSTALL_TEKTONHUB is false

1. Confirm that no TektonHub exists, the profile is `all`, and the flag is `false`:

   ```bash
   kubectl get tektonhub.operator.tekton.dev -A
   kubectl get tektonconfig -o jsonpath='{range .items[*]}{.metadata.name}{" profile="}{.spec.profile}{"\n"}{end}'
   kubectl -n tekton-operator get configmap tekton-config-defaults -o jsonpath='{.data.AUTOINSTALL_TEKTONHUB}{"\n"}'
   ```

2. Save the ConfigMap, set the flag, and recreate the operator Pod.

   > **Warning:** Setting `AUTOINSTALL_TEKTONHUB` to `true` makes the operator create TektonHub (`tektonhub/hub`, with its Deployments in `tekton-pipelines`) and pull its images; deleting the operator Pod pauses Tekton component reconciliation until the new Pod is Ready. Precondition: only when no TektonHub exists, `TektonConfig.spec.profile` is `all`, and `AUTOINSTALL_TEKTONHUB` is `false`. Rollback: apply the saved ConfigMap and delete the operator Pod again; if `tektonhub/hub` remains, delete it with `kubectl delete tektonhub hub`, which removes the Hub UI.

   ```bash
   kubectl -n tekton-operator get configmap tekton-config-defaults -o yaml > /tmp/tekton-config-defaults.yaml
   kubectl -n tekton-operator patch configmap tekton-config-defaults --type merge -p '{"data":{"AUTOINSTALL_TEKTONHUB":"true"}}'
   kubectl -n tekton-operator delete pod -l name=tekton-operator
   ```

3. Wait for TektonHub and check its resources:

   ```bash
   kubectl wait --for=condition=Ready tektonhub/hub --timeout=600s
   kubectl get tektonhub.operator.tekton.dev -A
   kubectl -n tekton-pipelines get svc,deploy,pod | grep tekton-hub
   ```

4. Reload the pipeline task page.

## Diagnostic Steps

```bash
kubectl get tektonhub.operator.tekton.dev -A
kubectl get csv -A | grep -i tekton
kubectl get role,rolebinding -A | grep -i trigger
kubectl -n tekton-operator get configmap tekton-config-defaults -o jsonpath='{.data.AUTOINSTALL_TEKTONHUB}{"\n"}'
```

- The Tekton operator reinstall fails, and no Role or RoleBinding exists for the Triggers webhook: Cause 1.
- `No resources found` for TektonHub, profile `all`, and `AUTOINSTALL_TEKTONHUB` printed as `false`: Cause 2.
- A TektonHub object exists and its Pods are Running while the page is still blank: neither cause; check the Hub API Pod log before installing anything.

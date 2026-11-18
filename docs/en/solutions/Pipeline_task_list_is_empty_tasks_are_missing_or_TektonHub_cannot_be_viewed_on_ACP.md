---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.3"
  - "4.3.2"
---

# Pipeline task list is empty, tasks are missing, or TektonHub cannot be viewed on ACP

## Issue

One of the following happens in the pipeline (Tekton) console:

- On the graphical pipeline creation page, **Add Task** opens an empty task list. A task the user expects, such as `npm install`, appears to be missing, but in fact no Hub task is listed at all. The Pipeline Tasks page also lists nothing, so a new pipeline cannot be composed, even though Tekton Pipelines itself reports Ready.
- TektonHub cannot be opened, and reinstalling the Tekton operator fails.
- After the pipeline component is upgraded from 4.12.0 to 4.15.1, every Task disappears from the page, although the upgrade did not delete Task resources.
- Every CICD task is gone, a release cannot be started, and `devops-api` is unhealthy.
- A custom or private catalog added to Hub never shows its tasks, or edits to the `tekton-hub-api` ConfigMap are reverted.

The task list reads its data from TektonHub (or, from pipeline version 4.14, from ArtifactHub Shim). The versions 4.12, 4.14 and 4.15.1 in this article are versions of the pipeline (Tekton operator) component, not of the platform; confirm them with `TektonConfig` before changing anything.

## Root Cause

### Cause 1: TektonHub is not installed

The Tasks page and the **Add Task** dialog have no Hub to read, so the list is empty while Tekton Pipelines is Ready. Restarting the pipeline controllers does not fill the list. On platform 4.3.2, TektonHub was simply not installed; installing a TektonHub instance from the application marketplace restored the task list.

On the 4.12 operator line, the operator creates TektonHub automatically only when both conditions hold: `TektonConfig.spec.profile` is `all`, and `AUTOINSTALL_TEKTONHUB` in ConfigMap `tekton-operator/tekton-config-defaults` is `"true"`. A stock install leaves the flag `"false"`, so Hub never appears. From pipeline version 4.14 the built-in Tekton Hub is no longer bundled, and 4.15.1 cannot re-enable it through this preset; that is Cause 3.

### Cause 2: the Triggers webhook Role and RoleBinding are missing after an operator uninstall

After the Tekton operator was uninstalled, the reinstall failed because the Triggers webhook `Role` and `RoleBinding` were gone. Without them the webhook cannot start, Hub stays unreachable, and the operator install does not finish.

### Cause 3: from pipeline 4.14, Tekton Hub is no longer bundled

The upgrade to 4.15.1 does not delete Task resources. From 4.14, the built-in Tekton Hub is no longer shipped, and catalog access moves to the standalone ArtifactHub Shim. Tasks stay off the page until the `artifacthub-shim` plugin is installed, and existing custom catalogs have to be migrated to it. If the Git host that serves a catalog repository no longer answers, that catalog stays empty even with `artifacthub-shim` running.

### Cause 4: `devops-api` is wedged

The task list used for release is empty and a release cannot be started because `devops-api` is unhealthy. A slow etcd can leave the component wedged. Restarting `devops-api` brings the CICD tasks back; it does not repair the underlying etcd performance problem.

### Cause 5: the operator owns `tekton-hub-api` and overwrites direct edits

When Hub is deployed through `TektonConfig`, the operator owns the `tekton-hub-api` ConfigMap and reverts direct edits, including its `CATALOGS` value. On `tektoncd-operator` release 4.12 the supported path is to override `CATALOGS` through `TektonConfig.spec.hub.options.configMaps`. A private catalog repository needs both `url` and `sshurl`, plus the fixed-name SSH Secret `tekton-hub-api-ssh-crds` (keys `id_rsa`, `id_rsa.pub`, `known_hosts`) in the namespace where Hub runs. Hub rereads catalogs after `CATALOG_REFRESH_INTERVAL` or when the `tekton-hub-api` Pod restarts. Hub itself must be enabled first (Cause 1).

## Resolution

### Cause 1: TektonHub is not installed

1. Confirm that no TektonHub exists and check the pipeline version:

   ```bash
   kubectl get tektonhub.operator.tekton.dev -A
   kubectl get tektonconfig config -o jsonpath='{.status.version}{"\n"}{.spec.profile}{"\n"}'
   kubectl -n tekton-operator get cm tekton-config-defaults -o jsonpath='{.data.AUTOINSTALL_TEKTONHUB}{"\n"}'
   ```

   No TektonHub row means this cause. If the pipeline version is 4.14 or later, go to Cause 3 instead.

2. Install a TektonHub instance from the application marketplace on the cluster that runs the pipelines. This is the fix that restored the list on platform 4.3.2. Then reopen **Add Task**.

3. On the 4.12 operator line, the auto-install switch is an alternative to step 2.

   > **Warning:** Setting the flag and restarting `tekton-operator` pulls Hub images and creates Hub API and database Pods; setting `spec.profile` to `all` installs every component of that profile, not only Hub. Only when the list is empty, no TektonHub exists, and the flag is `"false"`. Rollback: restore the saved ConfigMap and the previous `spec.profile`, then restart the operator. Turning the flag off does not delete a TektonHub that was already created.

   ```bash
   kubectl -n tekton-operator get cm tekton-config-defaults -o yaml > /tmp/tekton-config-defaults.yaml
   kubectl -n tekton-operator patch cm tekton-config-defaults --type=merge -p '{"data":{"AUTOINSTALL_TEKTONHUB":"true"}}'
   # only when spec.profile is not already "all"
   kubectl patch tektonconfig config --type=merge -p '{"spec":{"profile":"all"}}'
   kubectl -n tekton-operator rollout restart deploy/tekton-operator
   kubectl -n tekton-operator rollout status deploy/tekton-operator
   kubectl get tektonhub.operator.tekton.dev -A
   ```

   Confirm the operator Deployment name with `kubectl -n tekton-operator get deploy` first.

4. If a TektonHub object exists and the list is still empty, check that the Hub API and database Pods are Ready and that the catalog has synchronized:

   ```bash
   kubectl get tektonhub.operator.tekton.dev -A -o jsonpath='{range .items[*]}{.metadata.name}{" "}{range .status.conditions[*]}{.type}{"="}{.status}{" "}{end}{"\n"}{end}'
   kubectl get pods -A | grep -Ei 'tekton-hub|hub-api|hub-db'
   kubectl logs -n <hub-namespace> <tekton-hub-api-pod> --tail=100 | grep -Ei 'catalog|sync|error'
   ```

   Repair a Pod that is not Ready, or the catalog error in the API log, before installing a second Hub.

### Cause 2: the Triggers webhook Role and RoleBinding are missing after an operator uninstall

1. Confirm that the Role and RoleBinding are gone and that the webhook log shows a forbidden error:

   ```bash
   kubectl get deploy,pods -A | grep -i 'triggers-webhook\|tekton-triggers'
   kubectl get role,rolebinding -A | grep -i trigger
   kubectl logs -n <triggers-namespace> deploy/<triggers-webhook> --tail=80
   ```

2. Restore both objects from a healthy cluster on the same operator version, or from that version's Triggers static manifests (installer sets named like `trigger-main-static`). Do not bind the webhook ServiceAccount to `cluster-admin` instead. If `TektonConfig` is Not Ready because an installer set is stuck terminating, follow "TektonConfig stuck Not Ready after Tekton operator upgrade on ACP" instead.

   ```bash
   kubectl apply -f /tmp/triggers-webhook-role.yaml
   kubectl apply -f /tmp/triggers-webhook-rolebinding.yaml
   ```

3. Restart the webhook.

   > **Warning:** Admission for trigger resources is unavailable for a few seconds; EventListener and trigger creates fail until the Pod is Ready. Only after the restored Role and RoleBinding come from the same operator version. Rollback: delete the applied objects if they were wrong; a restart alone does not remove them.

   ```bash
   kubectl -n <triggers-namespace> rollout restart deploy/<triggers-webhook>
   kubectl -n <triggers-namespace> rollout status deploy/<triggers-webhook>
   ```

4. Retry the operator install. If the task list is then empty, continue with Cause 1 or Cause 3.

### Cause 3: from pipeline 4.14, Tekton Hub is no longer bundled

1. Confirm the version and whether ArtifactHub Shim runs:

   ```bash
   kubectl get tektonconfig config -o jsonpath='{.status.version}{"\n"}'
   kubectl get pods -A | grep -i artifacthub
   ```

2. On 4.14 or later with no ArtifactHub Shim workload, install the `artifacthub-shim` plugin through the same plugin installation path used for other DevOps plugins. The Cause 1 flag does not bring the built-in Hub back on these versions.
3. Migrate existing custom catalogs to ArtifactHub Shim, following its documentation for the cross-namespace global `repository` ConfigMap. Copy the shape from a cluster where the task list already loads instead of inventing keys.
4. If the list is still empty, check that the Git host named in the repository configuration answers, and point the configuration at a reachable host:

   ```bash
   kubectl get configmap -A | grep -i repository
   kubectl exec -n <namespace> <running-pod> -- getent hosts <git-host>
   ```

### Cause 4: `devops-api` is wedged

1. Confirm `devops-api` is not Ready or its log shows it is stuck. A healthy `devops-api` with an empty list is Cause 1 or Cause 3.

   ```bash
   kubectl get deploy,pods -A | grep devops-api
   kubectl -n <namespace> logs deploy/<devops-api-deploy> --tail=80
   ```

2. Restart it.

   > **Warning:** The CICD task list and release API are unavailable until the new Pod is Ready. Only when every CICD task is gone and `devops-api` is unhealthy. If API calls are still slow from an etcd problem, wait until they answer, or the component wedges again. Rollback: none; a restart changes no configuration.

   ```bash
   kubectl -n <namespace> rollout restart deploy/<devops-api-deploy>
   kubectl -n <namespace> rollout status deploy/<devops-api-deploy>
   ```

   If the list empties again soon after, the etcd performance problem is still open; repeating the restart is not a fix.

### Cause 5: the operator owns `tekton-hub-api` and overwrites direct edits

1. Read the current list; the override replaces the whole `CATALOGS` value:

   ```bash
   kubectl -n <hub-namespace> get cm tekton-hub-api -o jsonpath='{.data.CATALOGS}{"\n"}'
   kubectl get tektonconfig config -o yaml > /tmp/tektonconfig.yaml
   ```

2. Put the full list, with your entries appended, under the override in `TektonConfig` `config` (example for `tektoncd-operator` release 4.12; keep your own existing entries):

   ```yaml
   spec:
     hub:
       options:
         disabled: false
         configMaps:
           tekton-hub-api:
             data:
               CATALOGS: |
                 - name: catalog
                   org: tektoncd
                   type: community
                   provider: github
                   url: file:////mnt/git/catalog.git
                   revision: master
                 - name: private-catalog
                   org: example
                   type: private
                   provider: gitlab
                   url: https://<gitlab-host>/devops/private-tekton-catalog.git
                   sshurl: git@<gitlab-host>:devops/private-tekton-catalog.git
                   revision: main
   ```

   > **Warning:** The operator rolls `tekton-hub-api`, so the Hub UI and task list are briefly unavailable; a malformed `CATALOGS` value can leave Hub with no catalogs. Rollback: `kubectl apply -f /tmp/tektonconfig.yaml`, or remove `spec.hub.options.configMaps`.

   ```bash
   kubectl edit tektonconfig config
   ```

3. For a private repository, create the SSH Secret in the Hub namespace:

   ```bash
   kubectl -n <hub-namespace> create secret generic tekton-hub-api-ssh-crds \
     --from-file=id_rsa=/path/to/id_rsa \
     --from-file=id_rsa.pub=/path/to/id_rsa.pub \
     --from-file=known_hosts=/path/to/known_hosts
   ```

4. Wait for `CATALOG_REFRESH_INTERVAL`, or restart the `tekton-hub-api` Pod. The catalog's tasks should appear in the Hub list.

## Diagnostic Steps

```bash
kubectl get tektonhub.operator.tekton.dev -A
kubectl get tektonconfig config -o jsonpath='{.status.version}{"\n"}{.spec.profile}{"\n"}'
kubectl -n tekton-operator get cm tekton-config-defaults -o jsonpath='{.data.AUTOINSTALL_TEKTONHUB}{"\n"}'
kubectl get role,rolebinding -A | grep -i 'triggers-webhook\|tekton-triggers'
kubectl get pods -A | grep -Ei 'artifacthub|devops-api'
```

| What you see | Cause |
| --- | --- |
| Empty list, no TektonHub object, pipeline version below 4.14 | 1 |
| Operator reinstall fails, Triggers webhook Role or RoleBinding missing, forbidden in the webhook log | 2 |
| Empty list after an upgrade to 4.15.1, or on 4.14, no ArtifactHub Shim workload | 3 |
| Every CICD task gone, `devops-api` not Ready | 4 |
| Custom catalog never appears, or a `tekton-hub-api` edit is reverted | 5 |

A stage list that is empty in a DevOps v4 pipeline while TektonHub is installed and Ready, with no API error, is not explained by this article.

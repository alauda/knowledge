---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
  - "4.4"
---

# Application updates are slow, status stays Failed or Processing, or delete hangs because of captain on ACP

## Issue

Native applications and Helm chart applications are reconciled by `captain` (`captain-controller-manager` and `captain-chartmuseum` in `cpaas-system`) through `HelmRequest` objects. When it is blocked, the console is open but:

- After a native application's template is updated, the Pods start rolling only after a long time (about 10 minutes, or never).
- A native application shows `失败(0/1)` or `失败(0/0)` (Failed) while its containers are `Running`.
- A pipeline-published native application stays on `处理中(1/1)` (Processing).
- Deleting a Helm application stays on `删除中` (Deleting) with `处理中(0/0)` for hours.
- `captain` crash-loops and application updates fail.
- A Helm application stays `删除中` (Deleting) while its workloads are still `Running`, so a redeploy cannot start.
- The native application page shows no compute components (`0/0`) while its Deployments are `Running`.
- An application exported to a chart and imported again stays processing (`0/0`) with no error and no event.
- A manual edit of an object rendered by the chart disappears at the next sync.
- The application history shows a new revision that nobody created.

The `captain` log often contains `Unauthorized, requeuing`, `failed to list *v1.HelmRequest: Unauthorized`, or a `nil pointer dereference` panic in the `chartrepo` controller.

## Root Cause

### Cause 1: one HelmRequest worker per cluster is blocked by failing chart applications

`captain` has one worker per cluster for `HelmRequest`. Failed HelmRequests keep retrying with back-off and occupy that worker, so new native application updates wait in the queue behind them. The `manager` container of `captain-controller-manager` repeats, for many different HelmRequests:

```text
helmrequest.go:31] Start sync helmrequest: <namespace>/<name>
clusterwatch.go:262] error syncing '<namespace>/<name>': Unauthorized, requeuing
```

Chart applications left abnormal from earlier failures cause this: updates that normally take about 3 minutes take about 10 minutes or never take effect. Restarting `captain-controller-manager` releases the stuck applications, but later updates stay slow until the failing chart applications are fixed or cleaned up.

### Cause 2: the native application status is out of sync with its workloads

The native application status combines `assemblyPhase` with whether the workload is running. `assemblyPhase` changes only when the application is created or updated through the console or the API. When several people trigger updates, those updates can conflict and `assemblyPhase` falls out of sync with the running Pods, which shows as `失败` (Failed) while the services work, sometimes with a tooltip from an old failed update. Triggering an update of the application from the console (**Update**, then **Confirm** with no change) restores the status. When the workloads are healthy, this status can be ignored.

### Cause 3: a pipeline-published application keeps spec.assemblyPhase Pending

The Application stays `处理中(1/1)` while its Deployment is `Running` and its events are clean, and a hand-created application of the same shape is normal. The Application (`app.k8s.io/v1beta1`) has `spec.assemblyPhase: Pending`. Setting it to `Succeeded` is the recommended fix. When that edit has no effect and the captain controller logs `failed to list *v1.HelmRequest: Unauthorized` (and ChartRepo objects log `not ready for resync`), the controller cannot list or watch HelmRequests, and restarting it lets the release finish.

### Cause 4: captain cannot authenticate to the chart repository

The application stays `失败(0/1)` while its workload is `Running`. The captain log shows the HelmRequest failing to fetch the chart:

```text
get chart {"name": "<repo>/<chart>", "version": "<version>"}
"reason": "FailedSync", "message": "Unauthorized"
```

The ChartRepo keeps logging `reconcile start`, and under **App Store Management** > **Template Repositories** the repository shows `同步中` (Syncing). The repository rejected the configured credentials.

### Cause 5: captain does not reload its ServiceAccount token

A chart that changes RBAC fails an update for lack of permission, and a later update as administrator still shows `Failed`. When `captain` reloads its ServiceAccount token, the reload does not work, and Helm updates start failing after some time. This is a product defect fixed in later versions; restarting `captain` is the workaround.

### Cause 6: a finalizer blocks the delete of a Helm application

The application list shows `删除中` with `处理中(0/0)`, the workloads are gone (`kubectl get deployment,pod -n <namespace>` returns `No resources found`), and the Application is in phase `Pending` with no events. `captain-controller-manager` repeats `error syncing ... Unauthorized, requeuing` and `Failed to watch *v1.HelmRequest: failed to list *v1.HelmRequest: Unauthorized`. Restarting it stops those errors but does not finish the delete; the finalizer on the Application is still set.

### Cause 7: captain crash-loops while sorting a chart repository index

The previous `captain` log shows, while the `chartrepo` controller reconciles a ChartRepo in `cpaas-system`:

```text
Observed a panic in reconciler: runtime error: invalid memory address or nil pointer dereference
"controller": "chartrepo", "controllerGroup": "app.alauda.io", "controllerKind": "ChartRepo"
```

The stack runs through `repo.ChartVersions.Less`, `IndexFile.SortEntries`, `loadIndex`, and `(*ChartRepoReconciler).syncCharts`: `captain` panics while sorting that repository's index entries. Removing the repository from the platform returns `captain` to `Running`.

### Cause 8: an expired captain certificate leaves a delete stuck while the workloads still run

The Application keeps phase `Succeeded` with `metadata.deletionTimestamp` set, and the matching HelmRequest is `phase: Synced` with a `deletionTimestamp`. The workloads are still `Running` because the uninstall never ran. `captain` logs `failed to list *v1.HelmRequest: Unauthorized` and `failed to watch *v1.HelmRequest: failed to list *v1.HelmRequest: Unauthorized`. The certificate `captain` uses expired and was not rotated. This is a product defect fixed in ACP 4.2.5; a `captain` that still holds the expired certificate, including on 4.2.5, needs a restart of `captain-controller-manager` and `metis`, after which the delete finishes. Unlike Cause 6, the workloads still exist and the finalizer is not removed by hand.

### Cause 9: no compute components because metis cannot impersonate groups

The console asks `metis` (Deployment `metis` in `cpaas-system`) to draw native-application components. When the ClusterRole bound to `system:serviceaccount:cpaas-system:metis` allows impersonating `users` but not `groups`, the page shows `0/0` while the Deployments are `Running`, and the application has an event:

```text
Failed: groups "<group>" is forbidden: User "system:serviceaccount:cpaas-system:metis" cannot impersonate resource "groups" in API group "" at the cluster scope
```

This gap exists on ACP 4.2.4. Adding the missing impersonation rule is the fix.

### Cause 10: a re-imported chart application stays processing because the Harbor registry is unhealthy

After an application is exported to a chart and imported again, it stays processing (`0/0`), `spec.assemblyPhase` stays `pending`, and there are no events. The ChartRepo can still be `Synced` while the Harbor `registry` component is unhealthy: the status sync of the chart-backed application times out talking to that registry. Repairing the Harbor registry ends the processing state; setting `spec.assemblyPhase` by hand (Cause 3) is not the repair.

### Cause 11: manual edits are reverted when the HelmRequest syncs

Objects changed with `kubectl edit` or in the console are put back to the rendered chart at the next HelmRequest sync. Persistent changes belong in HelmRequest `spec.values` or the Application annotation `app.cpaas.io/chart.values`.

### Cause 12: a captain restart re-applies applications and adds a revision nobody made

On ACP 3.12, when `captain` restarts, its check of whether a HelmRequest changed is faulty: it resyncs and re-applies the application's resources, which writes a new revision to the application history without any user action. The Kubernetes audit log shows a `patch` of the application's objects (for example a Service) with `fieldManager=manager`, user agent `Go-http-client/2.0`, by a platform service account such as `system:serviceaccount:kube-system:admin`, setting `app.kubernetes.io/managed-by: Helm`; the objects carry `meta.helm.sh/release-name`. This is a product defect fixed in ACP 3.15 and later.

## Resolution

### Cause 1: one HelmRequest worker per cluster is blocked by failing chart applications

1. Confirm that failing HelmRequests occupy the worker, and list abnormal applications:

   ```bash
   kubectl logs -n cpaas-system deploy/captain-controller-manager -c manager --tail=500 | grep -E 'Start sync helmrequest|Unauthorized, requeuing' | sort | uniq -c | sort -rn | head
   kubectl get helmrequest -A
   kubectl get application -A | grep -v Running
   ```

2. Fix or clean up the chart applications whose HelmRequests keep failing. This is the lasting step.

3. To release updates that are already stuck, restart `captain-controller-manager`.

   > **Warning:** HelmRequest processing pauses until the new Pod is `Ready`. A restart alone leaves later updates slow while failing HelmRequests remain. The Pod is recreated from the same spec.

   ```bash
   kubectl delete pod -n cpaas-system <captain-controller-manager-pod>
   ```

4. Once the failing applications are fixed or removed, native updates take effect within a few minutes. Also check the workload's own rollout strategy, for example `maxUnavailable: 0` with a readiness probe that does not pass, before attributing a slow rollout to `captain`.

### Cause 2: the native application status is out of sync with its workloads

Confirm that the containers are `Running`, then open **Update** on the application and click **Confirm** without changes. If the status stays failed, read the `captain` log before repeating.

### Cause 3: a pipeline-published application keeps spec.assemblyPhase Pending

1. Export the Application and set the field:

   > **Warning:** Setting `spec.assemblyPhase` by hand tells the console that the application finished assembling, and a wrong value can hide a real failure. Do this only when the workloads are `Running` and the events are clean. To roll back, apply the export.

   ```bash
   kubectl get application -n <namespace> <name> -o yaml > "$HOME/<name>-application.yaml"
   kubectl patch application -n <namespace> <name> --type=merge -p '{"spec":{"assemblyPhase":"Succeeded"}}'
   ```

2. If the edit has no effect, check the captain controller log and restart it:

   ```bash
   kubectl get pod -n cpaas-system | grep captain
   kubectl logs -n cpaas-system <captain-controller-pod> --tail=200 | grep -E 'failed to list \*v1.HelmRequest|not ready for resync'
   ```

   > **Warning:** Application releases pause until the new Pod is `Ready`. The Pod is recreated from the same spec.

   ```bash
   kubectl delete pod -n cpaas-system <captain-controller-pod>
   ```

### Cause 4: captain cannot authenticate to the chart repository

1. Confirm the chart fetch failure:

   ```bash
   kubectl logs -n cpaas-system deploy/captain-controller-manager --tail=300 | grep -E 'get chart|FailedSync|Unauthorized'
   ```

2. Open **App Store Management** > **Template Repositories**, select the repository, and correct the user name and password in its update dialog.

3. Restart the captain Pods.

   > **Warning:** Chart serving and HelmRequest processing pause until the Pods are `Ready`. Do this only after the credentials have been corrected.

   ```bash
   kubectl delete pod -n cpaas-system <captain-chartmuseum-pod> <captain-controller-manager-pod>
   ```

4. The repository leaves `同步中` and the application leaves `失败`. If `Unauthorized` remains with correct credentials, test the repository login from outside the platform.

### Cause 5: captain does not reload its ServiceAccount token

> **Warning:** Helm updates pause until the new Pod is `Ready`. The Pod is recreated from the same spec.

```bash
kubectl get pods -n cpaas-system | grep captain
kubectl delete pod -n cpaas-system <captain-pod>
```

Retry the Helm update after the new Pod is `Running`. Upgrade to a version that contains the fix.

### Cause 6: a finalizer blocks the delete of a Helm application

1. Export the Application and check `captain`:

   ```bash
   kubectl get application -n <namespace> <name> -o yaml > "$HOME/<name>-application.yaml"
   kubectl logs -n cpaas-system deploy/captain-controller-manager --tail=200 | grep -E 'Unauthorized|error syncing'
   ```

2. Restart `captain-controller-manager`, then remove the `finalizers` field from the Application.

   > **Warning:** Removing finalizers deletes the object without controller cleanup, and orphaned releases can remain. Do this only when the delete is stuck, the workloads are already gone, and a restart of `captain-controller-manager` did not finish it. This cannot be rolled back. If the finalizer is `chart.app.alauda.io` and the matching `helmrequests.app.alauda.io` object does not exist, this cause does not apply.

   ```bash
   kubectl delete pod -n cpaas-system <captain-controller-manager-pod>
   kubectl edit application -n <namespace> <name>
   ```

### Cause 7: captain crash-loops while sorting a chart repository index

1. Find the repository named in the panic:

   ```bash
   kubectl get pods -n cpaas-system | grep captain
   kubectl logs -n cpaas-system <captain-pod> --previous --tail=300 | grep -E 'Observed a panic|ChartRepo|SortEntries|loadIndex'
   kubectl get chartrepo -n cpaas-system
   ```

2. Save it and remove it from the platform chart repository list.

   > **Warning:** Applications that pull charts from this repository can no longer update. Do this only when `captain` crash-loops with the `chartrepo` nil pointer panic and the log names this ChartRepo. Applying the export restores it, and brings the crash loop back until its index is fixed.

   ```bash
   kubectl get chartrepo -n cpaas-system <repo-name> -o yaml > "$HOME/<repo-name>-chartrepo.yaml"
   ```

3. `captain` stays `Running`.

### Cause 8: an expired captain certificate leaves a delete stuck while the workloads still run

1. Confirm both the `deletionTimestamp` and the `Unauthorized` list/watch error (Diagnostic Steps), and record the images:

   ```bash
   kubectl -n cpaas-system get deploy captain-controller-manager metis \
     -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.template.spec.containers[0].image}{"\n"}{end}'
   ```

2. Restart both components. Below 4.2.5, also upgrade to 4.2.5 or later to get the fix.

   > **Warning:** Only when the `Unauthorized` error and a `deletionTimestamp` are both present. Impact: HelmRequest reconciliation and native-application status pause until both Deployments are `Ready`. The restart reloads access state and does not delete the Application. Rollback: `kubectl -n cpaas-system rollout undo deployment/<name>` for each.

   ```bash
   kubectl -n cpaas-system rollout restart deployment/captain-controller-manager deployment/metis
   kubectl -n cpaas-system rollout status deployment/captain-controller-manager
   kubectl -n cpaas-system rollout status deployment/metis
   ```

3. The uninstall runs and the Application leaves the console.

### Cause 9: no compute components because metis cannot impersonate groups

1. Check the permission and find the ClusterRole bound to metis. `no` plus the event text confirms this cause:

   ```bash
   kubectl auth can-i impersonate groups --as=system:serviceaccount:cpaas-system:metis
   kubectl get clusterrolebinding -o jsonpath='{range .items[*]}{.roleRef.name}{"\t"}{range .subjects[*]}{.namespace}{"/"}{.name}{" "}{end}{"\n"}{end}' | grep cpaas-system/metis
   ```

2. Add this rule to that ClusterRole:

   > **Warning:** The rule lets metis act as the groups named in user tokens. Add only this rule, to the ClusterRole already bound to metis; do not grant `impersonate` on `*`. Precondition: `kubectl get clusterrole <metis-role> -o yaml > metis-role.yaml`. Rollback: `kubectl apply -f metis-role.yaml`.

   ```yaml
   - apiGroups: [""]
     resources: ["groups"]
     verbs: ["impersonate"]
   ```

3. Run the `auth can-i` command again until it prints `yes`, then reopen the application; the Running Deployments are listed as compute components.

### Cause 10: a re-imported chart application stays processing because the Harbor registry is unhealthy

Repair the Harbor `registry` component until its Pods are `Ready` and Harbor reports the registry healthy, then retry the import or the HelmRequest sync. A ChartRepo in `Synced` is not evidence that the registry is healthy.

```bash
kubectl get application -n <namespace> <name> -o jsonpath='{.spec.assemblyPhase}{"\n"}'
kubectl get pods -A | grep harbor-registry
```

### Cause 11: manual edits are reverted when the HelmRequest syncs

Put the change in HelmRequest `spec.values` (or the `app.cpaas.io/chart.values` annotation of the Application) so the next sync renders it. Repeating the edit on the Deployment does not stick.

```bash
kubectl get helmrequest -n <namespace> <name> -o jsonpath='{.spec.values}{"\n"}'
kubectl edit helmrequest -n <namespace> <name>
```

### Cause 12: a captain restart re-applies applications and adds a revision nobody made

1. Compare the time of the unexplained revision with the start time of the `captain` Pod:

   ```bash
   kubectl get pods -n cpaas-system | grep captain
   kubectl get pod -n cpaas-system <captain-controller-manager-pod> -o jsonpath='{.status.startTime}{" "}{.status.containerStatuses[*].lastState}{"\n"}'
   ```

2. When they match and the audit log shows the `patch` described in Root Cause, the revision re-applied the application's own chart and needs no rollback. Hand edits made outside the chart are lost (Cause 11).
3. Upgrade to ACP 3.15 or later to stop restarts from creating revisions.

## Diagnostic Steps

```bash
kubectl get application -n <namespace> <name> -o yaml
kubectl get pods -n cpaas-system | grep captain
kubectl get helmrequest -A
kubectl logs -n cpaas-system deploy/captain-controller-manager --tail=500 \
  | grep -E 'Unauthorized|FailedSync|Observed a panic' | sort | uniq -c | sort -rn | head
```

```text
native updates slow, many HelmRequests Unauthorized, requeuing, abnormal chart apps -> Cause 1
失败 status, containers Running, several people updating                    -> Cause 2
pipeline application 处理中, spec.assemblyPhase Pending                       -> Cause 3
失败(0/1), get chart FailedSync Unauthorized, repository 同步中                -> Cause 4
Helm update stays Failed after a permission error, admin retry fails         -> Cause 5
Helm delete stuck, workloads gone, error syncing Unauthorized                -> Cause 6
captain crash-loop, chartrepo panic in SortEntries                           -> Cause 7
Deleting, workloads still Running, deletionTimestamp, list HelmRequest Unauthorized -> Cause 8
0/0 components, event: metis cannot impersonate resource "groups"            -> Cause 9
re-imported chart app processing, assemblyPhase pending, Harbor registry down -> Cause 10
objects revert after a sync                                                  -> Cause 11
unexplained revision at a captain restart, audit patch by fieldManager=manager -> Cause 12
```

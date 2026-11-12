---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Plugin install or uninstall stuck, or Marketplace and OperatorHub empty: sentry OOMKilled or cluster-transformer errors

## Issue

- Uninstalling the monitoring or logging plugin of a cluster hangs: the plugin stays in deleting and its Pods are not removed. Removing the `finalizers` from the ModuleInfo makes the entry vanish from the console, but the resources stay on the cluster.
- All functional components of a business cluster are abnormal with `ChartDownloadFailed [1/1] failed to download chart acp/chart-acp-business-v4.0.32, err: EOF`, although the business cluster reaches `global` on ports 443 and 11443.
- `kubectl get ars -n cpaas-system` shows `prometheus` with `ChartDownloadFailed` / `failed to download chart ... err: EOF`, or `logcenter` stuck in `Syncing` with `chart ... Installing`.
- The NeuVector plugin uninstall from the console stays in uninstalling and its Pods are not deleted.
- The `global` cluster UI shows the Alauda Container Platform Marketplace component as abnormal, while `kubectl get ars` looks normal.
- On `global`, the `alauda-operators` AppRelease reports `failed to resync chart for release "install-operators": execution error at (install-operators/templates/notes.yaml:14:8)`, and OperatorHub shows no operators.

`sentry` (Deployment `sentry` in `cpaas-system` on each cluster) installs, upgrades, and removes plugin charts and records the result on the `ars` (AppRelease) objects. `cluster-transformer` on `global` turns ModulePlugins into ModuleConfigs and reconciles ModuleInfo (`minfo`) and ClusterModule.

Related articles: "sentry at full CPU or a redeployed component fails because of Failed or leftover ResourcePatches on ACP".

## Root Cause

### Cause 1: sentry is OOMKilled or short of resources, so chart sync, install, and uninstall stop

`kubectl describe pod` on the `sentry` Pod shows `Last State: Terminated`, `Reason: OOMKilled`, `Exit Code: 137`, with a growing restart count, and the AppReleases of the cluster stay in `Syncing` / `Installing` or report `ChartDownloadFailed ... err: EOF`. The `sentry` Pods can still show `1/1 Running`.

- System plugin uninstall fails (for example on an ACP 3.12 workload cluster): `logcenter` is `Syncing` with `[1/1] chart ait/chart-alauda-log-center-v3.12.38 Installing`, `prometheus` is `ChartDownloadFailed` with `[2/2] failed to download chart ait/chart-kube-prometheus-v3.12.9, err: EOF`, and the `sentry` container restarts with `OOMKilled` under a `4Gi` memory limit. Raising the memory limit and restarting `sentry` lets the AppReleases sync and the uninstall complete.
- A monitoring uninstall is stuck with the Prometheus ModuleInfo in deleting. Removing its `finalizers` removes the component from the console only; the backend resources stay. With `sentry` given more memory, deploying the component again from the console and uninstalling it again completes the uninstall. Removing ModuleInfo finalizers does not perform an uninstall.
- Every functional component of a business cluster is abnormal (`ChartDownloadFailed ... err: EOF`) while the network to `global` is fine: `sentry` does not have enough resources to reconcile every component at the same time. Increasing its resources returns the AppReleases to normal.

### Cause 2: A plugin uninstall stays in uninstalling with no identified cause (NeuVector)

The NeuVector plugin uninstall from the console stays in uninstalling, and the Pods in `neuvector` are not deleted. No underlying cause has been identified. The uninstall is finished by deleting the plugin's ModuleInfo, then the resources in the `neuvector` namespace and the namespace itself. Because deleting the ModuleInfo alone only clears the console entry (Cause 1), the namespace contents are removed by hand.

### Cause 3: Marketplace component abnormal, get registry client is nil

The Marketplace component shows abnormal on `global`, AppReleases look normal, and the `cluster-transformer` log repeats:

```text
ModuleInfo Reconcile ... error: ... error calling imageExist: get registry client is nil
get moduleconfig structure error: template: :34:16: executing "" at <imageExist "acp/chart-vela-core" "v3.18.1">: error calling imageExist: get registry client is nil
ClusterModule Process '<cluster>' error: handle plugin marketplace failed: ClusterModule need retry
```

with the same `need retry` for `auth-manager`, `acp-business`, and `sentry`, and `ProcessPlugin ... get render data metallb error: ... get registry client is nil`. `cluster-transformer` cannot reach the image registry, so the `imageExist` check in the plugin templates fails and ModuleInfo / ClusterModule processing stops. Restoring network connectivity to the registry returns the component to normal.

### Cause 4: failed to resync chart for release "install-operators" and OperatorHub on global is empty

```text
failed to resync chart for release "install-operators": execution error at (install-operators/templates/notes.yaml:14:8)
```

appears on the `alauda-operators` AppRelease of `global`, and OperatorHub in the App Marketplace lists no operators. No underlying cause has been identified. Restarting `cluster-transformer` and `sentry` restores service.

## Resolution

### Cause 1: sentry is OOMKilled or short of resources, so chart sync, install, and uninstall stop

On the affected cluster:

```bash
kubectl get ars -n cpaas-system
kubectl -n cpaas-system get pods | grep sentry
kubectl -n cpaas-system describe pod <sentry-pod> | grep -E -A6 'Last State|Limits|Requests'
kubectl -n cpaas-system get deploy sentry -o yaml > "$HOME/sentry.before.yaml"
```

> **Warning:** Changing the `sentry` resources restarts it; chart installs, upgrades, and uninstalls on the cluster pause until the new Pod is Ready, and a higher request reserves more node memory. Precondition: only when the `sentry` container's last state is `OOMKilled` (or it cannot keep up with every AppRelease) and AppReleases are stuck in `Syncing`, `Installing`, or `ChartDownloadFailed ... EOF`. Rollback: `kubectl apply -f "$HOME/sentry.before.yaml"`.

```bash
kubectl -n cpaas-system set resources deploy sentry --limits=memory=<memory-limit>
kubectl -n cpaas-system rollout status deploy sentry
```

Choose a limit above the one the container was killed at. After a few minutes, check that `kubectl -n cpaas-system get deploy sentry -o jsonpath='{.spec.template.spec.containers[*].resources}'` still shows the new limit; if it reverted, ask Alauda support where the `sentry` resources are configured on your version. Then watch the AppReleases:

```bash
kubectl get ars -n cpaas-system -w
```

For a stuck uninstall whose ModuleInfo finalizers were already removed while the resources are still on the cluster: deploy the plugin again from the console, wait until it is installed, and uninstall it again. Do not remove ModuleInfo finalizers as a way to uninstall while the plugin's resources are still on the cluster.

One finalizer removal is valid: the Log Agent plugin stays in Uninstalling, its workloads (`nevermore` and `kubernetes-event-exporter`) are already deleted from that cluster, and only the logagent `minfo` remains, in Deleting, with `finalizers: - moduleinfo`. There, removing the finalizer on `global` finishes the uninstall.

> **Warning:** Removing `finalizers` lets the ModuleInfo be deleted without the controller's cleanup, and anything that cleanup would have removed stays on the cluster. Precondition: only with the exact Log Agent signature above. Save the `minfo` YAML first. Rollback: none for the deleted object; deploy the plugin again from the console if it was removed by mistake.

```bash
kubectl get minfo <logagent-minfo> -o yaml > "$HOME/<logagent-minfo>.yaml"
kubectl patch minfo <logagent-minfo> --type=merge -p '{"metadata":{"finalizers":null}}'
```

### Cause 2: A plugin uninstall stays in uninstalling with no identified cause (NeuVector)

Rule out Cause 1 first: `sentry` must be Running without `OOMKilled` restarts; otherwise fix it and retry the uninstall from the console. Then look at what is left:

```bash
kubectl get minfo | grep -i neuvector
kubectl -n neuvector get all
kubectl get all,cm,secret,pvc -n neuvector -o yaml > "$HOME/neuvector-namespace.yaml"
```

> **Warning:** This removes NeuVector from the cluster without the plugin's own cleanup; container security policies and NeuVector data in that namespace are deleted. Irreversible apart from reinstalling the plugin. Precondition: only when the console uninstall of NeuVector is stuck in uninstalling, `sentry` is healthy, and the export above is written. Rollback: install the NeuVector plugin again from Cluster Plugins.

```bash
kubectl delete minfo <neuvector-minfo>
kubectl -n neuvector delete all --all
kubectl delete namespace neuvector
kubectl get namespace neuvector
```

If the namespace stays in `Terminating`, list what is left with `kubectl api-resources --verbs=list --namespaced -o name | xargs -n 1 kubectl get --show-kind --ignore-not-found -n neuvector` and delete those objects.

### Cause 3: Marketplace component abnormal, get registry client is nil

```bash
kubectl -n cpaas-system logs deploy/cluster-transformer --tail=500 | grep -E 'registry client is nil|need retry'
```

Take the registry address from Clusters > `global` > Overview > Basic Info > Image Repository Address, and test it from the `global` control-plane nodes:

```bash
curl -k -s -o /dev/null -w '%{http_code}\n' https://<registry-address>/v2/
```

`000` or a timeout means the path is broken. Restore network connectivity from `global` to the registry (routing, firewall, DNS, or the registry service itself). The `need retry` errors stop and the Marketplace component returns to normal once the registry is reachable.

### Cause 4: failed to resync chart for release "install-operators" and OperatorHub on global is empty

```bash
kubectl get ars -A | grep -i alauda-operators
kubectl -n <ars-namespace> describe ars alauda-operators | grep -i -A3 'resync'
```

> **Warning:** Restarting `cluster-transformer` and `sentry` pauses plugin processing and chart sync on `global` until the new Pods are Ready; installs and upgrades in flight wait. Precondition: only when `alauda-operators` shows the `install-operators` `notes.yaml` resync error and OperatorHub on `global` is empty. Rollback: none needed; the Deployments recreate the Pods.

```bash
kubectl -n cpaas-system rollout restart deploy/cluster-transformer deploy/sentry
kubectl -n cpaas-system rollout status deploy/cluster-transformer
kubectl -n cpaas-system rollout status deploy/sentry
kubectl get ars -A | grep -i alauda-operators
```

## Diagnostic Steps

```bash
kubectl get ars -A | grep -v -E 'Synced|Ready'
kubectl -n cpaas-system get pods | grep -E 'sentry|cluster-transformer'
kubectl -n cpaas-system describe pod <sentry-pod> | grep -A5 'Last State'
kubectl -n cpaas-system logs deploy/cluster-transformer --tail=300 | grep -E 'registry client is nil|need retry'
```

- `sentry` `OOMKilled` (exit code `137`) with AppReleases stuck or `ChartDownloadFailed ... EOF`, or a stuck uninstall: Cause 1.
- A NeuVector uninstall stuck while `sentry` is healthy: Cause 2.
- `get registry client is nil` from `cluster-transformer`: Cause 3.
- The `install-operators` `notes.yaml` resync error with an empty OperatorHub: Cause 4.
- One `sentry` Pod near its CPU limit, or `Failed` ResourcePatches: see the related ResourcePatch article.

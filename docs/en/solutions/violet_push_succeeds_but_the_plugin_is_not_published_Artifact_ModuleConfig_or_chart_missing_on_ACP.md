---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.16"
  - "4.0"
  - "4.2"
  - "4.3"
---

# violet push succeeds but the plugin is not published: Artifact, ModuleConfig, or chart missing on ACP

## Issue

`violet push` finishes without an error, yet the plugin cannot be used:

- Cluster Plugins shows the package as not published (`未上架`), or the Publish Software Package page lists it with no version. OperatorHub can show the same package as not onboarded.
- The uploaded packages menu lists the package with the right upload time while Cluster Plugins shows nothing (for example Alauda Build of NPU Operator and Alauda Build of Node Feature Discovery).
- The marketplace keeps showing the old version after a new one was pushed (for example `hyperflux` 1.4.2 on ACP 4.2.3).
- `kubectl get moduleplugins` lists the plugin, but `kubectl get moduleconfigs` returns nothing for it and the page never offers it (for example Machine Configuration).
- An ARM plugin (for example the DCS provider on ACP 4.2.4) shows `State: Absent` and no version in Cluster Plugins, with the banner "This plugin has not been uploaded to the current cluster", and cannot be deployed.
- The upload command for the HAMi plugin completed, the platform registry is Harbor, and the target cluster has no HAMi plugin; Harbor instances in other regions also lack its charts.

Related articles: "violet push fails to parse a package, or a new operator version is skipped or missing on ACP" covers push errors and missing versions. "Pushed package not listed where expected: global-only plugins, cluster affinity, catalog source, or plugin type on ACP" covers packages that exist but are shown only on `global`, only in another catalog, or without a status by design.

## Root Cause

### Cause 1: Artifact and ArtifactVersion were never created because cluster-transformer stopped processing the ModulePlugin

`violet push` reports success, the module-plugin object (`mplugin`) exists, often with no `status` field at all, while `artifact` and `artifactversion` for the package do not. `cluster-transformer` has not written those objects, so the plugin page has nothing to render. The upload itself succeeded; restarting Deployment `cluster-transformer` in `cpaas-system` makes the objects appear. Pushing the same tarball again, restarting the OLM catalog Pods, `catalog-operator`, or `marketplace-apiserver`, or re-pushing with a newer `violet` does not help. Why `cluster-transformer` stops processing the ModulePlugin is not known.

Variants of the same signature:

- `violet push` prints `already exists, skip push` for the images and `moduleplugin <name> has been updated successfully cluster=global type=plugin`; `kubectl get artifact -A | grep <name>` returns nothing; the `marketplace-apiserver` log only shows `"OnModulePluginChanged events" logger="storage-provider" eventType="ADDED" name="<name>"`.
- A ModuleConfig exists without a `status`, and none of the `cluster-transformer`, catalog, OLM, or ModuleInfo logs mention the plugin (for example `asm-global` 4.3.4, ARM build, on ACP 4.3.1).
- Only the `moduleplugin` exists for a new version (for example `hyperflux` 1.4.2 pushed with `violet` 4.2.11). Deleting the old version from the uploaded packages page leaves no artifacts at all; restarting `cluster-transformer` and then pushing the plugin again makes the new version display.
- After a package was first pushed to a control-plane node address by mistake and then to the platform access address, the UI still shows it as not uploaded although `apollo`, `cluster-transformer`, and `cluster-transformer-apiservice` are `1/1 Running`. Restarting those Pods brings the plugins to listed (`已上架`).

### Cause 2: ModulePlugin exists but no ModuleConfig was generated

`kubectl get moduleplugins` returns the plugin with the pushed chart version (for example `machine-config` `v4.0.18`, chart `ait/chart-machine-config`), `kubectl get moduleconfigs` returns nothing for it, and a repeated `violet push ... --clusters=global --force` changes nothing. This is the same `cluster-transformer` stall as Cause 1, one object later. Restarting `cluster-transformer` produces the ModuleConfig and the plugin can be installed.

### Cause 3: sentry cannot pull the plugin chart because the registry's anonymous access was removed

`violet` reports success (for example `found image .../ait/chart-cluster-api-provider-kubeadm:v1.0.8 already exists, skip push` and `moduleplugin cluster-api-provider-kubeadm has been created successfully cluster=global type=plugin`), but Marketplace > Cluster Plugins on `global` shows the plugin with `State: Absent`, an empty Version, and the banner "This plugin has not been uploaded to the current cluster. To install it, please complete the upload process first." No `Artifact`, `ArtifactVersion`, or PackageManifest exists, and the ModulePlugin YAML carries an error that `sentry` failed to pull the plugin chart.

At the same time the `catalog-operator` log can show `failed to list bundles: rpc error: code = Unavailable ... dial tcp <registry-pod-ip>:50051: connect: connection refused`, `failed to populate resolver cache from source platform/cpaas-system`, and `ResolutionFailed` / `CatalogSourcesUnhealthy`; restarting the OLM catalog Pod does not change the plugin state. The ModulePlugin error is the one that decides this cause.

The anonymous user was deleted from the platform image registry (and the registry credentials were changed), so `sentry` can no longer pull the chart and the plugin never moves from not listed to listed. Re-downloading and re-pushing the package does not help. Adding the anonymous user back to the registry restores the chart pull.

### Cause 4: The Harbor registry has no mlops project, so the HAMi images and charts were never stored

The HAMi and DCGM exporter images and charts are pushed under the `mlops` repository path. AI components are not part of the standard product, so Harbor does not contain the `mlops` project by default, and without it the push of those artifacts fails even though the command reports success. After the `mlops` project is created and the package is pushed again, the Harbor of the `global` cluster's region holds `mlops/dcgm-exporter`, `mlops/chart-dcgm-exporter`, `mlops/hami-webui-fe-oss`, `mlops/hami-webui-be-oss`, `mlops/chart-hami-webui`, `mlops/hami`, and `mlops/chart-hami`. When several regions each have their own Harbor, the other Harbor instances still lack them: push once against each Harbor (creating `mlops` wherever it is missing), or use Harbor replication.

## Resolution

### Cause 1: Artifact and ArtifactVersion were never created because cluster-transformer stopped processing the ModulePlugin

Confirm the push reported success, `mplugin` exists, and `artifact` / `artifactversion` for the package do not. Skip this restart when the plugin is global-only and the push targeted another cluster.

```bash
kubectl get mplugin -A
kubectl get artifact,artifactversion -A | grep -i <plugin-name>
kubectl get mplugin <plugin-name> -o jsonpath='{.status}{"\n"}'
kubectl -n cpaas-system get deploy cluster-transformer
```

> **Warning:** Restarting `cluster-transformer` pauses plugin synchronization until the new Pod is Ready; in-flight plugin installs wait. Precondition: only when `violet push` succeeded, `mplugin` for the package exists, and `artifact` / `artifactversion` for it are missing (or the publish page shows the package with no version). Rollback: none needed. If the page is still empty after the new Pod is Ready, collect the controller log and the `mplugin` YAML before repeating the restart.

```bash
kubectl -n cpaas-system rollout restart deployment/cluster-transformer
kubectl -n cpaas-system rollout status deployment/cluster-transformer
kubectl get artifact,artifactversion -A | grep -i <plugin-name>
```

The plugin page should show the package as published, with a version. If a new version still does not show after the restart, push the same package once more:

```bash
violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password='<platform-admin-password>' <package>.tgz
```

If the UI still shows the plugin as not uploaded while `artifact` / `artifactversion` now exist, restart `apollo` and `cluster-transformer-apiservice` as well.

> **Warning:** Restarting `apollo` briefly interrupts the console views it serves, and restarting `cluster-transformer-apiservice` briefly interrupts the plugin API. Precondition: only after the `cluster-transformer` restart, when `artifact` / `artifactversion` exist and the UI still shows the plugin as not uploaded. Rollback: none needed; the Deployments recreate the Pods.

```bash
kubectl -n cpaas-system get pods | grep -E 'apollo|transformer'
kubectl -n cpaas-system delete pod <apollo-pod-1> <apollo-pod-2> <cluster-transformer-apiservice-pod-1> <cluster-transformer-apiservice-pod-2>
```

If `artifact` is still missing after the restart, check the package (see the related article on parse errors) or the chart pull (Cause 3) instead of restarting again.

### Cause 2: ModulePlugin exists but no ModuleConfig was generated

Run on `global`:

```bash
kubectl get moduleplugins <plugin-name> -o yaml
kubectl get moduleconfigs | grep <plugin-name>
```

When the ModulePlugin shows the chart version you pushed and no ModuleConfig exists for it, restart `cluster-transformer` with the Warning and commands in Cause 1 (the precondition extends to this signature). Then check again:

```bash
kubectl get moduleconfigs | grep <plugin-name>
```

The ModuleConfig appears and the plugin becomes installable from Cluster Plugins.

### Cause 3: sentry cannot pull the plugin chart because the registry's anonymous access was removed

Read the ModulePlugin and the `sentry` log for the chart pull error:

```bash
kubectl get moduleplugin <plugin-name> -o yaml | grep -n -i -B2 -A4 'pull\|error'
kubectl -n cpaas-system logs <sentry-pod> --tail=300 | grep -i '<plugin-name>'
kubectl -n cpaas-system logs deploy/catalog-operator --tail=200 | grep -E 'failed to list bundles|resolver cache|CatalogSourcesUnhealthy'
```

Check whether the platform image registry still accepts anonymous access. A request without credentials that used to succeed and now returns `401` means anonymous access is gone:

```bash
curl -k -s -o /dev/null -w '%{http_code}\n' https://<platform-registry-host>/v2/<chart-repository>/tags/list
```

Restore the anonymous user on the platform image registry, configured as before the change (compare with a healthy environment of the same version). If the registry credentials were also changed, make sure the credentials the platform uses for the registry match the new ones. Then check that the ModulePlugin error clears and that `artifact` / `artifactversion` appear:

```bash
kubectl get artifact,artifactversion -A | grep -i '<plugin-name>'
```

### Cause 4: The Harbor registry has no mlops project, so the HAMi images and charts were never stored

Check whether the project exists in each Harbor the clusters pull from:

```bash
curl -k -s -u '<harbor-admin>:<password>' "https://<harbor-host>/api/v2.0/projects?name=mlops"
curl -k -s -u '<harbor-admin>:<password>' "https://<harbor-host>/api/v2.0/projects/mlops/repositories?page_size=50" | grep -o '"name":"[^"]*"'
```

An empty project list is this cause. Create the `mlops` project in that Harbor (Harbor UI > Projects > New Project, or the API below), then push the HAMi package again:

```bash
curl -k -s -u '<harbor-admin>:<password>' -H 'Content-Type: application/json' -X POST "https://<harbor-host>/api/v2.0/projects" -d '{"project_name":"mlops"}'
violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password='<platform-admin-password>' <hami-package>.tgz
```

Check that the `mlops` repositories listed in the Root Cause now exist. For Harbor instances in other regions, repeat the project creation and the push against each Harbor, or replicate the `mlops` project with a Harbor replication rule.

## Diagnostic Steps

Separate a controller stall from a bad file before restarting anything:

```bash
violet version
kubectl get mplugin -A
kubectl get artifact,artifactversion -A
kubectl get moduleconfigs | grep <plugin-name>
kubectl get moduleplugin <plugin-name> -o yaml | grep -n -i 'failed to pull'
tar -tzf <package>.tgz >/dev/null
```

- Push success, `mplugin` present (often with no `status`), `artifact` / `artifactversion` absent: Cause 1.
- ModulePlugin present, no ModuleConfig: Cause 2.
- A ModulePlugin error that `sentry` failed to pull the chart: Cause 3.
- HAMi (or another AI component) missing after a successful push to a Harbor registry without an `mlops` project: Cause 4.
- `unexpected EOF` from `violet` or `tar`, or an ArtifactVersion that is `Failed` or skipped as already existing: see the related article on parse errors and missing versions.

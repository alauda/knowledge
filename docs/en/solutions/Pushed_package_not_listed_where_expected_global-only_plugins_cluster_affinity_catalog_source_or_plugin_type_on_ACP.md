---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.2"
  - "4.3"
---

# Pushed package not listed where expected: global-only plugins, cluster affinity, catalog source, or plugin type on ACP

## Issue

`violet push` succeeded and the objects exist, but the package does not show where it is expected:

- The push targeted a DevOps or other business cluster and the Cluster Plugins page there stays empty (GitOps, `asm-global`).
- `violet push` reported success, the plugin is not under the business cluster's Cluster Plugins, and a business-side Harbor reports an image as present although it is not there.
- A cluster plugin can only be uploaded to `global`, and it is unclear which setting has to change, or how to name another cluster as the upload target.
- MetalLB was pushed with `--clusters <workload-cluster>`, the output says `moduleplugin metallb has been updated successfully cluster=global type=plugin`, and Cluster Plugins for that workload cluster (an HCS cluster) shows `No data` for MetalLB.
- The ClickHouse log plugin (`logclickhouse`) was uploaded for a dual-stack cluster and never appears in that cluster's plugin list, even after restarts and re-uploads.
- Flagger packages were pushed and are not in the expected package list.
- Kyverno was pushed, Cluster Plugins shows it as listed, and OperatorHub shows it as not listed.
- After a directory push, some `.tgz` packages show neither `present` nor `success`, and pushing again changes nothing.
- On ACP 4.0.3 no standalone ASM plugin package can be found.
- On a new ACP 4.3.0 installation, `envoy-gateway-operator` and `ingress-nginx-operator` seem absent from the marketplace and no Pods exist for them.

Each of these is expected behavior for that package. A push whose `artifact` / `artifactversion` were never created is a different problem (see "violet push succeeds but the plugin is not published: Artifact, ModuleConfig, or chart missing on ACP").

## Root Cause

### Cause 1: The plugin can only run on global

The GitOps plugin is restricted to the `global` cluster: a successful push for a DevOps cluster does not create a plugin entry on that cluster, and raising the GitOps package to 4.3.0 does not remove the restriction. On ACP 4.0.3 the `asm-global` cluster plugin behaves the same way and is displayed only in the `global` cluster.

### Cause 2: violet push without --clusters targets global and its built-in registry

`violet push` without `--clusters <cluster_name>` uploads to the `global` cluster, and the default push target is the `global` cluster's built-in registry, not a business-side Harbor; an image check in that Harbor does not tell whether the push worked.

For cluster plugins this is not a default that can be changed. The `--clusters` parameter is not needed when uploading a cluster plugin, because the platform distributes the plugin to clusters automatically according to its affinity configuration; if `--clusters` is given, it is ignored. A cluster plugin is always uploaded to `global`, and no plugin configuration needs to change. Older built-in help that says plugins go "only to the `global` cluster" describes the same behavior. `--clusters` matters for operator packages (`type=bundle`), not for cluster plugins (`type=plugin`).

### Cause 3: ModulePlugin clusterAffinity does not match the target cluster

A ModulePlugin can carry an `affinity` block, and the plugin is offered only to clusters that match it. Re-uploading and restarting `cluster-transformer` or OLM does not change that.

- `clusterAffinity.matchLabels`: the ClickHouse log plugin `logclickhouse` (version 4.3.1) carries `cpaas.io/protocol-stack: IPv4/IPv6`, so it is not offered to a cluster without that label (for example a newly installed ACP 4.3.2 x86 dual-stack cluster). Removing that entry from `moduleplugin logclickhouse` makes the plugin appear and publishable.
- `clusterAffinity.matchExpressions`: the `metallb` ModulePlugin (`metallb.amd64.v4.2.5.tgz`) carries key `cluster-type`, operator `In`, values `Baremetal` and `DCS`. An HCS workload cluster does not match, so MetalLB is registered on `global` but never offered for that cluster, and pushing again only prints `already exists, skip push` and `moduleplugin metallb has been updated successfully cluster=global type=plugin`. Adding `HCS` to the values makes MetalLB available for that cluster.

### Cause 4: The package is registered in the system catalog, not the platform catalog

The Flagger packages have catalog source `system`, not `platform`, so they are not listed in the platform catalog; they appear under Installed Plugins. Both are installed automatically by the `global` cluster controller when a service mesh is created, so no manual installation is needed.

### Cause 5: The package is a cluster plugin, not an Operator

The `violet push` output says `moduleplugin <name> has been created successfully cluster=global type=plugin`. Kyverno `v4.2.3` (`kyverno.ALL.v4.2.3.tgz`) is delivered as a cluster plugin (`moduleplugin`, `type=plugin`), not as an Operator, so it never appears in OperatorHub. The "Kyverno Operator" card that a search for `kyverno` finds in OperatorHub on `global` (Community, provided by Kyverno, status `未上架`, not listed) is a separate community operator; its status is unrelated, and Kyverno is not deployed from Operators.

Cluster plugins are managed through the cluster-level CRDs `ModulePlugin`, `ModuleConfig`, and `ModuleInfo`. A plugin is published with `violet` to the `global` cluster only, and the platform then creates its `ModulePlugin` and `ModuleConfig` there; it can be installed on `global` or on any workload cluster, and installing it creates a `ModuleInfo`. Even `--clusters "global,<cluster-a>,<cluster-b>"` reports `cluster=global type=plugin`.

### Cause 6: Chart-type packages show no present or success status

After a directory push (for example with `violet` 4.2.9), `kubectl get artifactversion -A | grep -vi succe` lists ArtifactVersions in `cpaas-system` with empty PHASE and REASON columns (for example `chart-milvus-operator.v1.3.5`, `dify.v1.11.4`, `kubeflow-model-registry.v1.10.10`, `label-studio.v1.21.0-2`), and their artifact is `type: chart`. Artifacts of type `chart` are not reconciled, so their ArtifactVersion has no phase or status. `present: true` with the version in `spec` confirms the push succeeded. The empty status needs no fix. It does not prove the version is displayed; see "Pushed Helm chart version not shown because violet reused an Artifact of another chart repository on ACP" when the new chart version is also missing from the platform.

### Cause 7: ACP 4.0.3 ships plugins inside the extension package

In 4.0.3 the extension package is not split into individual plugin packages. It bundles every plugin, including ASM. Take the ASM plugin from the 4.0.3 extension package.

### Cause 8: Operators shipped with the release show as ready and have no Pods until they are deployed

`envoy-gateway-operator` and `ingress-nginx-operator` are shipped with 4.3.0. In the platform's operator list they are in the `ready` state, next to many operators in the `absent` state, which makes them easy to overlook. No Pods exist because neither operator has been deployed yet.

## Resolution

### Cause 1: The plugin can only run on global

Push and install the plugin on the `global` cluster, then open Cluster Plugins on `global`. Confirm the same restriction before treating any other package as global-only; it is established for GitOps and `asm-global`.

```bash
violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password='<platform-admin-password>' --clusters global <gitops-package>.tgz
```

### Cause 2: violet push without --clusters targets global and its built-in registry

Look for the plugin on `global` first:

```bash
kubectl get moduleplugins | grep -i <plugin-name>
kubectl get artifact -A | grep -i <plugin-name>
```

To make an operator package (`type=bundle`) available to a business cluster, name that cluster explicitly:

```bash
violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password='<platform-admin-password>' --clusters <cluster-name> <operator-package>.tgz
```

For a cluster plugin (`type=plugin` in the push output), push without `--clusters`. If it is not offered to the cluster you expect, read its affinity (Cause 3) instead of pushing again with another `--clusters` value.

### Cause 3: ModulePlugin clusterAffinity does not match the target cluster

Read the affinity on the ModulePlugin and compare it with the labels and type of the target cluster:

```bash
kubectl get moduleplugin <plugin-name> -o yaml > "$HOME/moduleplugin-<plugin-name>.before.yaml"
grep -n -A8 'affinity' "$HOME/moduleplugin-<plugin-name>.before.yaml"
```

> **Warning:** Changing `clusterAffinity` makes the plugin eligible for clusters the package author excluded. Installing it on a cluster the plugin does not support can fail or misbehave. Precondition: only when the plugin is missing from the cluster plugin list, its affinity does not match the target cluster, you have confirmed the plugin is meant to run there, and the export above is kept. Rollback: `kubectl apply -f "$HOME/moduleplugin-<plugin-name>.before.yaml"`. A later push of the same package may also restore the original ModulePlugin.

```bash
kubectl edit moduleplugin <plugin-name>
```

For a `matchLabels` entry such as `cpaas.io/protocol-stack: IPv4/IPv6` on `logclickhouse`, delete that line (and the now-empty `matchLabels` / `clusterAffinity` keys if nothing else remains). For a `matchExpressions` list such as the `metallb` `cluster-type` values, add the missing cluster type instead of removing the expression:

```yaml
spec:
  affinity:
    clusterAffinity:
      matchExpressions:
        - key: cluster-type
          operator: In
          values:
            - Baremetal
            - DCS
            - HCS
```

Save, then open Cluster Plugins for the target cluster.

### Cause 4: The package is registered in the system catalog, not the platform catalog

```bash
kubectl get packagemanifest -A -o custom-columns=NAME:.metadata.name,CATALOG:.status.catalogSource | grep -i flagger
```

Catalog `system` means the package is expected to be absent from the platform catalog; look for it under Installed Plugins. For Flagger, no manual installation is needed.

### Cause 5: The package is a cluster plugin, not an Operator

```bash
kubectl get moduleplugins | grep -i kyverno
kubectl get artifact -A | grep -i kyverno
```

If the ModulePlugin is missing, push the package:

```bash
violet push kyverno.ALL.v4.2.3.tgz --platform-address <platform-access-address> --platform-username <platform-admin-name> --platform-password '<platform-admin-password>'
```

Then open Cluster Plugins, select the cluster that should run Kyverno in the cluster selector, and install it there. The Upload Packages page (App Market Management, `上架软件包`) with the same cluster selector shows whether the package is offered to that cluster. Check the result on `global`:

```bash
kubectl get minfo | grep -i kyverno
```

### Cause 6: Chart-type packages show no present or success status

```bash
kubectl get artifactversion -A | grep -vi succe
kubectl -n cpaas-system get artifactversion <name> -o yaml | grep -n -E 'present|tag|type'
kubectl -n cpaas-system get artifact <artifact-name> -o yaml | grep -n 'type:'
```

`type: chart` with `spec.present: true` and the expected version is the expected state. Pushing again does not add a status. Look for the chart under Catalog > Helm Charts, not under Cluster Plugins or OperatorHub.

### Cause 7: ACP 4.0.3 ships plugins inside the extension package

Unpack the 4.0.3 extension package and push the ASM plugin from it with `violet`:

```bash
tar -tf <acp-4.0.3-extension-package> | grep -i asm
```

The `asm-global` plugin from that package is shown on `global` only (Cause 1).

### Cause 8: Operators shipped with the release show as ready and have no Pods until they are deployed

```bash
kubectl get artifactversion -A | grep -iE 'envoy-gateway-operator|ingress-nginx-operator'
kubectl get packagemanifest -A | grep -iE 'envoy-gateway|ingress-nginx'
```

When both are present, deploy the operator you need from OperatorHub. Pods appear only after the operator is installed.

## Diagnostic Steps

```bash
kubectl get moduleplugins
kubectl get moduleplugin <plugin-name> -o yaml | grep -n -A8 affinity
kubectl get packagemanifest -A -o custom-columns=NAME:.metadata.name,CATALOG:.status.catalogSource
kubectl get artifact,artifactversion -A | grep <package>
```

- An empty plugin page on a non-global cluster for GitOps or `asm-global`: Cause 1.
- A push without `--clusters`, or a question of how to push a cluster plugin to a cluster other than `global`: Cause 2.
- A `clusterAffinity` (`matchLabels`, or a `matchExpressions` list such as `cluster-type`) that the target cluster does not satisfy: Cause 3.
- Catalog source `system`: Cause 4.
- A `type=plugin` ModulePlugin missing from OperatorHub: Cause 5.
- A chart-type package with `spec.present: true` and no status: Cause 6.
- A 4.0.3 plugin with no standalone package: Cause 7.
- Operators listed as `ready` with no Pods: Cause 8.

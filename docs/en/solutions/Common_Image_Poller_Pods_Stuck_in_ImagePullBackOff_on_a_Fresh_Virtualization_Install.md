---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Common-Image Poller Pods Stuck in ImagePullBackOff on a Fresh Virtualization Install
## Issue

On a freshly installed cluster running ACP Virtualization, a set of "poller" pods in the boot-source images namespace stay in `ImagePullBackOff` indefinitely instead of cleaning themselves up after the pull fails:

```text
NAMESPACE              NAME                                          READY   STATUS             AGE
<os-images-ns>         poller-centos-stream10-image-cron-xxxxx       0/1     ImagePullBackOff   8m
<os-images-ns>         poller-centos-stream9-image-cron-xxxxx        0/1     ImagePullBackOff   8m
<os-images-ns>         poller-fedora-image-cron-xxxxx                0/1     ImagePullBackOff   8m
```

(`<os-images-ns>` is the virtualization images namespace, named after the operator that manages boot sources.)

The pods are owned by `CronJob` resources that drive the **common boot-source import** feature: they poll public image registries on a schedule, pull canonical OS images (Fedora, CentOS Stream, and so on), and surface them in the virtualization console as one-click sources for new VMs. When the cluster has no outbound path to those registries — typical on a disconnected install, or behind an egress proxy that has not yet been configured for the virtualization namespace — the pull fails on every retry and the pods accumulate in `ImagePullBackOff`.

## Root Cause

A new install of the virtualization stack enables common boot-source import by default, on the assumption that the cluster has internet egress and that operators want a turnkey VM-creation experience. The flag that drives this is `spec.enableCommonBootImageImport` on the `HyperConverged` custom resource owned by the HyperConverged Cluster Operator. While the flag is `true`, the operator reconciles a set of `CronJob`s — one per maintained OS — that pull the canonical images and stage them as `DataImportCron`/`DataSource` objects.

In a disconnected or restricted-egress cluster, none of those pulls succeed, but the `CronJob`-spawned pods keep being recreated on the next schedule tick, so the failed pods never drain.

## Resolution

### ACP-preferred path: turn off the boot-source poller in the HyperConverged CR

The cleanest fix on a cluster that does not need (or cannot reach) the public boot-source images is to disable the feature outright. Patch the `HyperConverged` CR to set `enableCommonBootImageImport` to `false`:

```bash
kubectl -n <virt-namespace> patch hyperconverged kubevirt-hyperconverged \
  --type=json \
  -p '[{"op":"replace","path":"/spec/enableCommonBootImageImport","value":false}]'
```

Within the next reconcile pass, the HCO removes the poller `CronJob`s and the failed pods. Verify:

```bash
kubectl -n <os-images-ns> get pods
kubectl -n <os-images-ns> get cronjobs
```

Existing `DataSource`/`DataVolume` objects already populated from earlier pulls (or imported manually) are not touched — only the automatic refresh stops.

### Alternative: keep the feature on, but point it at a reachable mirror

If common boot images **are** wanted but the public registry is unreachable, a better option than disabling the feature is to mirror the upstream image repositories into a registry the cluster can reach (an in-cluster registry, an air-gapped artifact store, or a corporate mirror) and point the boot-source registry list at the mirror. This is configured per OS through the `dataImportCronTemplates` block of the same `HyperConverged` CR — overlay an entry that overrides the upstream URL with the mirrored URL. Once the next cron tick runs against the mirror successfully, the pollers complete and the `DataSources` go ready.

### OSS fallback: bare KubeVirt + HCO

On a cluster that runs upstream KubeVirt with the community HyperConverged Cluster Operator (no ACP wrapper), the field name and behavior are identical — the `HyperConverged` CRD is the same upstream object, and the same `enableCommonBootImageImport` toggle exists. The patch command above works unchanged.

If the cluster does not deploy HCO at all (a bare `kubevirt-operator` install), there are no cluster-managed boot-source `CronJob`s in the first place, and any image-pull errors come from explicit `DataVolume`/`DataImportCron` objects the operator created — those need to be diagnosed individually rather than disabled wholesale.

## Diagnostic Steps

- Confirm the failing pods belong to the boot-source poller, not to a user-created `DataVolume`. Poller pods carry the `cdi.kubevirt.io/dataImportCron` ownership chain and are spawned by `CronJob`s with names of the form `poller-<os>-image-cron`:

  ```bash
  kubectl -n <os-images-ns> get cronjobs
  kubectl -n <os-images-ns> get pods \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.ownerReferences[0].kind}{"\n"}{end}'
  ```

- Read the current value of the toggle to confirm the feature is in fact on (the default on a new install is `true` even if it is not present in the CR — absence means default):

  ```bash
  kubectl -n <virt-namespace> get hyperconverged kubevirt-hyperconverged \
    -o jsonpath='{.spec.enableCommonBootImageImport}{"\n"}'
  ```

- Inspect one failing pod to confirm the failure is `ImagePullBackOff` against an external registry, not `ErrImagePull` because of an in-cluster pull-secret problem:

  ```bash
  kubectl -n <os-images-ns> describe pod <poller-pod>
  ```

  The pull URL in the events line shows the upstream registry the cron is trying to reach.

- After applying the disable patch, confirm the operator has reconciled — the `CronJob`s should disappear and `kubectl -n <os-images-ns> get pods` should return empty (or contain only pods unrelated to boot-source polling).

- If the goal is to keep the feature but use a mirror, generate a small VM from a manually imported `DataSource` to confirm end-to-end VM creation still works without the auto-import path.

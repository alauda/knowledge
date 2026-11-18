---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Console returns 404, shows old pages, or misses menus after an upgrade on ACP

## Issue

After a platform upgrade, or on a particular version or package, the console shell does not match what is expected, in every browser:

- requests to the base platform services return HTTP 404 while the API Pods are Running (seen on 4.0.9);
- pages mix old and new views after an upgrade from 4.0 to 4.3.2, and the `frontend` image is back on the 4.0 tag;
- the login page is blank right after images were updated as a vulnerability fix;
- the DevOps entry is missing from Platform Management and Container Management;
- Backup Management has no etcd backup page on 4.1, the etcd monitor panel is empty on 4.2 and later, or License Management is missing;
- on bare metal, the network page cannot create MetalLB, and the Kube-OVN subnet, external address pool and VLAN sections are missing;
- a ConfigMap value entered with line breaks becomes one line in YAML, and the mounted file has Windows-style line breaks;
- new jobs are not visible in the job list after an upgrade on 3.18.

Related article: [Console white page, clipped menu, dead Create button, or empty Pod logs in one browser on ACP](Console_white_page_clipped_menu_dead_Create_button_or_empty_Pod_logs_in_one_browser_on_ACP.md).

## Root Cause

### Cause 1: sentry restored the frontend image to the pre-upgrade tag

After an upgrade from 4.0 to 4.3.2 the `frontend` image was back on the 4.0 tag; the audit log showed that `sentry` had restored it. Until the image matches the platform, pages mix old static files with the new API.

### Cause 2: the frontend image configuration does not match the upgraded platform

After an upgrade to 4.0.9, base platform services returned HTTP 404 because the `frontend` image configuration was wrong. Pods are Running while the image they run is not the one for the upgraded platform.

### Cause 3: images updated as a vulnerability fix break the login page

After images were replaced as a vulnerability fix, the login page is blank and nobody can log in. Reverting those image updates restores login.

### Cause 4: DevOps is missing on the global cluster or has the wrong version there

The DevOps entry is read from the global cluster. DevOps installed only on a business cluster never shows the entry; it appears once DevOps is deployed on global and a Katanomi instance is created there. After global moves from 3.18 to 4.0 while `katanomi` stays on 3.18, the package for the new global version was never pushed, and both Platform Management and Container Management hide DevOps.

### Cause 5: the menu was removed or not shipped in this version or package

- 4.1 removed the etcd backup page from Backup Management. Backups are still visible through the API, and schedules are changed on the `etcdbackupconfiguration` object.
- From 4.2 the 4.0 etcd monitor panel is discontinued, so its charts stay empty even when etcd is healthy.
- The overseas 4.3.2 package omits License Management, including the menu entry and the path `/console-platform/manage-platform/platform-setting/license`; the China distribution has it.

### Cause 6: the ProviderBaremetal adaptation is incomplete before 4.3.3

On bare metal, `Artifact` and `ArtifactVersion` for `metallb-operator` exist and marketplace logs are clean, but `console-plugins` returns no subnet payload and the cluster overview has no network-mode field. The `ProviderBaremetal` adaptation is incomplete in that build and is fixed in 4.3.3.

### Cause 7: the ConfigMap form converts line breaks

The ConfigMap form's character conversion turns a multi-line value into one line, and the mounted file then has Windows-style line breaks. The YAML editor keeps the breaks. The form behaves correctly from 4.1.4.

### Cause 8: the 3.18 job list shows only the first 20 jobs

When more than 20 jobs exist, the 3.18 list page stops at 20. The other jobs exist in the API and search finds them. 4.0 changed the list.

## Resolution

### Cause 1: sentry restored the frontend image to the pre-upgrade tag

```bash
kubectl get deploy -A | grep frontend
kubectl get deploy -n <namespace> <frontend-deployment> \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{" "}{.image}{"\n"}{end}'
```

> **Warning:** Changing the `frontend` image rolls the console shell; users lose the page until the new Pod is Ready. Precondition: the running tag is older than the upgraded platform. Rollback: set the previous image again, which brings back the mismatched UI.

Set the container image to the tag that belongs to the upgraded platform, then watch whether `sentry` reverts it. If it keeps writing the old tag back, the release that `sentry` reconciles still carries the old tag, and a one-off edit will not stick; check the audit log and that release before editing again.

### Cause 2: the frontend image configuration does not match the upgraded platform

```bash
kubectl get deploy -n cpaas-system -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image' | grep frontend
```

> **Warning:** Setting a new `frontend` image rolls the console shell; users lose the page until the new Pod is Ready. Precondition: base services return 404 after an upgrade, and this image does not match that upgrade. Rollback: set the previous image.

```bash
kubectl set image deployment/<frontend-deployment> -n cpaas-system <container>=<image-for-this-platform-version>
kubectl rollout status deployment/<frontend-deployment> -n cpaas-system
```

Requests stop returning 404 once the running image matches. If `sentry` writes the old image back, see Cause 1.

### Cause 3: images updated as a vulnerability fix break the login page

> **Warning:** Reverting the vulnerability-fix images puts the previous tags back and re-opens what those updates closed. Precondition: the blank login page started with that image update. Keep the list of tags you revert. Re-applying the fix tags is the rollback, and it can blank the login page again; obtain a supported image set before re-applying the fix.

Revert each image that was changed as part of the vulnerability fix to its previous tag, using the same method that applied it. Login returns.

### Cause 4: DevOps is missing on the global cluster or has the wrong version there

Install DevOps on the global cluster and create the Katanomi instance there, not only on the business cluster. After a global upgrade, push the DevOps package that belongs to the new global version and upgrade the component so the `katanomi` version matches. The Katanomi instance fields are described in Cause 2 of [DevOps v3 toolchain entry missing after an upgrade: Katanomi MonitorDashboard ownership conflict or missing instance](DevOps_v3_toolchain_entry_missing_after_an_upgrade_Katanomi_MonitorDashboard_ownership_conflict_or_missing_instance.md).

### Cause 5: the menu was removed or not shipped in this version or package

- etcd backups on 4.1: use the API, and edit the object when a schedule must change:

  ```bash
  kubectl get etcdbackupconfiguration -A
  kubectl edit etcdbackupconfiguration -n <namespace> <name>
  ```

- etcd monitor panel on 4.2 and later: use the monitoring dashboard shipped with the running version instead of the 4.0 panel; do not repair the monitoring stack for it.
- License Management: check which distribution is installed. Getting the feature means installing a distribution that contains it; reinstalling the console does not add it.

### Cause 6: the ProviderBaremetal adaptation is incomplete before 4.3.3

Confirm that the `metallb-operator` artifacts are present, so it is not a missing upload, then upgrade to 4.3.3 or later. The subnet, external address pool and VLAN sections and MetalLB creation return on the fixed build.

```bash
kubectl get artifact,artifactversion -A | grep metallb
```

### Cause 7: the ConfigMap form converts line breaks

Open the ConfigMap, switch to **YAML**, enter the value with real line breaks (for example as a `|` block), and apply. Mount the key again and confirm that the file has no Windows-style breaks:

```bash
kubectl exec -n <namespace> <pod> -- cat -A <mounted-file> | head
```

`^M` before `$` at line ends shows Windows-style breaks. From 4.1.4 the form keeps the breaks.

### Cause 8: the 3.18 job list shows only the first 20 jobs

Search for the job by name before treating it as a failed create; search opens jobs beyond the first 20. Upgrading to 4.0 or later removes that list limit.

## Diagnostic Steps

1. Read the images and their tags, and compare them with the platform version:

   ```bash
   kubectl get pods -n cpaas-system | grep -E 'frontend|archon'
   kubectl get deploy -A -o wide | grep -E 'frontend|archon'
   ```

2. Map the result:

   ```text
   frontend tag older than the platform, sentry wrote it back   -> Cause 1
   base services return 404 after an upgrade                    -> Cause 2
   blank login page right after a vulnerability image update    -> Cause 3
   DevOps entry absent, katanomi old or only on a business cluster -> Cause 4
   no etcd backup page on 4.1, no License Management overseas   -> Cause 5
   MetalLB and subnet pages missing on bare metal before 4.3.3  -> Cause 6
   ConfigMap value collapsed to one line after a form edit      -> Cause 7
   new jobs missing from the 3.18 list, search finds them       -> Cause 8
   only one browser affected                                    -> related article
   ```

3. A missing **EXEC** entry or another menu behind a feature gate is [Console menu or feature is missing because a feature gate, plugin, or product entry is off on ACP](Console_menu_or_feature_is_missing_because_a_feature_gate_plugin_or_product_entry_is_off_on_ACP.md).

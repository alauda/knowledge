---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Pushed Helm chart version not shown because violet reused an Artifact of another chart repository on ACP

## Issue

A middleware chart package (for example `nacos.ALL.v2.5.1-260420.tgz`) was pushed with `violet push` and the push finished, but the new version does not appear in the platform: Catalog > Helm Charts, the `public-charts` repository, and the version list show nothing new or only an old version. Pushing the same package again does not help; the `violet` output reports that everything already exists:

```text
... already exists, skip push
artifact <chart> already exist, will create artifactversion cluster=global type=chart
artifactversion <chart>.<tag> already exist, skip it. cluster=global type=chart
```

The platform has more than one chart repository (for example the built-in chart repository and a Harbor chart repository), and the other repository already holds an older template of the same chart (for example `nacos` 2.2.3 in the Harbor chart repository, while the new package is `nacos` `v2.5.1-260420` for `public-charts`).

The `artifact` / `artifactversion` objects exist, so this is not a push that never created them.

## Root Cause

### Cause 1: violet reused an Artifact owned by another chart repository

The push succeeds: the images and the chart are stored, and an `ArtifactVersion` for the new tag is created in `cpaas-system` on the `global` cluster. The problem is the `Artifact` it is attached to.

`Artifact` objects (`artifacts.app.alauda.io`) are named after the chart, and only one object with that name can exist in `cpaas-system`. When the chart name is already taken by an Artifact that belongs to a different chart repository, `violet` does not create a new Artifact. It logs `artifact <chart> already exist, will create artifactversion` and attaches the new `ArtifactVersion` to the existing Artifact through an ownerReference. For example:

| Object | Labels and fields |
| --- | --- |
| Artifact `nacos` (existing) | `cpaas.io/chart-purpose: library-charts`, `cpaas.io/library: stable`, `cpaas.io/managed-by: violet`; `spec.artifactVersionSelector.matchLabels` `cpaas.io/artifact-version: nacos`; `imagePullSecrets` `ctr-library-charts`; `repository: middleware/chart-nacos` |
| ArtifactVersion `nacos.v2.5.1-260420` (new) | `cpaas.io/chart-purpose: public-charts`, `tag: v2.5.1-260420`, ownerReference to Artifact `nacos` |

The repository label of the parent Artifact (`library-charts`) does not match the repository of the new version (`public-charts`), so the chart list for `public-charts` is not refreshed and the new version is not displayed.

Because the `ArtifactVersion` already exists after the first push, every later push of the same package only logs `artifactversion <chart>.<tag> already exist, skip it`. Restarting platform components, re-syncing the chart repository, or pushing again does not change the parent Artifact.

## Resolution

### Cause 1: violet reused an Artifact owned by another chart repository

Apply this only when all of the following are confirmed:

- the `violet` output contains `artifact <chart> already exist, will create artifactversion`;
- `kubectl -n cpaas-system get artifact <chart>` returns one Artifact whose `cpaas.io/chart-purpose` label names a different repository than the label on the new `ArtifactVersion`;
- the old chart in that other repository has the same name and is the version you intend to retire.

1. Decide whether the old chart is still needed (for example, an old template that is incompatible with the current platform version and not used). Check whether any application still deploys from it:

   ```bash
   kubectl get helmrequest -A | grep <chart>
   kubectl get artifactversion -n cpaas-system --show-labels | grep <chart>
   ```

2. Keep a copy of the objects before you change anything:

   ```bash
   kubectl -n cpaas-system get artifact <chart> -o yaml > artifact-<chart>-backup.yaml
   kubectl -n cpaas-system get artifactversion <old-artifactversion> <chart>.<tag> -o yaml > artifactversion-<chart>-backup.yaml
   ```

> **Warning:** Deleting the old template from the other chart repository removes that chart version from Catalog. The old version can no longer be selected for new deployments or upgrades, and applications deployed from it can no longer be upgraded or redeployed from that template. When the old `Artifact` is removed, Kubernetes garbage collection also removes the `ArtifactVersion` objects that list it as owner, including the version you just pushed; that is why the package is pushed again in step 4. Precondition: the `artifact <chart> already exist` signature and the repository-label mismatch are confirmed, the owner of the old chart agrees that it is retired, and the backups from step 2 and the old chart package (for example `helm pull oci://<harbor>/<project>/<chart> --version <old-version>`, or a download from Harbor) are saved. Rollback: upload the saved old package to its chart repository again; that brings the old template back, and with it the same name conflict.

3. Delete the old `<chart>` template from the other chart repository (in the Harbor project that holds it). Then check whether the conflicting Artifact is gone:

   ```bash
   kubectl -n cpaas-system get artifact <chart> --show-labels
   ```

   If it is still present with the other repository's label, collect `kubectl -n cpaas-system get artifact <chart> -o yaml` and contact Alauda support before pushing again.

4. Push the new package again with the same command as before:

   ```bash
   violet push <chart>.ALL.<tag>.tgz \
     --platform-address "https://<acp-domain>" \
     --platform-username "<platform_admin_user>" \
     --platform-password "<platform_password>"
   ```

   This time `violet` creates the Artifact for the new chart. Images that are already present are still reported as `already exists, skip push`; that is expected.

5. Verify the result. The `public-charts` repository lists `<chart>` under the published packages (Helm Chart), and Catalog > Helm Charts shows the application template with version `<tag>`:

   ```bash
   kubectl -n cpaas-system get artifact <chart> --show-labels
   kubectl -n cpaas-system get artifactversion <chart>.<tag> --show-labels
   kubectl get artifactversion -A | grep <chart>
   ```

   Both objects now carry `cpaas.io/chart-purpose: public-charts`.

## Diagnostic Steps

1. Read the `violet push` output. `already exists, skip push` on the images only means the images were pushed before. The line that identifies this cause is `artifact <chart> already exist, will create artifactversion cluster=global type=chart`, followed on a re-push by `artifactversion <chart>.<tag> already exist, skip it`.

2. List the chart repositories and look for a second repository that already holds the same chart name:

   ```bash
   kubectl get chartrepos.app.alauda.io -A
   kubectl get chartrepo -n cpaas-system -o custom-columns=NAME:.metadata.name,TYPE:.spec.type,URL:.spec.url,PHASE:.status.phase
   ```

3. Find the Artifact and the ArtifactVersions for the chart on the `global` cluster. One Artifact that is much older than the push, plus both the old and the new version, matches this cause:

   ```bash
   kubectl get artifact -A | grep <chart>
   kubectl get artifactversion -A | grep <chart>
   ```

4. Compare the repository labels of the parent Artifact and the new ArtifactVersion, and confirm the ownerReference:

   ```bash
   kubectl -n cpaas-system get artifact <chart> -o yaml | grep -n -E 'chart-purpose|repository|imagePullSecrets|artifact-version'
   kubectl -n cpaas-system get artifactversion <chart>.<tag> \
     -o jsonpath='purpose={.metadata.labels.cpaas\.io/chart-purpose} owner={.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name} tag={.spec.tag}{"\n"}'
   ```

| Observation | Conclusion |
| --- | --- |
| Artifact `cpaas.io/chart-purpose` differs from the new ArtifactVersion's (for example `library-charts` vs `public-charts`), owner is that Artifact | This cause |
| Artifact and new ArtifactVersion carry the same repository label, upload succeeded, version still missing | The repository index did not refresh; check the chart repository sync state |
| ArtifactVersion of `type: chart` with empty PHASE, Artifact labels match the repository | Normal state of a chart package; chart artifacts are not reconciled and carry no phase |
| No `artifact` / `artifactversion` for the chart at all after a successful push | The push did not register the chart; this cause does not apply |

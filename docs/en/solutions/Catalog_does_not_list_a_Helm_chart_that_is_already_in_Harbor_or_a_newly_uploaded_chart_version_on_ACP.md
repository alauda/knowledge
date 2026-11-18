---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.2"
---

# Catalog does not list a Helm chart that is already in Harbor, or a newly uploaded chart version, on ACP

## Issue

A Helm chart is in Harbor, or an upload reported success, but Catalog, the version dropdown, or template selection does not show it:

- `helm push` printed `Pushed: <harbor>/<project>/<chart>:<version>`, Harbor shows the chart, but the template repository and Catalog stay on the old list or show nothing.
- A newly added chart repository lists none of the charts already stored in it. The repository detail page says `无应用模板` ("no application templates") or `暂时没有找到符合过滤条件的应用模板` ("no application templates match the filter").
- A new chart package was uploaded (for example with `violet push`), but the template version dropdown still offers only the previous version, and the repository (for example `public-charts`) shows last sync time `-`.
- Upload reported `上传成功` (upload successful) and Harbor has the tag, but with a namespace of an ARM cluster selected, Catalog shows `共 0 个应用` (0 applications), `Helm Charts (0个)`, and `无应用列表` (no application list), while x86 clusters list the chart. Or the chart details open but the deploy form has no version to select. Or, after a version was deleted and the same version uploaded again, the whole chart disappears from Catalog, and creating it again reports that the version already exists.

Restarting OLM Pods and refreshing the browser does not make the chart appear. `helm show chart` against the Harbor URL proves only that the registry has the package, not that Catalog has indexed it.

Related articles: [Helm chart template upload fails, or the template directory cannot be selected, in Catalog on ACP](Helm_chart_template_upload_fails_or_the_template_directory_cannot_be_selected_in_Catalog_on_ACP.md).

## Root Cause

The Catalog UI lists a chart only when the platform has registered it: a matching `Artifact` and `ArtifactVersion` exist in the `cpaas-system` namespace of the `global` cluster. A chart that only exists in the registry is not listed.

### Cause 1: ACP 4.2 does not synchronize OCI charts automatically

ACP 4.2 does not support automatic chart synchronization. An OCI chart is not imported from Harbor because the registry has the tag; the template repository shows it after the chart is uploaded through the platform UI (or the Catalog API).

### Cause 2: helm push to Harbor bypasses the platform

A version pushed with `helm push` (or any client that talks only to the registry) goes straight to Harbor, so Catalog does not learn about the tag. ChartRepo synchronization runs when a template is uploaded through Catalog, and the Catalog page has no manual synchronization button. Pushing the same tag again with `helm push` does not help.

### Cause 3: an added OCI chart repository does not import the charts already in it

After an OCI chart repository is added, the `ChartRepo` reaches phase `Synced`, and `captain-chartmuseum` logs only `Rebuilding index for tenant`, `Fetching chart list from storage`, and `No change detected between cache and storage`, but no `Artifact`/`ArtifactVersion` pair exists for the charts. The platform has no function that copies charts already stored in a newly added OCI repository into Catalog; a synced phase does not create those objects. The result is the same whether the repository address is the Harbor host only or the host plus the project path.

### Cause 4: the chart repository did not resynchronize after an accepted upload

The upload succeeded, the architecture of the package matches the cluster, but the repository index did not refresh: last sync time is `-`, and the template list and the version selector of the create form still offer only the previous version. Setting the repository status to `Pending` triggers a resynchronization, after which the new version is available.

### Cause 5: the chart's hardware architecture does not include the cluster's architecture

Application templates support two hardware architectures, x86 and ARM, and default to x86. A cluster does not display chart packages whose architecture does not match its own: an x86-only template is listed on x86 clusters (and on C86 clusters), not on ARM clusters. Charts uploaded to the platform chart repository are marked x86 only by default. The chart details page under Platform Management shows the value as Hardware Architecture `x86`.

The value is the `cpaas.io/arch` label of the platform `Chart` resource (`app.alauda.io/v1beta1`, in `cpaas-system` on the `global` cluster), taken from the package's `Chart.yaml`: `cpaas.io/arch: amd64` is stored as x86, `cpaas.io/arch: amd64.arm64` as x86 and ARM. Node architectures are reported as `amd64` / `arm64`; the template values are `x86` / `arm`. The mismatch shows up three ways:

- The chart is not listed for a namespace of an ARM cluster.
- The chart details load on a cluster of another architecture, but the version picker is empty. On an ARM cluster, changing the version's label from `x86` to `arm` makes the versions selectable.
- A new upload of a package whose `cpaas.io/arch` is `amd64` only writes the label back to x86, even if the chart had been set to x86 and ARM. The chart then looks deleted from ARM clusters, although `kubectl get chart -A` still lists it (named `<chartrepo>-<directory>-<chart>.<chartrepo>`) with the re-uploaded version. Deleting the version is not what removed it; the label written by the new package is.

Restarting `captain` components does not make the chart appear.

## Resolution

### Cause 1 and Cause 2

Upload the chart through the platform:

1. Open Catalog → Helm Charts, choose Add Template, and select a template repository of type Chart or OCI Chart that you can manage.
2. Upload the `.tgz`. For an OCI Chart repository, also set the template directory (the chart storage directory).
3. When the row leaves `Uploading` and shows upload successful, the chart is listed, and the upload also triggers ChartRepo synchronization so versions already stored in Harbor appear.

The same upload through the Catalog API, with an API token from the user profile (Add API Token):

```bash
curl -k --request POST \
  --url "https://<acp-domain>/catalog/v1/chartrepos/cpaas-system/<chartrepo>/charts" \
  --header "Authorization: Bearer <api-token>" \
  --data-binary @"<chart>-<version>.tgz"
```

`<chartrepo>` is the ChartRepo name in `cpaas-system`, not the Harbor project name. Use a repository whose `status.phase` is already synced; fix a failed repository first.

### Cause 3

Adding the repository does not import existing charts. Upload each chart that should appear through Catalog → Helm Charts or the Catalog API, as in Cause 1, so the platform registers it. Confirm the state before and after:

```bash
kubectl get chartrepos.app.alauda.io -A
kubectl get chartrepo -n cpaas-system <chartrepo> -o jsonpath='type={.spec.type} phase={.status.phase} reason={.status.reason}{"\n"}'
kubectl get artifact,artifactversion -n cpaas-system
```

### Cause 4

1. Rule out a reused Artifact first: if the `violet push` output says `artifact <chart> already exist, will create artifactversion`, compare the `cpaas.io/chart-purpose` label of the existing `Artifact` with that of the new `ArtifactVersion`. A mismatch means an `Artifact` of the same name from another chart repository hides the version; setting `Pending` does not fix that.

2. If the upload itself keeps failing, set `--platform-address` to the platform access address only, without a port or a path such as `/public-charts`:

   ```bash
   violet push <package>.tgz --platform-address "https://<acp-domain>" --platform-username "<platform_user>" --platform-password "<platform_password>"
   ```

3. Once the upload has succeeded and the version is still missing, set the ChartRepo status to `Pending`.

   > **Warning:** Only when the upload succeeded, the new version is missing from the dropdown and template selection, and the architecture matches. Impact: synchronization of that ChartRepo is re-queued, Catalog can show it as syncing until the phase settles, and a wrong name resyncs the wrong repository. Precondition: the current object is saved and its phase printed by the first two commands. Rollback: patch `status.phase` back to the printed value. The patch does not delete charts or Harbor blobs.

   ```bash
   kubectl get chartrepo -n cpaas-system <chartrepo> -o yaml > chartrepo-status.yaml
   kubectl get chartrepo -n cpaas-system <chartrepo> -o jsonpath='{.status.phase}{"\n"}'
   kubectl patch chartrepo -n cpaas-system <chartrepo> --subresource=status --type=merge -p '{"status":{"phase":"Pending"}}'
   kubectl get chartrepo -n cpaas-system <chartrepo> -o jsonpath='{.status.phase}{"\n"}{.status.reason}{"\n"}'
   ```

   If the status patch is rejected, run `kubectl edit chartrepo -n cpaas-system <chartrepo> --subresource=status` and set the phase to `Pending`.

4. After the repository leaves `Pending`, the uploaded version is available in the application templates.

### Cause 5

1. On the `global` cluster, confirm the chart resource exists and read its architecture; on the affected cluster, read the node architecture:

   ```bash
   kubectl get chart -A | grep <chart>
   kubectl get chart -n cpaas-system <chart-object> -o jsonpath='{.metadata.labels.cpaas\.io/arch}{"\n"}'
   kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture
   ```

   A label without `arm64` on a chart that an ARM cluster cannot see confirms this cause.

2. Change the hardware architecture in the UI: Platform Management > App Marketplace Management > Chart Repositories > `<chartrepo>` > the chart, and edit Hardware Architecture to include ARM (x86 and ARM). On releases that name the menu App Store Management > Template Repository, the same control is on the application template details page. Keep x86 when x86 or C86 clusters must still see the chart. For an empty version picker on an ARM-only cluster, set the version's architecture to `arm`.

   > **Warning:** Changing the hardware architecture changes which clusters list this chart; a cluster whose architecture you remove stops showing it. Precondition: note the current value on the details page. Rollback: set that value again. No chart object or Harbor blob is deleted.

3. Reopen Catalog with a namespace of the affected cluster; the chart and its versions are listed.

4. Make it persistent: the next upload of a package with `cpaas.io/arch: amd64` overwrites the UI change. Set the annotation in `Chart.yaml`, repackage, and upload:

   ```yaml
   annotations:
     cpaas.io/arch: amd64.arm64
   ```

## Diagnostic Steps

```bash
kubectl get chartrepo -n cpaas-system -o custom-columns=NAME:.metadata.name,TYPE:.spec.type,URL:.spec.url,PHASE:.status.phase,REASON:.status.reason
kubectl get artifact,artifactversion -n cpaas-system
helm show chart <chart> --version <version>
```

| Check | Conclusion |
| --- | --- |
| ACP 4.2, OCI chart present in Harbor, never uploaded in the UI | Cause 1 |
| The version reached Harbor only through `helm push`; the Catalog list is unchanged | Cause 2 |
| OCI repository phase `Synced`, `captain-chartmuseum` only logs `No change detected between cache and storage`, page says `无应用模板`, no `Artifact` pair in `cpaas-system` on `global` | Cause 3 |
| Upload succeeded, version missing from the dropdown, last sync time `-`, architecture matches | Cause 4 |
| `violet push` says `artifact <chart> already exist`, and the `cpaas.io/chart-purpose` labels differ | Reused Artifact (Cause 4, step 1) |
| The chart is hidden only in an ARM cluster namespace (`共 0 个应用`, "0 applications in total") | The chart's architecture label, not synchronization (Cause 5) |
| Chart details load, the version picker is empty, and the node architecture and the `x86` / `arm` label disagree | Cause 5 |
| The chart vanished from Catalog after a re-upload, `kubectl get chart -A` still lists it, its `cpaas.io/arch` label has no `arm64` | Cause 5 |

On ACP 4.2, Cause 1 and Cause 2 can both apply: there is no background synchronization, and a Catalog upload is also the event that registers the chart. A synced phase together with a missing `Artifact` pair is Cause 3, not Cause 4. Restarting OLM Pods does not fix any of these causes.

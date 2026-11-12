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

# Preparing the extension package list for an ACP upgrade fails or is incomplete: violet list and apps.yaml

## Issue

While collecting the extension packages for a platform upgrade:

- The extension list exported with `violet` is pasted into the Alauda Customer Portal download page and the upload returns an error. After the YAML is fixed, Marketplace > Batch Download > Upgrade > Post-ACP v4.0 Upgrades (for example target `v4.3.0`, architecture `amd64`) shows `No Application` in the Packages list.
- After `apps.yaml` is imported, many packages are listed with several versions each.
- `apps.yaml` entries do not match on the Alauda Customer Portal (`logapi`, `logagent` reported missing), a scenario category misses `log-center`, and some entries show "no package for this version" (`暂无此版本包`).
- Before an upgrade (for example from 4.2.4 to 4.3) some extension packages are not yet released, and self-uploaded plugins have no matching version.
- `violet list` fails on 3.16.2, or after the upgrade from 3.16.x to 4.0.12 the package lookup still goes through `app.yaml`.
- While upgrading DevOps to v3.20 following the DevOps v3 upgrade documentation, the `Alauda DevOps Nexus v3` and `Alauda DevOps Harbor v3` packages cannot be found.
- On a new 4.0.7 `global` deployed with the 4.0.7 core package, the 4.0.7 extension package was pushed with `violet push`, and the VM monitoring, log collection, and ES storage plugins still show as not listed (`未上架`).
- Packages that are published (`已上架`) but not installed should be taken down (`下架`) so that production matches a test environment.
- `violet list --platform-address ... --platform-token ... --output-file ./apps.yaml` returns `null` for every plugin before an upgrade to 4.3.3, although Cluster Plugins on `global` shows installed plugins.

## Root Cause

### Cause 1: The extension YAML lacks the AppScenarioManifest header, or lists plugins that are not installed

The exported YAML starts directly with the `applications:` key and lacks a top-level `AppScenarioManifest:` line above it, which causes the upload error. Separately, plain `violet list` lists every package uploaded to the platform, not only the installed ones, which produces the `No Application` ("no updates needed") result. `violet list --installed` lists only installed plugins. Adding the `AppScenarioManifest:` line and regenerating the list with `violet list --installed` fixes both. If some target-version plugins are still being released, wait for their packages before upgrading.

### Cause 2: The upgrade prompt lists every compatible version of each package

By default the upgrade prompt lists every extension package version that is compatible with the target version. Downloading all listed versions is the expected default.

### Cause 3: An artifact ID changed or a scenario category missed a package

When new artifact versions were published, some artifact IDs changed: the names gained a `-` (`log-api`, `log-agent`), so the Alauda Customer Portal treats the new version as a different application and the old `apps.yaml` entry no longer matches. Both exist under scenario category `common ACP Extension`. The 4.0 names `logagent` and `logcenter` became `log-agent` and `log-center` in 4.3. `log-center` was missing from that category and has since been added.

For an entry with "no package for this version", the portal cannot tell whether the component was removed in the target version or merged into the core package; confirm each entry by hand. For `logagent` and `logcenter` it is the rename above. For `harbor-operator` and `nexus-operator` on 4.3 it means DevOps v3 is not supported there; migrate to DevOps v4.

### Cause 4: Some packages for the target version are not released yet, or have no platform version

The upgrade is held because some required extension packages are not yet released, and self-uploaded plugins show no match. Comparing every package in the environment's `apps.yaml` with the available target-version packages gives two lists: packages to download for the upgrade, and self-uploaded plugins with no matching platform version. An installed platform-provided plugin with no released target package holds the upgrade until the package is released. Self-uploaded plugins with no platform version do not affect the upgrade. For 4.3: OAM has no 4.3 packages, so nothing is downloaded for it; Ingress-nginx is no longer available as a plugin, and `ingress-nginx-operator`, included in the core package, replaces it.

The same gap applies to the DevOps v3.20 upgrade: the `Alauda DevOps Nexus v3` and `Alauda DevOps Harbor v3` packages were published only after a request to Alauda.

### Cause 5: After 3.16 to 4.0.12 the package list must not be taken from app.yaml

For the upgrade from ACP 3.16.x to 4.0.12, the package list is not retrieved through `app.yaml`. The packages for that upgrade come from the dedicated `ACP Upgrade from v3.x to v4.x` batch-download scenario. `violet list` reads the application list already present in the environment and is the inventory to compare against that download set; plain `violet list` also includes packages that are uploaded but not installed. Later upgrades that start on 4.0 or later do import `apps.yaml` on the Post-ACP v4.0 Upgrades page (Cause 1). No cause is known for the `violet list` failure on 3.16.2; `violet list` works on a 3.16 `global` control-plane node with the violet client that matches the target version.

### Cause 6: The published 4.0.7 extension package was missing plugins

The 4.0.7 extension package published at one time did not contain several plugins. The package was rebuilt and published again; download the corrected package.

### Cause 7: Published but not installed packages do not have to be taken down

Packages that are published but not installed do not affect the upgrade process, and there is no takedown procedure for them. Leave them in place.

### Cause 8: violet list returns null for every plugin before the upgrade to 4.3.3

With the `violet` version used before the upgrade to 4.3.3, `violet list` outputs only the application catalog and does not show installation status, so the installed state comes back as `null`. This is expected and does not mean the plugins are uninstalled.

## Resolution

### Cause 1: The extension YAML lacks the AppScenarioManifest header, or lists plugins that are not installed

Regenerate the list from installed plugins only:

```bash
violet list --installed --platform-address <platform-access-address> --platform-username <platform-admin-name> --platform-password '<platform-admin-password>' --output-file apps.yaml
head -n 5 apps.yaml
```

If the file does not begin with `AppScenarioManifest:`, add that line above `applications:` (entries carry the installed cluster and version and a `type` of `ModulePlugin`, `OperatorBundle`, or `Chart`):

```bash
sed -i '1i AppScenarioManifest:' apps.yaml
head -n 3 apps.yaml
```

Import the file again on the upgrade download page and confirm that the Packages list shows updates for the plugins that are actually installed.

### Cause 2: The upgrade prompt lists every compatible version of each package

Download the versions the upgrade prompt lists; they are all compatible with the target version.

### Cause 3: An artifact ID changed or a scenario category missed a package

For each entry the portal reports as missing:

1. Search for the name with a `-` added (`log-api`, `log-agent`) and in scenario category `common ACP Extension`.
2. Check that `log-center` is in your download set.
3. For each "no package for this version" entry, confirm in the target version's release notes or with Alauda support whether the component was removed or merged into the core package. Drop it from the list only after that confirmation.

Compare the final download set with the installed list:

```bash
violet list --installed --platform-address <platform-access-address> --platform-token '<platform-token>'
```

### Cause 4: Some packages for the target version are not released yet, or have no platform version

When some target packages are not released or plugins show no match, send the environment's `apps.yaml`, the architecture, and the current platform version to Alauda support for a comparison, and download the packages on the resulting "must download" list. When the portal import shows every required package as available, no review is needed. Leave self-uploaded plugins with no platform version out of the upgrade. For OAM on 4.3 there is nothing to download; for Ingress-nginx, plan to install `ingress-nginx-operator` from the core package. If a package that a product upgrade document requires cannot be found on the download site, report the package names to Alauda support.

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture
```

### Cause 5: After 3.16 to 4.0.12 the package list must not be taken from app.yaml

Download the packages for the 3.16.x to 4.0.12 upgrade from the batch-download scenario `ACP Upgrade from v3.x to v4.x` (App Marketplace > Batch Download > Upgrade). On the environment being upgraded, list what is installed, on the first control-plane node of the `global` cluster and with the violet client that matches the target version:

```bash
violet list
```

Use that list as the bill of extension packages to download, leaving out rows for packages that are uploaded but not installed. If `violet list` still fails with the target-version client, contact Alauda support.

### Cause 6: The published 4.0.7 extension package was missing plugins

List what the downloaded package contains and compare it with the plugins that show as not listed:

```bash
tar -tf <acp-4.0.7-extension-package> | grep -i -E 'monitor|log|elasticsearch|es'
kubectl get moduleplugins | grep -i -E 'monitor|log|elasticsearch'
```

If the plugins are not in the archive, download the extension package again from the official site, push it, and check Cluster Plugins:

```bash
violet push <acp-4.0.7-extension-package-dir> --platform-address <platform-access-address> --platform-username <platform-admin-name> --platform-password '<platform-admin-password>'
```

If the republished package still lacks them, report the missing plugin names to Alauda support.

### Cause 7: Published but not installed packages do not have to be taken down

Confirm that the packages in question are really not installed:

```bash
violet list --platform-address <platform-access-address> --platform-username <platform-admin-name> --platform-password '<platform-admin-password>'
violet list --installed --platform-address <platform-access-address> --platform-username <platform-admin-name> --platform-password '<platform-admin-password>'
```

A package that appears only in the first list is published but not installed; leave it in place. An installed package is not covered by this conclusion.

### Cause 8: violet list returns null for every plugin before the upgrade to 4.3.3

First rule out a command that did not reach the platform. Use the real address and token, not the template placeholders:

```bash
violet version
violet list --platform-address "https://<platform-access-address>" --platform-token "<platform-token>" --output-file ./apps.yaml
ls -l ./apps.yaml
cat ./apps.yaml
```

If the file is written and the plugins still show `null`:

1. Record the installed plugins and their versions from Cluster Plugins on the `global` cluster. That list is the inventory for the upgrade.
2. After the platform is upgraded to 4.3.3, run the inventory again with the `violet` client that matches 4.3.3.

## Diagnostic Steps

```bash
violet version
violet list --installed --platform-address <platform-access-address> --platform-token '<platform-token>'
head -n 3 apps.yaml
```

- A portal upload error on a YAML whose first line is `applications:` rather than `AppScenarioManifest:`, or `No Application` from a list that includes uninstalled plugins: Cause 1.
- Many versions per package after importing `apps.yaml`: Cause 2.
- `logapi` / `logagent` missing, `log-center` missing from a scenario, or "no package for this version": Cause 3.
- Target packages not yet released, self-uploaded plugins with no match, or packages required by a product upgrade document missing from the download site: Cause 4.
- A 3.16 to 4.0.12 lookup that still depends on `app.yaml`: Cause 5.
- Plugins still not listed after the whole extension package was pushed, because the archive does not contain them: Cause 6.
- A request to take down published but not installed packages: Cause 7.
- `null` for every plugin from `violet list` before the upgrade to 4.3.3, while Cluster Plugins shows plugins installed: Cause 8.

When `violet list` returns nothing useful, also check what the command covers and who runs it. `violet list` lists extensions with the Aligned or Agnostic life cycle (cluster plugins of those types, installed operators, and Helm chart applications); Core plugins follow the cluster upgrade and are never listed. The platform account must have role property `System` and role name `platform-admin-system`; a `Custom` role cannot use the tool. Token-based inventory needs a recent `violet` client; older clients can fail with `failed to get user info from platform server`.

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

# violet push fails to parse a package, or a new operator version is skipped or missing on ACP

## Issue

- A push fails immediately with `failed to parse package and manifest for package <file>.tgz: unexpected EOF`.
- GPU Operator and SR-IOV Network uploads fail while every other required plugin from the same set (for example ACP 4.3.2) uploads.
- A new operator version was pushed (for example Tekton 4.14, or `tektoncd-operator` 4.15.1), but the page and `PackageManifests` still show only the old version, and `violet` printed `WARN artifactversion operatorhub-<package>.v<version> already exist, skip it`.
- An operator package synchronized from `global` is visible as a software package but not in OperatorHub on a business cluster.

Related articles: "violet push succeeds but the plugin is not published: Artifact, ModuleConfig, or chart missing on ACP" covers successful pushes whose objects never appear. A pushed Helm chart that reports `artifact <chart> already exist, will create artifactversion ... type=chart` is covered in "Pushed Helm chart version not shown because violet reused an Artifact of another chart repository on ACP".

## Root Cause

### Cause 1: failed to parse package and manifest, unexpected EOF

`violet` cannot read the archive (for example `workbench-operator.stable.amd64.v0.2.1.tgz`): the archive was corrupted during upload. Matching MD5 sums across several downloads do not rule this out. Uploading the package again clears the error.

### Cause 2: GPU Operator or SR-IOV package is missing required fields

On ACP 4.3.2, the GPU Operator and SR-IOV Network marketplace packages were missing required fields that belong in `moduleplugin.yaml`; fetching the marketplace package again leaves the same gap. `gpu-operator` was re-released, and version `v26.3.2-default.1.gcdaaba55` is the build to select. The `sriov-network-plugin` package was still in testing and not released for production use; it is not the production plugin, and its official release has to be awaited.

### Cause 3: New version pushed, ArtifactVersion is Failed or skipped as already existing

`violet` prints `WARN artifactversion operatorhub-<package>.v<version> already exist, skip it`, and the new version is missing from the page and from `kubectl get packagemanifest`. The ArtifactVersion shows `phase=Failed`, `reason=Error`, with a bundle pull error such as `failed to do request: Head "http://<registry>/v2/<repo>/<package>-bundle/manifests/<tag>": dial tcp <registry>:80: connect: no route to host` or `... not found`.

An earlier push left the ArtifactVersion in the cluster, but the OLM registry could not pull the bundle image it points to; the `olm-registry-platform` log repeats `failed to add bundle` for it. A plain re-push sees the existing ArtifactVersion and skips it, and restarting `olm`, `packageserver`, and `catalog-operator` does not help. Pushing again with `violet push --force` overwrites the existing objects, and the new version appears. A version that does not show up after release, with no error text, is recovered the same way. An operator package synchronized from `global` that is missing from OperatorHub on a business cluster is restored by uploading the package again; no underlying cause is known for that form.

## Resolution

### Cause 1: failed to parse package and manifest, unexpected EOF

Test the file on disk before another push; `tar` reporting an unexpected end of archive means the file is not a complete package:

```bash
tar -tzf <package>.tgz >/dev/null
```

Obtain the package again from the distribution source and push that copy:

```bash
violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password='<platform-admin-password>' <package>.tgz
```

`violet` should report a successful push and no `unexpected EOF`.

### Cause 2: GPU Operator or SR-IOV package is missing required fields

Select the re-released GPU Operator build `v26.3.2-default.1.gcdaaba55`. For SR-IOV Network, wait for the officially released plugin; the testing package is not for production use.

```bash
kubectl get moduleplugins | grep -iE 'gpu|sriov'
```

### Cause 3: New version pushed, ArtifactVersion is Failed or skipped as already existing

On the cluster that should offer the version, read the ArtifactVersion phase and message:

```bash
kubectl get packagemanifest,artifact,artifactversion -A | grep <package>
kubectl -n cpaas-system get artifactversion operatorhub-<package>.v<version> -o yaml
kubectl -n cpaas-system logs deploy/olm-registry-platform --tail=300 | grep -i 'failed to add bundle'
```

> **Warning:** `--force` overwrites the package, Artifact, and ArtifactVersion already on the platform for this package version and architecture; any earlier content stored under the same name is replaced. Precondition: only when the version is missing from `PackageManifests`, and either `violet` printed `already exist, skip it` for that ArtifactVersion or the ArtifactVersion is `Failed` with a bundle pull error. Rollback: there is no undo of the overwrite; push the previous tarball again with `--force` if you need the old content back.

```bash
violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password='<platform-admin-password>' --clusters <cluster-name> --force <package>.tgz
```

Check that the version is listed:

```bash
kubectl get packagemanifest -A | grep <package>
kubectl -n cpaas-system get artifactversion | grep <package>
```

If the ArtifactVersion still fails with `no route to host`, the cluster cannot reach the registry host in that message. Fix that network path or push to a registry the cluster can reach; another `--force` does not change the address.

For an operator package that is visible as a software package but missing from OperatorHub on a business cluster, upload the package again for that cluster.

## Diagnostic Steps

```bash
violet version
tar -tzf <package>.tgz >/dev/null
kubectl get moduleplugins | grep <plugin-name>
kubectl -n cpaas-system get artifactversion | grep <package>
```

- `unexpected EOF` from `violet` or from `tar`: Cause 1.
- A GPU or SR-IOV upload error that names missing fields, while other plugins succeed: Cause 2.
- An ArtifactVersion in `Failed` with a bundle pull error, or `artifactversion operatorhub-... already exist, skip it`: Cause 3.
- The same `already exist` message with `type=chart`: see the related Helm chart article.
- No `artifact` / `artifactversion` at all after a successful push: see the related article on plugins that are not published.

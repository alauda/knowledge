---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion: []
---

# Jenkins Maven build packages an old dependency jar after the same version is republished to the private repository

## Issue

A custom library is published to the private Maven repository again without raising its version number (a release version, not `-SNAPSHOT`). The Jenkins pipeline runs green and builds a new service image, but the library jar in the application's `lib` directory inside the image is still the earlier upload. The build did not fetch the republished jar from the repository, and the question is whether Jenkins caches the jar and how to replace the cached copy.

Jenkins Java build nodes can keep the Maven local repository on persistent storage. The platform default `java` build node mounts the Maven cache PVC `maven-cache` at `/root/.m2/repository`, so artifacts downloaded by one build stay available to later builds.

## Root Cause

### Cause 1: the old copy of the republished release version is still in the persistent Maven cache

The earlier jar is still in the Maven cache that the build node mounts. Because the republished jar kept the same version, the build reuses the cached copy and does not download the new one. Removing the old version directory from the cache makes later builds package the new upload.

This matches standard Maven resolution. Maven looks for a release version in the local repository first, and once that version is present it is resolved locally. The `mvn --help` text for `-U, --update-snapshots` reads "Forces a check for missing releases and updated snapshots on remote repositories", so `-U` refreshes SNAPSHOT versions and fetches releases that are absent locally; a release that is already in the cache is used as it is. With a cache that persists across builds, the first copy of a release version stays in use until it is removed from the cache.

Signature: the Maven stage log has no `Downloading from` / `Downloaded from` line for the republished artifact, and the jar in the cache directory is older than, and has a different checksum from, the one the repository serves now.

## Resolution

### Cause 1: the old copy of the republished release version is still in the persistent Maven cache

Apply this only when Diagnostic Steps confirm all three: the repository now serves the new jar, the cached jar differs from it, and the build log shows no download of that artifact.

1. Find the directory that holds the Maven cache. On the default `java` build node it is the volume behind PVC `maven-cache`, seen in the agent Pod at `/root/.m2/repository`. Locate its backing path:

   ```bash
   kubectl get pvc -A | grep maven-cache
   kubectl get pvc -n <namespace> maven-cache -o jsonpath='{.spec.volumeName}{"\n"}'
   kubectl get pv <pv-name> -o yaml
   ```

   In the PV, read `spec.hostPath.path`, `spec.local.path` together with `spec.nodeAffinity`, `spec.nfs`, or the CSI driver attributes to find the node or server and the directory. That directory is the repository root. A custom build node can mount a different claim; read its name from the agent Pod volumes (Diagnostic Steps, step 1).

2. On that node or storage server, go to the version directory of the republished artifact. The group path is the `groupId` with `.` replaced by `/`:

   ```bash
   REPO=<cache-directory>
   GAV_DIR="$REPO/<group-path>/<artifactId>/<version>"
   ls -l --time-style=long-iso "$GAV_DIR"
   ```

   The jar date should match the earlier upload.

3. Move the version directory out of the repository.

   > **Warning:** Removing the version directory makes the next build download that artifact again. If the private repository is unreachable from the build, or the version was removed from it, that build fails on dependency resolution. A build that runs on the same cache while you move the directory can fail or package a partial file. Precondition: only when Cause 1 is confirmed by Diagnostic Steps, the repository already serves the new jar, and no pipeline that uses this cache is running. Rollback: move the directory back (command below). Deleting the backup later is irreversible.

   ```bash
   mkdir -p /root/maven-cache-backup
   mv "$GAV_DIR" /root/maven-cache-backup/<artifactId>-<version>
   # rollback:
   # mv /root/maven-cache-backup/<artifactId>-<version> "$GAV_DIR"
   ```

4. Run the pipeline again. The Maven stage log shows `Downloading from <repository-id>:` and `Downloaded from <repository-id>:` for `<artifactId>-<version>.jar`, and the jar in the new image has the checksum of the new upload (Diagnostic Steps, step 4). Then remove the backup directory.

Each further republish under the same version leaves the cache in the same state, so the cleanup has to be repeated. In general Maven practice, a library that changes without a version bump is published as a `-SNAPSHOT` version and the consuming build runs with `-U`, or each change gets a new release version. Running `-U` on every build adds update checks and time to the Maven stage.

## Diagnostic Steps

1. Confirm which cache the build uses. While the pipeline runs, describe the Java agent Pod and read the volume mounted at `/root/.m2/repository` and its claim name:

   ```bash
   kubectl get pod -A | grep java
   kubectl describe pod -n <namespace> <java-agent-pod>
   ```

2. Check whether the build downloaded the artifact or resolved it locally. In the exported Maven stage log:

   ```bash
   grep -nE 'Download(ing|ed) from .*<artifactId>-<version>' <pipeline-log-file>
   ```

   No match means the jar came from the local repository, which is the Cause 1 path.

3. Compare the cached jar with what the repository serves now. In the cache, or inside a running agent Pod at `/root/.m2/repository`:

   ```bash
   ls -l --time-style=long-iso "$GAV_DIR"
   sha1sum "$GAV_DIR/<artifactId>-<version>.jar"
   cat "$GAV_DIR/_remote.repositories"
   ```

   `_remote.repositories` names the repository id the jar was downloaded from. Ask that repository for the checksum of the current upload, using the URL from the build's `settings.xml`:

   ```bash
   curl -sS -u <user> "<repository-url>/<group-path>/<artifactId>/<version>/<artifactId>-<version>.jar.sha1"; echo
   ```

   Different checksums, with the cached file dated at the earlier upload, confirm Cause 1. If the repository still returns the checksum of the old jar, the republish has not reached the URL that the build resolves from (for example a group or proxy repository in front of the hosted one). Clearing the build cache would then download the same old file again, so fix the repository first.

4. Check the jar that ended up in the image:

   ```bash
   docker run --rm --entrypoint sh <service-image> -c 'sha1sum <app-lib-dir>/<artifactId>-<version>.jar'
   ```

   If that checksum already equals the repository's new checksum, the stale jar is not coming from the Maven cache, and Cause 1 does not apply.

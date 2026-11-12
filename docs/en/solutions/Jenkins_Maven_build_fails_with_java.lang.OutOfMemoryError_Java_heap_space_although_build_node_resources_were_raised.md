---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.0"
  - "4.3"
---

# Jenkins Maven build fails with java.lang.OutOfMemoryError Java heap space although build node resources were raised

## Issue

A Java back-end project cannot be deployed by a Jenkins pipeline because the build reports that the heap is full, while front-end pipelines on the same platform deploy normally. Raising the build node resources did not help. Typically:

- The `mvn-build` stage runs for about 15 minutes and then fails; the later `image-build` and `deploy` stages do not run.
- The stage log contains `The system is out of resources.` and `java.lang.OutOfMemoryError: Java heap space`, with a stack trace through `lombok` and `com.sun.tools.javac`, so the failure happens while the code is compiled.
- The build node resources were already raised, for example to request CPU `2` / memory `2Gi` and limit CPU `3` / memory `3Gi` on the `java` build node, and the error did not change.

The platform default `java` build node uses the image `devops/builder-java:8`, the labels `java`, `java-openjdk8`, `maven`, `maven3.5`, and mounts the Maven cache PVC `maven-cache` at `/root/.m2/repository`. Build node resources are edited under **Toolchain Management** > **Instance Management** > the Jenkins instance > **Build Nodes** > edit the node. A project can have its own auto-assigned Jenkins instance, so the instance that runs the pipeline is not necessarily the one that was edited.

## Root Cause

### Cause 1: the Maven JVM heap is too small

The Maven JVM does not have enough heap to compile and package the project. Neither Jenkins nor the size of the build container causes the failure, and a larger container limit does not, by itself, give Maven a larger heap. The JVM picks its default maximum heap when it starts, and an explicit `-Xmx` in `MAVEN_OPTS` overrides that default. Starting Maven with an explicit heap lets the pipeline deploy; in the reported case the build time also dropped from about 15 minutes to about 3 minutes.

Raising the build node resources first does not help for two reasons: the heap does not change, and the edit may be made on a Jenkins instance that the pipeline does not use.

## Resolution

### Cause 1: the Maven JVM heap is too small

Apply this only when the Maven stage log contains `java.lang.OutOfMemoryError: Java heap space`. A Pod that ends `OOMKilled` without that line has a container limit problem (see Diagnostic Steps).

1. Set the Maven JVM heap on the packaging command in the pipeline's Maven stage:

   ```bash
   MAVEN_OPTS="-Xmx2048m -Xms1024m -XX:MaxPermSize=512m" mvn clean package
   ```

   `-XX:MaxPermSize` applies only to Java 7 and earlier. A Java 8 JVM, such as the one in `builder-java:8`, prints a warning that it ignores the option and then runs. Java 17 and later JVMs can refuse to start with `Unrecognized VM option 'MaxPermSize=512m'`; on those build nodes (for example `java21`), drop that option and keep `-Xmx2048m -Xms1024m`.

2. Keep `-Xmx` below the memory limit of the build container, with room for non-heap memory (metaspace, threads, and the compiler's native memory). A 2 GiB heap fits a `3Gi` limit. Against a node that still has a lower default limit, for example the `java21` build node default of request CPU `500m` / memory `750Mi` and limit CPU `1` / memory `2500Mi`, a 2 GiB heap leaves little room, so raise the limit as well.

   > **Warning:** Higher requests and limits on a build node apply to every pipeline that runs on that node, and the requests count against the namespace quota. The agent Pod can stay Pending if no node or quota can satisfy them. Precondition: you confirmed in Diagnostic Steps which Jenkins instance and build node the pipeline actually uses. Rollback: set the previous request and limit values back on the build node.

   Edit the build node on the Jenkins instance that the pipeline uses: **Toolchain Management** > **Instance Management** > that Jenkins instance > **Build Nodes** > the node (for example `java`) > change **Resource Requests** and **Resource Limits**. Two to three times the original values is a reasonable guideline.

3. On a custom build node, `MAVEN_OPTS` can also be set in the node's **Environment Variables** field, so that every Maven run on it gets the heap. A per-project alternative is the standard Maven file `.mvn/jvm.config` in the repository.

4. Run the pipeline again. The `mvn` stage finishes without `OutOfMemoryError`, followed by the image build and deploy stages.

## Diagnostic Steps

1. Confirm the error text in the exported pipeline log:

   ```bash
   grep -nE 'OutOfMemoryError|The system is out of resources|GC overhead limit exceeded' <pipeline-log-file>
   ```

2. While the pipeline runs again, find the agent Pod on the pipeline's cluster and check that it uses the instance and build node you edited:

   ```bash
   kubectl get pod -A | grep java
   kubectl describe pod -n <namespace> <java-agent-pod>
   ```

   The output shows the image (for example `devops/builder-java:8`) and the `Limits` and `Requests` of each container. If those values are not the ones you set, the pipeline runs on a different Jenkins instance or build node; edit the build node of the instance that serves the project.

3. Check whether the JVM ran out of heap or the container was killed:

   ```bash
   kubectl get pod -n <namespace> <java-agent-pod> -o jsonpath='{range .status.containerStatuses[*]}{.name}{" "}{.state.terminated.reason}{" "}{.lastState.terminated.reason}{"\n"}{end}'
   ```

   `OOMKilled` means the container limit is too small for the heap plus non-heap memory. `java.lang.OutOfMemoryError: Java heap space` in the log, without `OOMKilled`, is Cause 1.

4. To see the default heap of the JVM in that container and what Maven receives, add these lines before `mvn` in the stage once:

   ```bash
   echo "MAVEN_OPTS=${MAVEN_OPTS-unset}"
   java -XX:+PrintFlagsFinal -version 2>/dev/null | grep -E ' MaxHeapSize '
   ```

   A `MaxHeapSize` far below the size the project needs to compile, with `MAVEN_OPTS` unset, matches Cause 1.

A Maven stage that fails on dependency resolution, or a green build whose image contains an old copy of a republished dependency, is a different problem; the latter is covered in "Jenkins Maven build packages an old dependency jar after the same version is republished to the private repository".

---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - 4.4.x
---

# Tekton pipeline Maven task fails with java.lang.OutOfMemoryError Java heap space on ACP

## Issue

A Tekton pipeline fails in its Maven build task. The task log ends with:

```text
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:<version>:compile (default-compile) on project <project>: Fatal error compiling: java.lang.OutOfMemoryError: Java heap space -> [Help 1]
```

The question that follows is how to give the pipeline's Maven task more resources. The Pod of the task is not necessarily `OOMKilled`; the Java process inside it runs out of heap.

The same error in a Jenkins pipeline is covered in "Jenkins Maven build fails with java.lang.OutOfMemoryError Java heap space although build node resources were raised".

## Root Cause

### Cause 1: the Maven JVM heap is too small for the build

`java.lang.OutOfMemoryError: Java heap space` is raised by the JVM when the heap reaches its maximum size (`-Xmx`). The compiler runs inside the Maven JVM, so a large project can exhaust the heap during `compile` even though the container still has free memory. Raising only the container memory does not raise the heap if the JVM keeps the same `-Xmx`; the heap limit has to be raised, and the container limit has to leave room for it.

Two places control this in a Tekton pipeline:

- The `mavenOpts` parameter of the Maven task. Its value is appended after the task's default JVM options, so an `-Xmx` set there takes effect. The Maven step has a memory limit of `2Gi`, so the heap plus metaspace set through `mavenOpts` must fit inside `2Gi`.
- The `taskRunSpecs` of the PipelineRun. An entry for the Maven task can set larger compute resources for that task and add JVM options through an environment variable, for builds that need more than the default step limit allows.

## Resolution

### Cause 1

Use option A when a heap that fits in `2Gi` is enough. Use option B when the build needs more memory than that.

**Option A: set the heap through the `mavenOpts` task parameter**

1. Edit the pipeline and, on the Maven task, set the `mavenOpts` parameter, for example to a 1 GiB heap:

   ```yaml
   params:
     - name: mavenOpts
       value: "-Xmx1g"
   ```

   Put JVM options only in `mavenOpts`. Do not add them to the `goals` list; entries in `goals` are passed to Maven as goals and arguments, not to the JVM.

2. Keep the heap plus metaspace below the `2Gi` step limit, with room for the JVM's other native memory. TaskRuns that do not set `mavenOpts` keep the previous default behaviour, so only runs started after the change use the new heap.

3. Run the pipeline again.

**Option B: give the Maven task more resources with `taskRunSpecs`**

1. Open the failed run and choose **Re-run Pipeline**, then add a `taskRunSpecs` entry to the PipelineRun YAML. Set `pipelineTaskName` to the name of the Maven task as it is written in your pipeline (`maven` in this example):

   ```yaml
   spec:
     taskRunSpecs:
       - pipelineTaskName: maven
         computeResources:
           requests:
             cpu: "4"
             memory: 8Gi
           limits:
             cpu: "4"
             memory: 16Gi
         podTemplate:
           env:
             - name: JAVA_TOOL_OPTIONS
               value: "-Xms4g -Xmx12g -XX:MaxMetaspaceSize=2g"
   ```

   The values are an example: keep `-Xmx` plus `MaxMetaspaceSize` below the memory limit, with headroom for non-heap memory.

   > **Warning:** The larger requests count against the namespace ResourceQuota and must fit on a node. If they cannot be satisfied, the task Pod stays `Pending` and the run does not start the Maven task. Apply this only after Diagnostic Steps confirmed `java.lang.OutOfMemoryError: Java heap space`. To roll back, re-run without the `taskRunSpecs` entry.

2. To make the change permanent, add the same `taskRunSpecs` entry wherever the PipelineRun is created for this pipeline (for example its trigger template), instead of adding it on every re-run.

3. Run the pipeline. The Maven task completes without `OutOfMemoryError`.

## Diagnostic Steps

1. Confirm the error type in the failed task's log. `java.lang.OutOfMemoryError: Java heap space` is this cause. `GC overhead limit exceeded` is also heap exhaustion and has the same fix.

2. Check whether the task container was killed instead:

   ```bash
   kubectl get pod -n <namespace> -l tekton.dev/pipelineRun=<pipelinerun> \
     -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.containerStatuses[*].state.terminated.reason}{"\n"}{end}'
   ```

   `OOMKilled` on the Maven task Pod means the container limit is smaller than the heap plus non-heap memory: lower `-Xmx` or raise the limit (option B). `Error` together with the `Java heap space` message in the log is Cause 1 with a heap that is too small.

3. Check the memory limits the Maven task Pod actually received, after a change:

   ```bash
   kubectl get pod -n <namespace> <maven-task-pod> \
     -o jsonpath='{range .spec.containers[*]}{.name}{" limits="}{.resources.limits.memory}{" requests="}{.resources.requests.memory}{"\n"}{end}'
   ```

   With option B, the Maven step container shows the limit set in `taskRunSpecs`. If it still shows the old value, the `pipelineTaskName` in the entry does not match the task name in the pipeline.

4. Check which JVM options reach Maven:

   ```bash
   kubectl get pod -n <namespace> <maven-task-pod> \
     -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{range .env[*]}{"  "}{.name}={.value}{"\n"}{end}{end}'
   ```

   With option B, `JAVA_TOOL_OPTIONS` is listed on the Maven step container, and the task log contains `Picked up JAVA_TOOL_OPTIONS: ...` from the JVM. When the same option appears more than once, the JVM uses the last one; options given on the command line, such as those from `mavenOpts`, come after `JAVA_TOOL_OPTIONS`. If the heap does not change with option B, set the same `-Xmx` through `mavenOpts` as well, keeping it below the container limit shown in step 3.

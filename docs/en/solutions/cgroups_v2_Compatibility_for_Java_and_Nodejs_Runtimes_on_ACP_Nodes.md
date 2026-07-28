---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# cgroups v2 Compatibility for Java and Node.js Runtimes on ACP Nodes
## Overview

ACP worker nodes on recent releases run the kernel's **cgroups v2** hierarchy by default. Most containers run unchanged on v2 — the API surface is slightly different but the enforcement semantics are similar. Container-aware runtimes that read cgroup limits at start-up to size their internal buffers and heap, however, need runtime support for the v2 layout to read the limits correctly.

The runtime most often affected is the JVM: it reads `memory.max` (v2) or `memory.limit_in_bytes` (v1) at boot to configure its `MaxRAM`, and then derives the default heap from that. A JVM built without v2 awareness reads no limit (the v1 file does not exist on v2 nodes), falls back to **host-level memory** as the ceiling, and sizes its heap accordingly. On a node with plenty of host memory but tight per-container limits, the JVM over-allocates and gets OOM-killed the moment the cgroup's `memory.max` is crossed.

This note summarises the minimum runtime versions that are cgroups-v2-aware, the specific failure mode that occurs when they are not, and how to verify a given container's runtime detects v2 correctly before migrating workloads onto a v2 node.

## Minimum Compatible Runtime Versions

| Runtime | Minimum cgroups-v2-aware version |
|---|---|
| OpenJDK / HotSpot | **8u372+**, **11.0.16+**, **17+** (21, 25 fine) |
| Eclipse OpenJ9 / IBM Semeru | **8u382+**, **11.0.16.0+**, **17.0.4.0+**, **18.0.2.0+** |
| IBM SDK Java | **8.0.7.15+** |
| Node.js | **20+** |
| .NET | **5.0+** |

A runtime older than the minimum row above does not detect cgroups v2. On a v2 node, it reads the *host* memory/CPU as its effective limit. On a v1 node it works normally — the issue appears specifically when the node is upgraded to v2 or a pod is rescheduled onto a v2 node.

For middleware layered on top of a JVM (application servers, message brokers, data-grid products), v2 compatibility is inherited from the underlying OpenJDK / Semeru version. A build that ships with OpenJDK 17 is automatically v2-aware; a build that ships with an older OpenJDK 11 needs an upgrade to 11.0.16+ before it is safe on v2.

## Root Cause of the OOMKill

A JVM started in a container with `-XX:+UseContainer` (the default in every modern build) runs the following flow at start-up:

1. Look at `/sys/fs/cgroup/memory.max` (v2) or `/sys/fs/cgroup/memory/memory.limit_in_bytes` (v1) to learn the cgroup's memory ceiling.
2. Derive `MaxRAM` from that ceiling.
3. Size the heap as a fraction of `MaxRAM` (default ~25 %, tunable via `-XX:MaxRAMPercentage`).

A JVM without v2 support tries step 1 by reading the v1 file. On a v2 node that file does not exist; the JVM's probe fails, and it falls back to "no container limits detected" — which in practice means the JVM reads the **host** memory from `/proc/meminfo` and sizes its heap against that.

Consequences:

- On a node with 32 GiB host memory and a container `limits.memory: 1Gi`, a v1-only JVM computes `MaxRAM = 32 GiB`, sets the heap to roughly 8 GiB, and starts allocating against it.
- The JVM's allocation pattern grows over time under load.
- Well before the JVM fills its 8 GiB heap, the cgroup's 1 GiB `memory.max` is hit and the kernel OOM-killer reaps the container with `exitCode: 137`.
- The pod restarts, runs for a while, and OOMs again — the heap sizing is unchanged so the outcome is the same.

The fix is always to use a runtime that understands v2; tuning `MaxRAMPercentage` by hand on a v1-only runtime is unreliable because the denominator (`MaxRAM`) is already wrong.

## Verifying Runtime Compatibility Inside the Container

Ask the JVM directly which cgroup provider it detected:

```bash
kubectl exec -it <java-pod> -- java -XshowSettings:system -version 2>&1 | head -30
```

Output on a v2-aware JVM running in a v2 container:

```text
Operating System Metrics:
    Provider: cgroupv2
    CPU Period: 100000us
    CPU Quota: <limit from the pod's cpu request/limit>
    Memory Limit: <memory.max from the cgroup>
    Memory Soft Limit: ...
```

On a v2-oblivious JVM the same command prints:

```text
Operating System Metrics:
    No metrics available for this platform
```

or:

```text
Operating System Metrics:
    Provider: cgroupv1
    ...
```

against a v2 node (this is the signature of the OOM risk — the JVM is reading v1 files that the node does not have).

For Node.js, `process.resourceUsage()` and the process's own reported memory-limit (what you log from inside the app) should reflect the container's `memory.max` in MiB. If the value matches host RAM, the runtime did not read the cgroup correctly.

For .NET, inspect the output of `Environment.ProcessorCount` against the pod's `cpu` limit — a mismatch where the app sees every host core despite a low `cpu` limit means the .NET runtime is not container-aware for that scenario.

## Resolution

Two paths, one long-term and one tactical.

### Upgrade the runtime in the container image

Rebuild or re-pull the container image so it ships a runtime version at or above the minimums above. For a base-image-driven build:

- Change `FROM openjdk:11-...` to `FROM openjdk:17-...` (or `FROM openjdk:11-jre-slim` built on 11.0.16 or later — check the tag's actual runtime version).
- Similarly for Node.js: upgrade from Node 16/18 to Node 20+.
- For .NET 3.1 apps still in production, upgrade to .NET 5+ (or later LTS).

Verify the rebuilt image reports `Provider: cgroupv2` in the shown-settings output before promoting to clusters that run v2 nodes.

### Delay the node cgroups migration

If the runtime cannot be upgraded quickly (a large inventory of containers, a vendor-supplied image with no replacement, a compliance-frozen release), keep the affected workloads on cgroups-v1 nodes until the runtime upgrade is ready. Segment the cluster with node labels / taints and use `nodeSelector` / `tolerations` so the old-runtime workloads land only on v1 nodes; the rest of the cluster moves to v2 as planned.

This is a holding pattern only. Support and ecosystem momentum is on v2 — plan the runtime upgrade work in parallel with the segmentation.

### If you cannot change either the runtime or the node cgroup

As a last resort, give the JVM the numbers it can't detect. Set `-XX:MaxRAM` explicitly in the container's JVM options so the heap sizing does not fall through to the host:

```yaml
env:
  - name: JAVA_OPTS
    value: "-XX:MaxRAM=1g -XX:MaxRAMPercentage=50"
```

Adjust `MaxRAM` to the container's `limits.memory` minus a safety margin for off-heap usage. This is fragile — every limit change has to be mirrored in the env var — but unblocks the workload while the real fix is scheduled.

## Diagnostic Steps

Identify which pods are at risk by listing all pods running a known-old Java runtime. If the image tag encodes the version, a cluster-wide scan can find them:

```bash
kubectl get pod -A -o json | \
  jq -r '.items[] | .spec.containers[] | "\(.image)"' | sort -u | \
  grep -iE 'openjdk:(8u[0-3]|11\.0\.([0-9]|1[0-5])|17|.*-[0-9])'
```

Inspect the cgroup layout on a representative node to confirm v2 is actually in effect there. ACP's cluster PSA rejects `chroot /host`; read the host's cgroup layout through the debug pod's `/host` bind-mount instead:

```bash
kubectl debug node/<node> --image=<image-with-shell> -- sh -c '
  ls -ld /host/sys/fs/cgroup
  cat /host/proc/mounts | grep cgroup
'
```

Output showing `cgroup2 on /sys/fs/cgroup` (in `/proc/mounts`) confirms the node is v2. A `tmpfs on /sys/fs/cgroup` with nested v1 subsystems (`/sys/fs/cgroup/memory/`, `/sys/fs/cgroup/cpu/`) indicates v1 is still in effect on that node.

Finally, observe the actual OOM rate on potentially-affected pods over a business cycle. If `kubectl get pod -A` shows recurring `OOMKilled` statuses on pods whose workloads are not otherwise growing, and the pods use Java or Node.js on versions below the minimums listed above, the runtime / cgroups-v2 mismatch is the likely cause — verify with the `java -XshowSettings:system` check inside one of the affected pods before closing the investigation.

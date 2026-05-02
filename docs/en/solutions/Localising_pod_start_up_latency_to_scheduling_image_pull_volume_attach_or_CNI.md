---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Localising pod start-up latency to scheduling, image pull, volume attach, or CNI
## Issue

Pods are visibly slow to come up — pipeline TaskRun pods, build pods, autoscaled workers — and the operator wants to know which layer is eating the time. The lifecycle of a pod from creation to the first container exec spans several independent components: the scheduler, the volume manager, the CNI (sometimes plus a meta-CNI such as Multus), the image puller, and finally the runtime that starts the container. Without a per-stage timestamp it is easy to spend an afternoon blaming the wrong layer.

This article describes a pure-API technique that pulls those timestamps out of the cluster's normal event stream, with no extra agent and no per-node debug shell required.

## Resolution

The two timestamps every pod publishes are:

- **Events** with `reason=Scheduled`, `SuccessfulAttachVolume`, `AddedInterface`, `Pulling`, `Pulled`, `Created`, `Started`, posted by the scheduler / volume manager / CNI / runtime in turn.
- **Pod conditions** (`PodScheduled`, `Initialized`, `PodReadyToStartContainers`, `ContainersReady`, `Ready`) with their `lastTransitionTime`, recorded by the kubelet.

Lining them up on a single timeline tells you which gap is paying the rent.

### 1. Pull the events for the pod

Filter the namespace's events to the pod, sort by time, and print just the reason and the two timestamps each event carries (`eventTime` for newer events, `lastTimestamp` for legacy ones — keep both columns, since one is empty depending on which path posted the event):

```bash
NS=<namespace>
POD=<pod>
kubectl get events -n "$NS" \
  --field-selector "involvedObject.name=${POD}" \
  -o jsonpath='{range .items[*]}{.reason}{"\t"}{.eventTime}{"\t"}{.lastTimestamp}{"\n"}{end}' \
  | sort -k2,3
```

Typical output looks like:

```text
Scheduled                  2026-03-04T15:19:33Z   <none>
SuccessfulAttachVolume     <none>                 2026-03-04T15:19:36Z
AddedInterface             <none>                 2026-03-04T15:19:38Z
Pulling                    <none>                 2026-03-04T15:19:38Z
Pulled                     <none>                 2026-03-04T15:20:11Z
Created                    <none>                 2026-03-04T15:20:11Z
Started                    <none>                 2026-03-04T15:20:12Z
```

### 2. Pull the pod's own condition transitions

The kubelet records its view of the lifecycle as a list of conditions:

```bash
kubectl get pod "$POD" -n "$NS" \
  -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.lastTransitionTime}{"\n"}{end}' \
  | sort -k2
```

Typical output:

```text
PodScheduled               2026-03-04T15:19:33Z
Initialized                2026-03-04T15:19:33Z
PodReadyToStartContainers  2026-03-04T15:19:54Z
ContainersReady            2026-03-04T15:20:29Z
Ready                      2026-03-04T15:20:29Z
```

### 3. Read the gaps as latency

Subtracting consecutive timestamps gives the time each layer cost:

| Gap | Layer responsible |
|---|---|
| pod creation → `Scheduled` | scheduler queue / scheduling decision |
| `Scheduled` → `SuccessfulAttachVolume` | CSI controller + node attacher |
| volume attached → `AddedInterface` | CNI (and Multus if a NAD is referenced) |
| `AddedInterface` → `Pulling` | runtime ready, kubelet starting the pull |
| `Pulling` → `Pulled` | registry latency, image size, parallel-pull limits |
| `Pulled` → `Started` | container runtime startup, exec hook |
| `Started` → `Ready` | application readiness probe |

A common signature is a multi-second or multi-minute gap between `creationTimestamp` and `AddedInterface` while everything else is sub-second — that is a meta-CNI (Multus) bottleneck, not a registry or scheduler problem. The `managedFields` on the pod records the same fact independently:

```bash
kubectl get pod "$POD" -n "$NS" -o yaml \
  | yq '.metadata.creationTimestamp,
        (.metadata.managedFields[] | select(.manager=="multus") | .time)'
```

If the second timestamp is several seconds after the first on a steady pace, the Multus daemonset on the node is the bottleneck (often because the node's interface plumbing is contended, or because the NAD references a network operator that itself has not yet posted the IPAM result).

### 4. Aggregate across many pods if the issue is statistical

When the slowness is intermittent, run the same extraction across a recent window of pods and group by gap. A small shell loop is enough — feed the per-pod gaps into a histogram. The point of the aggregation is not exactness but to identify which gap drifts; the layer that drifts is the layer to instrument deeper (CSI driver logs, CNI logs, registry latency from a probe pod).

## Diagnostic Steps

1. Confirm the events are not being lost or rate-limited. The default event TTL is one hour; pods that started more than an hour ago may not have events any more. For long-running diagnoses, pull events in real time with `kubectl get events -A -w` while reproducing the issue.

2. If the pod has init containers, the `Initialized` condition includes their time too. Distinguish "init container ran for a long time" from "kubelet was slow to start init containers" by reading `status.initContainerStatuses`:

   ```bash
   kubectl get pod "$POD" -n "$NS" -o yaml \
     | yq '.status.initContainerStatuses[] |
            { name, started: .state.terminated.startedAt,
              finished: .state.terminated.finishedAt }'
   ```

3. The image pull stage is the easiest layer to instrument independently — run a throwaway pod on the same node with the same image and time how long the pull takes:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- crictl pull <same-image>
   ```

   A consistent multi-second pull on a known-good image points at registry network or rate-limiting; a fast pull while the original pod is slow points at parallel-pull saturation on the kubelet.

4. The CNI gap is the most platform-dependent. If `AddedInterface` is what drifts, look at the CNI daemonset logs on the affected node and at the IPAM provider — many of the worst latency cases are a slow IPAM allocation, not the CNI itself.

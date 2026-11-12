---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# base AppRelease stays failed because the upgrade-sysctl-config BroadcastJob cannot finish on a large cluster on ACP

## Issue

On a cluster with many nodes (more than a hundred), the `base` AppRelease (`ar`, also shown as `ars base`) in `cpaas-system` stays in a failed state. In `cpaas-system`, the BroadcastJob `upgrade-sysctl-config` is created again and again and never completes:

```bash
kubectl -n cpaas-system get ar base
kubectl -n cpaas-system get broadcastjob upgrade-sysctl-config
```

The same AppRelease can also stay in `syncing` on a cluster of any size, for example when the pre-upgrade check of a business cluster shows its base component (Cluster Base, AppRelease `base`) in `syncing` and it never finishes, or a business cluster ARS stays `syncing` for a long time. `kubectl get bcj -n cpaas-system` then shows a BroadcastJob (`broadcastjobs.operator.alauda.io`, short name `bcj`) whose `SUCCEEDED` count stays below `DESIRED`, or with `FAILED` greater than `0`. Adding a dummy key to the ARS values to force a new sync does not help.

## Root Cause

The `base` AppRelease includes the BroadcastJob `upgrade-sysctl-config`, which runs a Pod on every node. The AppRelease has a timeout (`spec.timeout`) within which its resources must become ready. On a large cluster the BroadcastJob cannot finish on all nodes within that timeout. The sentry component that watches the release then judges the operation as timed out and runs it again. The new run starts over and times out the same way, so the `base` AppRelease never becomes healthy.

### A Pod of upgrade-sysctl-config was Evicted

`kubectl get job,bcj -n cpaas-system` shows `upgrade-sysctl-config` with, for example, `DESIRED 5`, `ACTIVE 0`, `SUCCEEDED 4`, `FAILED 1`, and one `upgrade-sysctl-config-<suffix>` Pod in `cpaas-system` is `Evicted` while the others are `Completed`. Because of the failed Pod the BroadcastJob never counts all nodes as succeeded, and the base component stays in `syncing`. Ordinary Jobs in the same list (for example `keep-marketplace-resources`, `Complete`) are not involved. Deleting the Evicted Pod lets the base component recover.

### update-containerd-config does not finish

The `sentry` log ties the long `syncing` state of a business cluster ARS to BroadcastJob `update-containerd-config`, and some of its jobs are stuck. `update-containerd-config` synchronizes and updates the containerd configuration on the nodes and is triggered whenever the business cluster ARS is updated. Raising the BroadcastJob `parallelism` to `10` lets every job finish with `success`, and the ARS returns to normal. Why individual jobs get stuck is not known.

## Resolution

Use one of the two options.

### Option 1: delete the BroadcastJob

> **Warning:** Deleting `upgrade-sysctl-config` stops any of its Pods that are still running, so the sysctl update may not have run on every node. Do this only when the diagnostic steps show that the `base` AppRelease is failing on this BroadcastJob and that it keeps restarting. Save the object first. Rollback: `kubectl apply -f /tmp/upgrade-sysctl-config.yaml`.

```bash
kubectl -n cpaas-system get broadcastjob upgrade-sysctl-config -o yaml > /tmp/upgrade-sysctl-config.yaml
kubectl -n cpaas-system delete broadcastjob upgrade-sysctl-config
kubectl -n cpaas-system get ar base -w
```

### Option 2: give the AppRelease more time

> **Warning:** While `cluster-transformer` is scaled to zero, that platform controller is not running on this cluster. Keep the window short and scale it back as soon as the `base` AppRelease is healthy. Rollback: scale `cluster-transformer` back to the recorded replica count and patch `spec.timeout` back to the recorded value.

1. Record the current replica count of `cluster-transformer` and the current timeout of the `base` AppRelease:

   ```bash
   kubectl -n cpaas-system get deploy cluster-transformer -o jsonpath='{.spec.replicas}{"\n"}'
   kubectl -n cpaas-system get ar base -o jsonpath='{.spec.timeout}{"\n"}'
   ```

2. Stop `cluster-transformer` and raise the timeout (in seconds):

   ```bash
   kubectl -n cpaas-system scale deploy/cluster-transformer --replicas=0
   kubectl -n cpaas-system patch ar base --type merge -p '{"spec":{"timeout":1800}}'
   ```

3. Wait until the `base` AppRelease is healthy, then scale `cluster-transformer` back to the recorded replica count:

   ```bash
   kubectl -n cpaas-system get ar base -w
   kubectl -n cpaas-system scale deploy/cluster-transformer --replicas=<recorded-replicas>
   ```

The two options above apply when the BroadcastJob is only slow. The following sections apply to the other two causes in Root Cause.

### Evicted Pod in upgrade-sysctl-config: delete the Evicted Pod

1. Confirm the signature and read the eviction message, which names the node resource that ran short:

   ```bash
   kubectl get job,bcj -n cpaas-system
   kubectl -n cpaas-system get pods -o wide | grep upgrade-sysctl-config
   kubectl -n cpaas-system get pod <evicted-pod> -o jsonpath='{.status.phase} {.status.reason}: {.status.message}{"\n"}'
   ```

2. Check that the node no longer reports that pressure; a node still under memory or disk pressure has to be cleared first, otherwise a new Pod there can be evicted again:

   ```bash
   kubectl describe node <node-name> | grep -E 'MemoryPressure|DiskPressure|PIDPressure'
   ```

3. Save the Evicted Pod, because its status is the only record of the eviction:

   ```bash
   kubectl -n cpaas-system get pod <evicted-pod> -o yaml > "$HOME/<evicted-pod>.yaml"
   ```

> **Warning:** Deleting the Pod object removes its eviction status and message from the cluster; the Pod is not running, so no workload stops. Precondition: only when `upgrade-sysctl-config` (or the BroadcastJob the base component waits on) shows `FAILED` greater than `0`, the failed Pod is `Evicted`, the other Pods of that BroadcastJob are `Completed`, and the YAML above is saved. Rollback: none for the Pod object; the saved YAML keeps the eviction details.

4. Delete the Evicted Pod and watch the base component:

   ```bash
   kubectl -n cpaas-system delete pod <evicted-pod>
   kubectl get job,bcj -n cpaas-system
   kubectl get ars -A | grep -i base
   ```

Confirm that the component shows synced on the cluster page before you start a business cluster upgrade. If it stays in `syncing`, collect the BroadcastJob YAML and the `sentry` log before trying anything else.

### update-containerd-config does not finish: raise its parallelism

```bash
kubectl get broadcastjob -A | grep update-containerd-config
kubectl -n <namespace> get broadcastjob update-containerd-config -o yaml > "$HOME/update-containerd-config.yaml"
```

> **Warning:** A higher `parallelism` updates the containerd configuration on more nodes at the same time. Precondition: only when the ARS stays `syncing` and the `sentry` log points to an incomplete `update-containerd-config` BroadcastJob. Rollback: set `parallelism` back to the value in the export.

```bash
kubectl -n <namespace> patch broadcastjob update-containerd-config --type=merge -p '{"spec":{"parallelism":10}}'
kubectl -n <namespace> get broadcastjob update-containerd-config -w
```

Wait until all jobs are `success`, then check that the ARS leaves `syncing`.

## Diagnostic Steps

1. Check the state of the `base` AppRelease and its conditions:

   ```bash
   kubectl -n cpaas-system get ar base
   kubectl -n cpaas-system get ar base -o yaml | grep -n -i -A5 'conditions\|timeout'
   ```

2. Check the BroadcastJob and its progress. Compare `DESIRED` with the node count. A job that keeps a new, short age and never reaches `SUCCEEDED` equal to `DESIRED` is being restarted:

   ```bash
   kubectl get nodes --no-headers | wc -l
   kubectl -n cpaas-system get broadcastjob upgrade-sysctl-config
   kubectl -n cpaas-system get pods -o wide | grep upgrade-sysctl-config
   ```

3. Rule out a BroadcastJob that fails rather than one that is only slow. If its Pods end in `Error` or stay `Pending` on some nodes, a longer timeout does not help. Read those Pods first:

   ```bash
   kubectl -n cpaas-system get pods | grep upgrade-sysctl-config | grep -v -E 'Running|Completed'
   kubectl -n cpaas-system describe pod <upgrade-sysctl-config-pod>
   ```

4. List every BroadcastJob and read the `sentry` log, because the BroadcastJob that holds the AppRelease differs between cases. `FAILED` greater than `0` with an `Evicted` Pod is the Evicted-Pod cause. An `update-containerd-config` that stays below `DESIRED` with stuck jobs, named in the `sentry` log, is the `update-containerd-config` cause. If every BroadcastJob and Job is complete and the `sentry` log shows `Watching for changes to Job <name>` followed by `Jobs active: 0`, the chart is waiting on a hook Job instead:

   ```bash
   kubectl get bcj -A
   kubectl get pods -A | grep -E 'upgrade-sysctl-config|update-containerd-config'
   kubectl -n cpaas-system logs <sentry-pod> --tail=500 | grep -E 'update-containerd-config|upgrade-sysctl-config|Watching for changes to Job|Jobs active'
   ```

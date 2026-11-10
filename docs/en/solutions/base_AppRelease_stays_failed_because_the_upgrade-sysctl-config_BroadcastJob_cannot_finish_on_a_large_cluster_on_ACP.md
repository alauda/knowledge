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

## Root Cause

The `base` AppRelease includes the BroadcastJob `upgrade-sysctl-config`, which runs a Pod on every node. The AppRelease has a timeout (`spec.timeout`) within which its resources must become ready. On a large cluster the BroadcastJob cannot finish on all nodes within that timeout. The sentry component that watches the release then judges the operation as timed out and runs it again. The new run starts over and times out the same way, so the `base` AppRelease never becomes healthy.

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

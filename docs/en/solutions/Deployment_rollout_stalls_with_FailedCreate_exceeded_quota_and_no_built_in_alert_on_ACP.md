---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.3"
---

# Deployment rollout stalls with FailedCreate exceeded quota and no built-in alert on ACP

## Issue

A Deployment rolling update in a namespace with a ResourceQuota gets stuck halfway, for example at a mix of new and old Pods, and finishes on its own only after tens of minutes. Occasionally the same update does not get stuck and all Pods come up at once. Removing the quota, lowering `maxSurge`, or raising `maxUnavailable` each avoids the stall. The new ReplicaSet keeps reporting:

```text
Warning  FailedCreate  replicaset/<new-replicaset>  Error creating: pods "<pod-name>" is forbidden: exceeded quota: default, requested: limits.cpu=8,limits.memory=8Gi, used: limits.cpu=40,limits.memory=40Gi, limited: limits.cpu=40,limits.memory=40Gi
```

In a related form, the rollout never finishes: the current replicas match the desired count and are `Running`, the console status icon keeps spinning, and the only event is that namespace resources are insufficient. There is no Pod startup failure, and a monitor or alert is wanted for workloads left in that state without using event alerts.

## Root Cause

### Cause 1: the surge Pod does not fit in the quota, and the rollout completes only when an old Pod frees quota in time

Every Pod the new ReplicaSet creates must pass ResourceQuota admission, which counts it on top of the Pods that still exist. Example: the quota `default` is `limits.cpu=40`, `limits.memory=40Gi`, the Deployment runs 5 Pods at 8 CPU and 8 GiB limits each, and the strategy is `maxSurge: 1`, `maxUnavailable: 1`. The 5 running Pods already use the whole quota, so the surge Pod is rejected and the rollout stalls while the ReplicaSet keeps retrying and producing `FailedCreate` events. A rollout needs room for `replicas + maxSurge` Pods at once: 6 Pods at 8 CPU / 8 GiB need 48 CPU / 48 GiB.

When the update does not stall, it is timing: an old Pod is deleted and releases its quota before the next create attempt, or creates and deletes happen to be staggered so that each create finds room. Whether a given rollout stalls depends on that race, which is why it looks random. In general Kubernetes behavior, the ReplicaSet controller retries a failed create with an increasing back-off, so the retry that finds free quota can come well after the quota was released. The quota and the rolling update strategy conflict and should be aligned.

### Cause 2: the platform has no built-in alert for a rollout waiting on quota

When the surge Pod cannot be created, the old replicas stay `Running`, so the ready count still matches the desired count while the rollout stays incomplete and the console icon keeps spinning. No dedicated alert item exists for this state. A periodic check that compares the desired, up-to-date, ready, and available counts detects it.

## Resolution

### Cause 1: the surge Pod does not fit in the quota

Align the quota and the strategy with one of the following changes.

**Option A: give the quota room for the surge Pod**, at least `(replicas + maxSurge) x per-Pod limit` (48 CPU / 48 GiB in the example).

> **Warning:** A larger quota lets every workload in the namespace consume more of the cluster, not only this Deployment. Do this only when the `FailedCreate` events say `exceeded quota`, the cluster has spare capacity, and the namespace or project owner approves. Export the quota first with `kubectl -n <namespace> get resourcequota default -o yaml > /tmp/quota-default.yaml`; to roll back, run `kubectl apply -f /tmp/quota-default.yaml`.

```bash
kubectl -n <namespace> patch resourcequota default --type merge \
  -p '{"spec":{"hard":{"limits.cpu":"48","limits.memory":"48Gi"}}}'
```

If the quota is maintained from the console's namespace resource quota settings, change it there instead, so that both show the same value.

**Option B: roll without a surge Pod**, so that an old Pod is removed before a new one is created.

> **Warning:** With `maxSurge: 0` and `maxUnavailable: 1`, one replica is out of service during every step, so the Deployment runs at reduced capacity during the update. Do this only when the workload tolerates one fewer replica. Record the current strategy first; to roll back, patch `maxSurge` and `maxUnavailable` back to their previous values.

```bash
kubectl -n <namespace> patch deploy <name> --type merge \
  -p '{"spec":{"strategy":{"type":"RollingUpdate","rollingUpdate":{"maxSurge":0,"maxUnavailable":1}}}}'
```

To watch a rollout: `kubectl -n <namespace> rollout status deploy/<name>`.

### Cause 2: the platform has no built-in alert for a rollout waiting on quota

There is no built-in alert to enable. Run a periodic, read-only check that flags workloads whose status columns do not agree. For one cluster, with the current kubeconfig:

```bash
kubectl get deploy -A | awk 'NR>1 { split($3, a, "/"); if (a[1] != a[2] || a[2] != $4 || a[2] != $5) print }'
```

For several clusters, with one kubeconfig file per cluster in a directory:

```bash
mkdir -p <result-dir>
: > <result-dir>/result.out
for i in $(ls <kubeconfig-dir>)
do
  kubectl --kubeconfig=<kubeconfig-dir>/"$i" get sts -A | awk -v cluster="$i" 'NR>1 { split($3, a, "/"); if (a[1] != a[2]) print cluster, $0 }' >> <result-dir>/result.out
  kubectl --kubeconfig=<kubeconfig-dir>/"$i" get ds -A | awk -v cluster="$i" 'NR>1 { if (!($3==$4 && $4==$5 && $5==$6 && $6==$7)) print cluster, $0 }' >> <result-dir>/result.out
  kubectl --kubeconfig=<kubeconfig-dir>/"$i" get deploy -A | awk -v cluster="$i" 'NR>1 { split($3, a, "/"); if (a[1] != a[2] || a[2] != $4 || a[2] != $5) print cluster, $0 }' >> <result-dir>/result.out
done
```

A Deployment line is printed when the two READY numbers differ or when UP-TO-DATE or AVAILABLE is not the desired count; a StatefulSet line when the READY numbers differ; a DaemonSet line when DESIRED, CURRENT, READY, UP-TO-DATE, and AVAILABLE are not all equal. These mismatches include rollouts waiting on quota and other incomplete rollouts. The script does not send notifications: schedule it with an existing job runner and alert on a non-empty `result.out`.

A check on the Deployment status fields instead of the printed columns reports a Deployment as rolling when `observedGeneration < generation`, `updatedReplicas < spec.replicas`, `replicas > updatedReplicas`, or `availableReplicas < spec.replicas`:

```bash
kubectl get deploy -A -o json | jq -r '
  .items[]
  | {ns: .metadata.namespace, name: .metadata.name,
     gen: .metadata.generation, obs: (.status.observedGeneration // 0),
     spec: (.spec.replicas // 1), rep: (.status.replicas // 0),
     upd: (.status.updatedReplicas // 0), avail: (.status.availableReplicas // 0)}
  | select(.obs < .gen or .upd < .spec or .rep > .upd or .avail < .spec)
  | "Namespace: \(.ns) | Deployment: \(.name) | status: rolling"'
```

The `replicas > updatedReplicas` condition catches the quota case: the old ReplicaSet's Pods are still counted while the new one cannot add its surge Pod.

These checks only read status. A non-empty result is a list to investigate; do not delete a Deployment to clear a spinning icon.

## Diagnostic Steps

1. Confirm the quota rejection and compare the quota with the strategy and the limits:

   ```bash
   kubectl -n <namespace> get events --field-selector reason=FailedCreate --sort-by=.lastTimestamp
   kubectl -n <namespace> describe quota
   kubectl -n <namespace> get deploy <name> -o jsonpath='{.spec.replicas}{" "}{.spec.strategy}{"\n"}'
   kubectl -n <namespace> get deploy <name> -o jsonpath='{.spec.template.spec.containers[*].resources.limits}{"\n"}'
   ```

   Expected for Cause 1: `exceeded quota` with `used` equal to `limited` while the old Pods are still running, and `(replicas + maxSurge) x per-Pod limit` above the quota. A misspelled selector returns `field label not supported`; that is the typo, not a missing event.

2. `kubectl get deploy -n <namespace> <name>` shows READY equal to the desired count and UP-TO-DATE below it: the rollout is stuck, not a Pod crash (Cause 2). This is the row that the column check prints.

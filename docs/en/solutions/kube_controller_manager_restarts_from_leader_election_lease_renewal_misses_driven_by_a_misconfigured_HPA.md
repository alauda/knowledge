---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500307
---

# kube-controller-manager restarts from leader-election lease-renewal misses driven by a misconfigured HPA

## Issue

On Alauda Container Platform the kube-controller-manager (KCM) runs as a kubelet-managed control-plane static pod in the `kube-system` namespace — for example `kube-controller-manager-192.168.135.152`, carrying the static-pod mirror annotation and an owner reference of kind `Node`, with no separate managing operator. The pod holds control-plane leadership by periodically renewing a leader-election Lease object named `kube-controller-manager` in `kube-system` under the `coordination.k8s.io/v1` API; that Lease carries a `leaseDurationSeconds` of `15`, which is the renewal deadline the process must beat each cycle, and its `holderIdentity` and advancing `renewTime` reflect the live heartbeat (image `registry.alauda.cn:60080/tkestack/kube-controller-manager:v1.34.5`).

A symptom of this configuration is a KCM pod that restarts repeatedly: each restart increments the pod's `restartCount` and leaves a populated previous-termination block in pod status, and the underlying cause traces back to the process losing its leader-election lease.

## Root Cause

When the kube-controller-manager cannot reach its leader-election Lease in time, it follows the leader-election code path observable in its own logs: it attempts to acquire and renew the lease for `kube-system/kube-controller-manager`, and on a failed renewal logs the resource-lock retrieval error against that same lock (`error retrieving resource lock kube-system/kube-controller-manager`). This is the precursor to losing leadership.

The kube-controller-manager runs with `--leader-elect=true`, so it participates in leader election and a lost lease terminates the process; on that path the container's `lastState.terminated.reason` is recorded as `Error`. The process termination is what causes the pod to restart.

The horizontal-pod-autoscaler (HPA) controller runs as a controller loop inside the same kube-controller-manager process: the KCM is started with the default `--controllers=*` set, and the startup logs show the `horizontal-pod-autoscaler-controller` being started in-process. Because the HPA controller shares the process with leader election, the documented upstream failure mode is that sustained pressure inside that loop can compete with the timely renewal of the lease — and that Lease carries the `leaseDurationSeconds` of `15` the process must beat each cycle.

An HPA computing a CPU-utilization target depends on the targeted workload's container declaring a CPU resource request: the `averageUtilization` target is defined as a percentage of the requested value of the resource, so when the target container has no CPU request the HPA cannot compute utilization and instead surfaces a metric error reporting a missing CPU request for the container. In the documented upstream failure mode, an HPA left in this misconfigured error condition is associated with memory growth in the controller-manager process over time, which is the path this article addresses.

## Resolution

Inspect and correct the HorizontalPodAutoscaler configuration so the HPA controller loop is no longer driven into a metric-error condition. The HorizontalPodAutoscaler primitive is served at `autoscaling/v2` (kind `HorizontalPodAutoscaler`, short name `hpa`); list the HPA objects on the cluster to confirm whether any are present and which workloads they target.

```bash
kubectl get hpa --all-namespaces
kubectl describe hpa <hpa-name> -n <namespace>
```

For an HPA that targets CPU utilization, ensure every container in the targeted workload declares a CPU resource request, since the utilization target is evaluated as a percentage of that requested value; an HPA pointed at a workload with no CPU request cannot compute utilization and produces the missing-CPU-request metric error.

```yaml
spec:
  containers:
    - name: app
      resources:
        requests:
          cpu: 200m
```

Where the HorizontalPodAutoscaler is not required, removing it likewise clears the metric-error condition from the in-process HPA controller loop running inside the kube-controller-manager.

## Diagnostic Steps

Confirm the restart pattern on the kube-controller-manager static pod in `kube-system`. A frequently-restarting pod shows an elevated `restartCount` together with a previous-termination block; on the leader-election-loss path the previous termination is recorded with `reason` of `Error`. Read the pod status and its previous-termination details.

```bash
kubectl get pods -n kube-system -l component=kube-controller-manager
kubectl describe pod -n kube-system <kcm-pod-name>
kubectl get pod -n kube-system <kcm-pod-name> \
  -o jsonpath='{.status.containerStatuses[0].lastState.terminated}'
```

Inspect the kube-controller-manager container logs in `kube-system` for the leader-election sequence — the attempts to acquire and renew the lease, followed by the resource-lock retrieval error against `kube-system/kube-controller-manager` that marks a failed renewal.

```bash
kubectl logs -n kube-system <kcm-pod-name> | grep -i leaderelection
kubectl logs -n kube-system <kcm-pod-name> --previous | grep -i "resource lock"
```

Verify the leader-election Lease itself to read the renewal deadline and the current holder. The Lease lives at `kube-system/kube-controller-manager` under `coordination.k8s.io/v1` with a `leaseDurationSeconds` of `15`; a `renewTime` that has stopped advancing for the current holder indicates the process is no longer renewing the lease in time.

```bash
kubectl get lease kube-controller-manager -n kube-system \
  -o jsonpath='{.spec.leaseDurationSeconds}{"\t"}{.spec.holderIdentity}{"\t"}{.spec.renewTime}'
```

Cross-reference the HPA inventory while diagnosing: list the `autoscaling/v2` HorizontalPodAutoscaler objects to determine whether a misconfigured HPA is present, since a cluster with no HorizontalPodAutoscaler objects has no active HPA error loop to drive this condition.

```bash
kubectl get hpa --all-namespaces -o wide
```

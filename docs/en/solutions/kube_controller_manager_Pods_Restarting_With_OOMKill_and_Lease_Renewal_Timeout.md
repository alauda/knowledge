---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

`kube-controller-manager` (KCM) pods on control-plane nodes are restarting repeatedly. The pod list shows a high `restartCount` on every replica, and the pattern for each termination is one of:

- The previous container terminated with `exitCode: 137` (the kernel OOM-killer reaping the process after it exceeded its memory limit), or
- The controller process logs `failed to renew lease kube-system/kube-controller-manager: timed out` followed by `leaderelection lost`, and the process exits voluntarily to let a healthy peer take over.

Both patterns often present on the same cluster over a span of days; the process is hitting its memory ceiling **or** falling too far behind on event processing to keep its lease, sometimes one then the other.

Inspection of the KCM container logs shows a high-frequency error loop inside the HorizontalPodAutoscaler controller:

```text
E0313 08:36:05.528062 1 horizontal.go:275] "Unhandled Error"
  err="failed to compute desired number of replicas based on listed metrics for
  Deployment/<ns>/<deploy>: invalid metrics (2 invalid out of 2), first error is:
  failed to get cpu resource metric value: failed to get cpu utilization:
  missing request for cpu in container <container> of Pod ..."
  logger="UnhandledError"
```

These errors repeat several times per second per affected HPA, indefinitely, for as long as the offending HPA exists.

## Root Cause

The HPA controller is one of many controllers compiled into the KCM process. When it cannot compute a reconciliation cycle — for example, because a Deployment's pod template does not declare `resources.requests.cpu`, so the CPU-utilisation target has no denominator — the controller logs the failure and re-queues the HPA immediately. The re-queue triggers another reconcile attempt, which fails the same way, which re-queues again. The HPA never converges and never backs off.

This has two visible effects on the KCM process:

1. **Memory pressure.** Log volume and queue allocations grow quickly. The Go runtime's heap climbs over time; if the container has a memory limit, the cgroup eventually OOM-kills it (`exitCode: 137`).
2. **Leader-lease timeout.** KCM holds a leader lease and renews it on a short interval. If the process is busy draining a flooded work queue, the renewal goroutine can miss its deadline. The lease expires, the server-side lock is released, and KCM detects the loss, logs `leaderelection lost`, and exits so another replica can take over. After a few cycles of this, the offending replica is stuck in a restart loop.

Neither failure is a bug in KCM per se — it is the HPA controller correctly reporting "I cannot compute anything useful for this HPA" at full speed, and the KCM process correctly shedding its lease when it cannot keep up. The real problem is the broken HPA configuration upstream.

## Resolution

ACP's control-plane components follow standard Kubernetes shapes; `kube-controller-manager` runs unchanged. The fix is at the HPA configuration layer: identify the broken HPAs, correct them, and the KCM error loop stops.

1. **Locate the offending HPA from the KCM logs.** The error message embeds the target deployment's namespace and name. Extract the unique offenders:

   ```bash
   kubectl logs -n kube-system -l component=kube-controller-manager \
     -c kube-controller-manager --tail=5000 \
     | grep 'failed to compute desired number of replicas' \
     | grep -oE 'Deployment/[^ ]+' \
     | sort -u
   ```

   Alternatively, if the cluster routes control-plane logs through a log system, the same query can be run there against the `kube-controller-manager` log stream.

2. **Inspect each HPA and its target.** Common root causes by frequency:

   - The target workload has no `resources.requests.cpu` on at least one container, but the HPA targets CPU utilisation as a percentage of requests. With no denominator there is no utilisation; the HPA permanently errors.
   - The target workload is missing `metrics.k8s.io` data because the metrics-server pod is unhealthy or the workload was scaled to zero. This is rare for steady-state HPAs but common right after a cluster event.
   - The HPA references a custom or external metric that no adapter is serving.

   ```bash
   kubectl get hpa -n <ns> <hpa> -o yaml
   kubectl get deployment -n <ns> <deploy> -o jsonpath='{.spec.template.spec.containers[*].resources}{"\n"}' | jq .
   kubectl get pod -n <ns> -l <selector> -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].name}{"\t"}{.spec.containers[*].resources}{"\n"}{end}'
   ```

3. **Fix the root cause.** The repair depends on which of the above applies:

   - **Missing CPU request.** Add `resources.requests.cpu` to every container in the Deployment's template. A conservative starting point is half the historical average utilisation times one core; tune with Prometheus after the loop stops.
   - **Unhealthy metrics.k8s.io.** Restore metrics-server (check its pod logs, its `APIService` registration, and webhook certificates). The HPA will resume once metrics arrive.
   - **Missing custom-metrics adapter.** Either install the adapter the HPA expects, or edit the HPA to point at a metric that is actually being served.

4. **If the HPA is not actually needed, delete it.** Especially in multi-tenant clusters, historical HPAs left behind on retired workloads are a common source of this exact loop.

   ```bash
   kubectl delete hpa -n <ns> <hpa>
   ```

5. **Give KCM room to recover.** Once the problematic HPA is corrected or removed, the KCM error rate drops to zero. Existing restart loops clear up as soon as each replica survives a full renewal interval without an OOM or lease-timeout. Monitor:

   ```bash
   kubectl get pods -n kube-system -l component=kube-controller-manager -o wide --watch
   ```

   The replicas should stabilise at `restartCount` no longer incrementing. If a replica still churns, either a second broken HPA is feeding the loop, or the restart loop's own back-pressure needs manual reset — delete the most-restarted pod and let the Deployment bring a fresh one up.

6. **Prevent recurrence with admission policy.** The cheapest long-term guard is a policy that rejects HPAs targeting CPU utilisation when the target workload has no CPU request. A ValidatingAdmissionPolicy or a Gatekeeper/Kyverno rule can enforce this at creation time:

   ```yaml
   apiVersion: admissionregistration.k8s.io/v1
   kind: ValidatingAdmissionPolicy
   metadata:
     name: hpa-requires-cpu-request
   spec:
     matchConstraints:
       resourceRules:
         - apiGroups:   ["autoscaling"]
           apiVersions: ["v2"]
           operations:  ["CREATE","UPDATE"]
           resources:   ["horizontalpodautoscalers"]
     validations:
       - expression: |-
           !(has(object.spec.metrics) &&
             object.spec.metrics.exists(m,
               m.type == 'Resource' && m.resource.name == 'cpu' &&
               has(m.resource.target) && m.resource.target.type == 'Utilization'))
         messageExpression: >-
           "HPA targets CPU utilisation; ensure the workload's containers declare
            resources.requests.cpu before applying this HPA"
   ```

   (Pair with a `ValidatingAdmissionPolicyBinding` against the target namespaces. The CEL expression should be tuned to the cluster's actual convention; the point is to catch the specific "utilisation HPA against a request-less workload" shape early.)

## Diagnostic Steps

Count the restart damage so far:

```bash
kubectl get pods -n kube-system -l component=kube-controller-manager \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[*].restartCount}{"\n"}{end}'
```

Three or four in one replica indicates active trouble; hundreds indicates a persistent loop.

Inspect the previous container termination to distinguish OOM from leader-lease loss:

```bash
kubectl get pod -n kube-system <kcm-pod> -o json \
  | jq '.status.containerStatuses[] | select(.name=="kube-controller-manager")
                                   | .lastState.terminated'
```

`exitCode: 137` + `reason: OOMKilled` points at memory pressure. `exitCode: 255` + a message ending in `leaderelection lost` points at lease-renewal timeout. The resolution is the same in both cases — fix the HPA — but the distinction confirms the diagnosis.

Quantify the HPA error rate directly from the controller log:

```bash
kubectl logs -n kube-system -l component=kube-controller-manager \
  -c kube-controller-manager --tail=5000 \
  | grep -c 'failed to compute desired number of replicas'
```

Counts in the hundreds across a few minutes of log is the error loop at full speed. Counts near zero mean the HPA side is already quiet and the KCM damage is residual — wait one or two renewal intervals for the pods to stabilise without further action.

Confirm that metrics.k8s.io is actually serving the CPU numbers the HPA depends on:

```bash
kubectl top pod -n <ns>
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/namespaces/<ns>/pods" | jq '.items[] | {name:.metadata.name, cpu:.containers[].usage.cpu}'
```

If these return empty or error, the metrics-server side is also broken and needs attention before the HPA fix will take full effect.

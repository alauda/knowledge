---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A pod stays in `Pending` state with a scheduling error similar to:

```text
0/6 nodes are available:
  3 Insufficient memory,
  3 node(s) had taint {node-role.kubernetes.io/control-plane:}, that the pod didn't tolerate.
```

`kubectl top node` reports plenty of free memory on the same workers, and the new pod only requests `500Mi`. Yet the scheduler refuses to place it.

## Root Cause

The scheduler does not compare a pod's request to the node's **real-time** memory usage. It compares it to the node's **allocatable** budget minus the **sum of requests** of every pod already admitted. Once that accounting pool is exhausted, the node is full from the scheduler's perspective — even if running pods use far less than they asked for.

This is by design. `.spec.containers[].resources.requests` acts as a reservation: the kubelet guarantees the pod can consume up to that amount without being throttled or OOM-killed relative to lower-priority workloads. Admitting a new pod that would push total requests beyond allocatable would break that guarantee for everyone already on the node.

`kubectl top` reports current utilization through the metrics pipeline. It is the right tool for capacity investigations and the wrong one for reasoning about scheduling — the two numbers are computed from different inputs and will legitimately disagree whenever pods request more than they currently use.

## Resolution

Right-size requests first; add hardware second.

1. **Audit request vs. actual usage** for the high-request pods on the saturated nodes. If a pod reserves `4Gi` but its 7-day P95 working set is `900Mi`, the reservation is wrong — lower it. A modest over-provision factor (typically 1.3× to 1.5× of P95) is a reasonable rule of thumb for stable workloads.

2. **Separate requests from limits intentionally.** Setting `requests == limits` (Guaranteed QoS) consumes the most capacity. Most workloads are better served by `requests` sized for the P95 steady state and `limits` sized for the peak, placing them in Burstable QoS. Only infrastructure components that must never be OOM-killed need the Guaranteed tier.

3. **Use `LimitRange` to catch regressions.** A namespace-level default with reasonable ceilings keeps a single team from accidentally reserving an entire node:

   ```yaml
   apiVersion: v1
   kind: LimitRange
   metadata:
     name: default-requests
     namespace: team-a
   spec:
     limits:
       - type: Container
         default:        { cpu: "500m", memory: "512Mi" }
         defaultRequest: { cpu: "100m", memory: "128Mi" }
         max:            { cpu: "4",    memory: "8Gi"   }
   ```

4. **Scale the cluster only after requests are honest.** Adding worker nodes to cover inflated requests simply relocates the waste. When additional capacity is genuinely required, a HorizontalPodAutoscaler for elastic services and a node autoscaler for the fleet are cheaper than permanently over-provisioning both.

## Diagnostic Steps

Compare allocatable memory to the sum of requests on each node:

```bash
kubectl describe node <node-name> | sed -n '/Allocated resources/,/Events/p'
```

The table at the bottom lists requests/limits per resource and the percentage of allocatable already reserved.

Find the top memory reservers on a suspect node:

```bash
node=<node-name>
kubectl get pods -A -o json \
  --field-selector spec.nodeName=$node \
| jq -r '.items[] | .spec.containers[] as $c
         | [.metadata.namespace, .metadata.name, $c.name,
            ($c.resources.requests.memory // "0")] | @tsv' \
| sort -k4 -h | column -t
```

Compare those numbers with real usage from the metrics pipeline:

```bash
kubectl top pod -A --containers | sort -k5 -h | tail -20
```

Inspect the pending pod's events to confirm the exact predicate that rejected each node:

```bash
kubectl describe pod <pending-pod> -n <ns>
```

If the imbalance is across a single deployment, look for a missing anti-affinity rule that is concentrating replicas on the already-saturated node.

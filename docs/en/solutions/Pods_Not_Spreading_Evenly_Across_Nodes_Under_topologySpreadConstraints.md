---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A workload declares `topologySpreadConstraints` with the intent that its replicas land on different nodes (or zones), but the scheduler still co-locates two or more pods on the same node. The Deployment looks healthy, the pods are `Running`, and yet the actual placement reported by `kubectl get pod -o wide` violates the operator's expectation of one-pod-per-node spread.

## Root Cause

`topologySpreadConstraints` is best-effort by default. Two factors most commonly explain uneven placement:

- **`whenUnsatisfiable: ScheduleAnyway`.** When the scheduler cannot place a pod and still satisfy `maxSkew`, the `ScheduleAnyway` policy lets it bind the pod anyway, prioritising scheduling over spread. Replicas then accumulate on whichever node the scoring step prefers.
- **Missing or inconsistent topology labels.** The constraint pivots on `topologyKey` (for example `kubernetes.io/hostname` or `topology.kubernetes.io/zone`). If the target nodes do not all carry that label — or carry the same value where they should be distinct — the scheduler cannot use the constraint to differentiate them, and the spread degrades to "first available node."

The upstream documentation enumerates other corner cases (rolling updates, scale-down behaviour, taints) that can also cause skew; see the Kubernetes scheduling concepts page on topology spread for the full list.

## Resolution

1. **Audit node labels.** Confirm that every node intended to participate in the spread carries the topology key used in the constraint, and that the values differentiate the nodes the way the workload assumes.

   ```bash
   kubectl get nodes --show-labels
   kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.topology\.kubernetes\.io/zone}{"\n"}{end}'
   ```

   If a node is missing the label, add it before relying on it for spread:

   ```bash
   kubectl label node <node-name> topology.kubernetes.io/zone=zone-a
   ```

2. **Switch the spread policy to `DoNotSchedule`** when even spread is a hard requirement. With `DoNotSchedule`, the scheduler refuses to place a pod that would push `maxSkew` over the limit; the pod stays `Pending` until a satisfying node is available, which is usually the desired signal in a high-availability deployment.

   ```yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: app
   spec:
     replicas: 3
     selector:
       matchLabels:
         app: app
     template:
       metadata:
         labels:
           app: app
       spec:
         topologySpreadConstraints:
           - maxSkew: 1
             topologyKey: kubernetes.io/hostname
             whenUnsatisfiable: DoNotSchedule
             labelSelector:
               matchLabels:
                 app: app
         containers:
           - name: app
             image: myorg/app:1.0
   ```

3. **Combine constraints rather than relying on a single key.** A common pattern is to spread first across zones (`topology.kubernetes.io/zone`) and then across hostnames (`kubernetes.io/hostname`), so that the workload tolerates a zone outage and never doubles up on a single node within a zone.

4. **Validate after rollout.** A successful spread should put each replica on a distinct node (or zone). Verify with:

   ```bash
   kubectl get pod -l app=app -o wide
   ```

   Two replicas on the same node after the deployment finishes rolling means either the constraint is still `ScheduleAnyway` or there are not enough nodes that match the selector to satisfy `maxSkew`.

## Diagnostic Steps

When pods land on the wrong node, capture the scheduler's view of the situation:

```bash
kubectl describe pod <pod-name> | sed -n '/Events/,$p'
```

A `FailedScheduling` event with a message like `1 node(s) didn't match pod topology spread constraints` confirms the constraint is being evaluated and is currently unsatisfiable; that is the expected behaviour under `DoNotSchedule`. If the events show no constraint violation but the pods still co-locate, the topology key is the suspect — re-check labels.

Inspect the running placement against the topology key:

```bash
kubectl get pod -l app=app -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.nodeName}{"\n"}{end}'
kubectl get nodes -L kubernetes.io/hostname,topology.kubernetes.io/zone
```

Compare the per-pod `nodeName` against the per-node label values. A skew of more than `maxSkew` between two domains is the smoking gun for either a missing label or a `ScheduleAnyway` policy that has been quietly tolerating drift.

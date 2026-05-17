---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Drain blocked by a PodDisruptionBudget that cannot be satisfied

## Issue

On Alauda Container Platform (test cluster `jingguo-7gm6m`, Kubernetes v1.34, where only the `policy/v1` API of `poddisruptionbudgets.policy` is served), a node drain that relies on the Eviction subresource can stall indefinitely when a workload has a PodDisruptionBudget whose constraints cannot be satisfied by the current replica set. The Eviction subresource is documented to reject such requests with an HTTP 4xx response indicating that the disruption budget would be violated, so any drain loop that uses eviction will retry the same pod on every cycle without progressing.

The canonical mis-configuration that triggers this is a PDB whose `selector` matches a workload running with a single replica while `minAvailable` is set to `1`, which produces `ALLOWED DISRUPTIONS=0` and forbids every voluntary disruption on that workload.

## Root Cause

A PodDisruptionBudget governs voluntary disruptions for the set of pods matched by its `selector`. The spec exposes `minAvailable` and `maxUnavailable` as mutually exclusive knobs; whenever the current replica count cannot absorb a disruption without dropping below `minAvailable` (or above `maxUnavailable`), the API server denies the eviction request rather than admitting it. Drain workflows that go through the Eviction subresource therefore loop on the same pod for as long as the budget remains unsatisfiable.

## Resolution

Path 1 — drain the node without going through the Eviction subresource. Passing `--disable-eviction` causes the drain to issue `DELETE Pod` calls directly, which bypasses any PDB attached to the targeted pods:

```bash
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data --disable-eviction
```

Path 2 — relax the PDB for the duration of the maintenance window by patching `spec.minAvailable` to `0` (or, equivalently, raising `maxUnavailable` to permit the disruption), then restoring the original value once the drain has completed:

```bash
kubectl patch pdb <name> -n <ns> --type=merge \
  -p '{"spec":{"minAvailable":0}}'
```

Path 3 — if you would rather rebuild the PDB than patch it in place, take a backup of the object, delete it, perform the drain, and re-create it from the saved manifest after stripping cluster-assigned metadata:

```bash
kubectl get pdb <name> -n <ns> -o yaml > pdb-<name>.yaml
# edit pdb-<name>.yaml and remove metadata.resourceVersion, metadata.uid, and status
kubectl delete pdb <name> -n <ns>
# perform the drain / maintenance
kubectl apply -f pdb-<name>.yaml
```

When authoring or re-creating the PDB manifest on this cluster, use the served group/version:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: <name>
  namespace: <ns>
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: <label>
```

## Diagnostic Steps

Confirm the symptom by attempting an eviction against the suspect pod and observing the HTTP 429 response carrying `Cannot evict pod as it would violate the pod's disruption budget`; a drain that retries the same pod on every iteration without converging is the same signal at the workflow level.

Inspect the offending budget to confirm that the configured floor leaves no headroom for disruption — for example, a `minAvailable: 1` budget whose `selector` matches a single running replica reports `ALLOWED DISRUPTIONS=0`, which is the canonical mis-configuration for this failure mode:

```bash
kubectl get pdb -A
kubectl describe pdb <name> -n <ns>
```

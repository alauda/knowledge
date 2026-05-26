---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
---

# HPA scale-down behavior does not select which pods are deleted on ACP

## Issue

On Alauda Container Platform running Kubernetes v1.34.5, an operator looking at `HorizontalPodAutoscaler` (built-in `autoscaling/v2` API, exposed via `kubectl explain hpa.spec.behavior.scaleDown`) wants to control which specific replicas of a workload are removed when the HPA decreases the replica count — for example, to keep the oldest pods and evict the newest ones, or vice versa. The HPA's `spec.scaleTargetRef` only references the target resource by `kind` and `name`, and is described as being used to actually change the replica count; pods are not addressed directly by the HPA resource [ev:c1_a][ev:c1_b].

## Root Cause

The HPA is responsible for computing a new desired replica count on the target workload, not for picking which individual pods to delete. The downstream workload controller — the ReplicaSet controller, a built-in `apps/v1` controller (`replicasets` / `rs`) — is what actually deletes pods to reach the new replica count. On this cluster that controller is enabled inside `kube-controller-manager` (image `registry.alauda.cn:60080/tkestack/kube-controller-manager:v1.34.5`), which is started with `--controllers=*,bootstrapsigner,tokencleaner` so the replicaset controller is active alongside the other built-in controllers [ev:c1_a][ev:c1_b].

The `spec.behavior.scaleDown` block on the HPA is a separate concern: it shapes the *rate and magnitude* of replica-count changes, not the choice of victim pod. Its schema contains `policies[]` (each entry has required `type`, `value`, and `periodSeconds`), `selectPolicy`, `stabilizationWindowSeconds`, and `tolerance` — and notably no pod-selector or pod-ordering field [ev:c2].

## Resolution

There is no field on the `HorizontalPodAutoscaler` resource — including under `spec.behavior.scaleDown` — that chooses oldest versus newest pods, or otherwise picks which replica is deleted during a scale-down. The HPA API exposes only the velocity and stabilization knobs above; none of them addresses pod identity [ev:c2].

Use `spec.behavior.scaleDown` to tune *how fast* and *how much* replicas are reduced, with the standard `autoscaling/v2` shape [ev:c3]:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: example
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: example
  minReplicas: 2
  maxReplicas: 10
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      selectPolicy: Max
      policies:
        - type: Percent
          value: 50
          periodSeconds: 60
        - type: Pods
          value: 4
          periodSeconds: 60
```

Field semantics from the CRD schema: each entry in `policies[]` has a required `type` (`Pods` or `Percent`), a required `value` (>0), and a required `periodSeconds` in the range 1–1800. `selectPolicy` defaults to `Max` when unset (the most permissive of the listed policies is applied). `stabilizationWindowSeconds` for scale-down defaults to `300` seconds (range 0–3600) [ev:c3].

To influence which pods survive a scale-down, work at the workload-controller layer rather than on the HPA. Because pod deletion during scale-down is performed by the ReplicaSet controller in `kube-controller-manager`, the upstream Kubernetes scale-down ordering applies on ACP unchanged; the HPA resource itself has no knob for it [ev:c1_a][ev:c1_b].

## Diagnostic Steps

Confirm that the HPA resource on this cluster is the standard built-in `autoscaling/v2` API and that no pod-selector field is present under `spec.behavior.scaleDown` [ev:c2]:

```bash
kubectl explain hpa.spec.behavior.scaleDown
kubectl explain hpa.spec.behavior.scaleDown.policies
```

The output lists `policies[]` (with `periodSeconds`, `type`, `value`), `selectPolicy`, and `stabilizationWindowSeconds` — and nothing that names or selects individual pods [ev:c2][ev:c3].

Verify that the ReplicaSet controller (the component that actually deletes pods on scale-down) is enabled in `kube-controller-manager` on the control plane [ev:c1_a]:

```bash
kubectl -n kube-system get pod -l component=kube-controller-manager \
  -o jsonpath='{range .items[*]}{.spec.containers[0].image}{"\n"}{.spec.containers[0].command}{"\n"}{end}'
kubectl api-resources --api-group=apps | grep -i replicaset
```

A healthy control plane reports the `kube-controller-manager:v1.34.5` image started with `--controllers=*,bootstrapsigner,tokencleaner`, and `replicasets` (`rs`, `apps/v1`, namespaced, kind `ReplicaSet`) is present in the API resource list [ev:c1_a].

Inspect an HPA's target reference to confirm that it points at a workload by kind and name (not at pods) [ev:c1_b]:

```bash
kubectl get hpa <name> -o jsonpath='{.spec.scaleTargetRef}{"\n"}'
```

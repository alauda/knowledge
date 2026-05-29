---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500514
---

# Configure Argo CD Operator container resources via its CSV on ACP

## Issue

On Alauda Container Platform the Argo CD operator is shipped as the `argocd-operator` OperatorBundle (CSV `argocd-operator.v4.2.0` in namespace `argocd`, image `build-harbor.alauda.cn/3rdparty/argoprojlabs/argocd-operator:v4.2.0`). Operator-Lifecycle-Manager renders the operator pod from a Deployment template embedded inside the ClusterServiceVersion at `.spec.install.spec.deployments[<deployment-name>].spec.template.spec.containers[<container-name>].resources`; on this cluster the embedded deployment name is `argocd-operator-controller-manager` and the container name is `manager`.

When the controller-manager container's `resources.requests` / `resources.limits` are too low for the actual workload, the operator pod is subject to the standard upstream kubelet OOM-kill and scheduler-eviction paths on kube v1.34.5 — container-resource pressure on the operator's `manager` container can manifest as OOMKilled / pod restart on the same `core/v1.Container.resources` field.

## Resolution

Raise the container's `resources` block directly in the CSV. OLM reconciles edits to `.spec.install.spec.deployments[].spec.template.spec.containers[].resources` back onto the owned live Deployment, and Kubernetes rolls the operator pod automatically — no manual `kubectl rollout restart` or pod delete is required.

A sample sizing that lifts the controller-manager off the under-provisioned defaults is `limits.cpu=500m`, `limits.memory=500Mi`, `requests.cpu=300m`, `requests.memory=300Mi` on the `manager` container — applied as-is to the `core/v1.Container.resources` field on ACP kube v1.34.5. The sample sizing is a starting point; tune based on the cluster's actual Application count / repo-server load.

Discover the CSV by the OLM-written label key. OLM stamps every CSV it materialises with `operators.coreos.com/<package-name>.<install-namespace>=` (empty value); for the ACP `argocd-operator` package this resolves to `operators.coreos.com/argocd-operator.argocd=`:

```bash
kubectl get csv -l operators.coreos.com/argocd-operator.argocd= -A -o name
```

Then edit the CSV in place and update the `manager` container's `resources` block under `.spec.install.spec.deployments[argocd-operator-controller-manager].spec.template.spec.containers[manager].resources`:

```bash
kubectl edit csv argocd-operator.v4.2.0 -n argocd
```

The resulting block (sample sizing):

```yaml
spec:
  install:
    spec:
      deployments:
        - name: argocd-operator-controller-manager
          spec:
            template:
              spec:
                containers:
                  - name: manager
                    resources:
                      limits:
                        cpu: 500m
                        memory: 500Mi
                      requests:
                        cpu: 300m
                        memory: 300Mi
```

Once the CSV write is saved, OLM reconciles the updated container template into the live `Deployment/argocd-operator-controller-manager` (which carries `ownerReferences` back to CSV `argocd-operator.v4.2.0`), the apps/v1 controller rolls the pod, and the new operator pod comes up with the elevated `resources` values.

## Diagnostic Steps

After the CSV edit, confirm the live Deployment is OLM-owned and that its `manager` container's `resources` block matches the CSV's embedded values — match implies OLM has reconciled the new sizing onto the owned Deployment; divergence implies the reconcile has not yet landed or an external mutator is in the loop. (Run this as a post-edit verification — before the edit, the CSV and live Deployment both carry the install-time defaults and will match trivially.):

```bash
kubectl -n argocd get deploy argocd-operator-controller-manager \
  -o jsonpath='{.metadata.ownerReferences}'

kubectl -n argocd get deploy argocd-operator-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="manager")].resources}'

kubectl get csv argocd-operator.v4.2.0 -n argocd \
  -o jsonpath='{.spec.install.spec.deployments[?(@.name=="argocd-operator-controller-manager")].spec.template.spec.containers[?(@.name=="manager")].resources}'
```

After the CSV edit, watch the rollout pick up the new container template and the operator pod re-create on its own:

```bash
kubectl -n argocd rollout status deploy/argocd-operator-controller-manager
kubectl -n argocd get pod -l control-plane=argocd-operator
```

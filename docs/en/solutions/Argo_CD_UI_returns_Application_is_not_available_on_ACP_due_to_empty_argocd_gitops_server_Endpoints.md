---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500200
---

# Argo CD UI returns Application is not available on ACP due to empty argocd-gitops-server Endpoints

## Issue

On Alauda Container Platform v4.3.13 with `chart-argocd-installer` v4.2.0 and the `argocd-operator.v4.2.0` CSV (argocd-gitops-server container image `build-harbor.alauda.cn/3rdparty/argoproj/argocd:v3.1.9-2`), in-cluster requests for the Argo CD UI can fail to reach a backend even while the argocd-gitops-server pods are reported as Running. The argocd-operator reconciles an in-cluster ClusterIP Service `argocd-gitops-server` in the `argocd` namespace whose selector matches the argocd-gitops-server Deployment pods; any caller that resolves the UI through this Service is routed via the Service's Endpoints object, so when the Endpoints subset is empty or stale there is no ready pod IP for the Service to forward to.

## Root Cause

In the failing state, the `argocd-gitops-server` Service object exists in namespace `argocd` but its associated Endpoints object carries no `addresses` in `.subsets[]`. The healthy shape of this Endpoints row carries the two ready argocd-gitops-server pod IPs on port 8080 (matching the Service's `targetPort=8080` for the `http` / `https` named ports); when those addresses are absent the upstream endpoint-controller (label `endpoints.kubernetes.io/managed-by=endpoint-controller`) has nothing to expose for the Service, so callers resolving the Service receive no backend pod IP.

## Resolution

Delete the `argocd-gitops-server` Service in the `argocd` namespace:

```bash
kubectl delete svc argocd-gitops-server -n argocd
```

The Service object is owned by the ArgoCD CR `argocd-gitops` (apiVersion `argoproj.io/v1beta1`) in namespace `argocd` via `ownerReferences` with `controller=true`. The argocd-operator (CSV `argocd-operator.v4.2.0`) watches this CR and recreates the owned `argocd-gitops-server` Service as part of its reconcile loop, restoring the same Service shape and selector that existed before the delete.

Once the Service is back, the kube-controller-manager endpoints controller repopulates the Endpoints object from the matching ready argocd-gitops-server pods in namespace `argocd`. The Service selector `app.kubernetes.io/name=argocd-gitops-server` matches the two argocd-gitops-server Deployment pods (`argocd-gitops-server-6779c7944d-*`), so their pod IPs reappear in `.subsets[0].addresses` and the `argocd-gitops-server` Endpoints object repopulates after the operator recreates the Service.

For a non-default custom ArgoCD instance — for example a separate ArgoCD CR in a different namespace — substitute the Service name and namespace in the delete command with the actual Service and namespace of that instance. On ACP the server Service name follows the CR-name pattern `<argocd-cr-name>-server`, so a CR named `argocd-gitops` yields the Service `argocd-gitops-server`, and the namespace defaults to `argocd` for the platform install.

## Diagnostic Steps

Confirm the argocd-gitops-server pods are Running in the `argocd` namespace; the healthy state shows two pods `1/1 Running` from the `argocd-gitops-server-*` ReplicaSet:

```bash
kubectl get pods -n argocd -l app.kubernetes.io/name=argocd-gitops-server
```

List the Service and the Endpoints object together in the `argocd` namespace; on the `argocd-gitops-server` endpoints row, an empty or `<none>` `ADDRESSES` column is the signal that the Service is not selecting any ready pods, while a healthy row carries the ready pod IPs on port 8080:

```bash
kubectl get svc,ep -n argocd
```

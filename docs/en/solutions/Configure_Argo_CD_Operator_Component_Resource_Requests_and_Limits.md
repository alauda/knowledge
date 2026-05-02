---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Configure Argo CD Operator Component Resource Requests and Limits
## Issue

Argo CD operator components (controller manager, repo server, application controller) on Alauda Container Platform may be restarted by the kubelet when their default container memory or CPU limits are too low for the workload size. Operators wanting to right-size these components ask how to set CPU/memory requests and limits on the operator-managed pods so that they do not starve other tenants on the cluster yet are not OOMKilled themselves.

## Root Cause

Argo CD on ACP is delivered through an Operator Lifecycle Manager (OLM) ClusterServiceVersion (CSV). The deployment specs that OLM applies for each operator component live inside the CSV at `.spec.install.spec.deployments[*].spec.template.spec.containers[*].resources`. Editing the workload Deployment directly is not durable: OLM reconciles the Deployment back to whatever the CSV declares within seconds, undoing any in-place patch.

## Resolution

Edit the CSV to update the `resources` block of the target container. OLM will then redeploy the affected component pods with the new requests and limits.

1. Locate the GitOps operator CSV across all namespaces (the operator may be installed cluster-wide):

   ```bash
   GITOPS_CSV=$(kubectl get csv -A -o name \
     -l 'operators.coreos.com/argocd-operator=' )
   GITOPS_NS=$(kubectl get csv -A --no-headers \
     -l 'operators.coreos.com/argocd-operator=' \
     | awk '{print $1}')
   ```

   Adjust the label selector to whatever subscription label the install used (`kubectl get csv -A --show-labels` will show it).

2. Edit the CSV:

   ```bash
   kubectl -n "$GITOPS_NS" edit csv "$GITOPS_CSV"
   ```

3. Inside the editor, locate the deployment block for the component you want to size — for example the controller manager:

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
                     requests:
                       cpu: 300m
                       memory: 300Mi
                     limits:
                       cpu: 500m
                       memory: 500Mi
   ```

4. Save and exit. OLM detects the CSV change, regenerates the underlying `Deployment`, and rolls the pod with the new resource block. Verify:

   ```bash
   kubectl -n "$GITOPS_NS" get deploy argocd-operator-controller-manager -o yaml \
     | grep -A6 resources
   kubectl -n "$GITOPS_NS" get pods -l app.kubernetes.io/name=argocd-operator-controller-manager
   ```

The same pattern applies to other Argo CD components managed by the operator (repo server, application controller, ApplicationSet controller, redis): find the corresponding `deployments[*].name` block in the CSV and add or edit its `resources` field.

## Diagnostic Steps

If the new limits do not stick or the pods keep OOMKilling:

- Confirm the edit actually persisted: `kubectl -n "$GITOPS_NS" get csv "$GITOPS_CSV" -o yaml | grep -A8 resources`. If empty, OLM may have overwritten the change because the install plan re-applied an older CSV; check `InstallPlan` history in the same namespace.
- Inspect pod restart cause: `kubectl -n <argocd-ns> describe pod <pod>` and look for `OOMKilled` in `Last State`. If memory is still the bottleneck, raise the limit further and edit again.
- For application-controller specifically, also tune the sharding (`ARGOCD_CONTROLLER_REPLICAS` / `--app-resync`) — adding memory alone will not help if a single shard is asked to reconcile thousands of Applications.

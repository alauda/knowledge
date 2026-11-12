---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Argo CD Application sync not permitted, repository Not Found, InvalidSpecError, or empty GitOps project list on ACP

## Issue

Argo CD on ACP is reconciled by `argocd-operator` from an `ArgoCD` resource (`argoproj.io/v1beta1`), and the GitOps pages of the platform work on top of it. One of these is reported:

- An Application fails with `SyncError Failed sync attempt to <revision>: one or more synchronization tasks are not valid resource <group>:<Kind> is not permitted in project <project>`, for example `resource operator.alauda.io:ResourceSyncer is not permitted in project <project>`. Adding a cluster resource allow list in the Argo CD UI does not stick (the project page then shows "The cluster resource allow list is empty"), and `kubectl edit appproject <project> -n argocd` reverts after saving.
- On **GitOps Applications > Create** with the source **Platform Integration**, the required **Integration Project Name** dropdown has nothing to select, and the page reports an error.
- A repository shows CONNECTION STATUS `Failed`, and removing it returns `Unable to disconnect repository: Not Found`, while every Argo CD and GitOps Pod is `Running`.
- An Application applied as YAML does not appear in Argo CD. Recreating it in the UI fails with `Unable to create application: application spec for <application> is invalid: InvalidSpecError: application repo <registry>/helm-charts is not permitted in project '<project>'`.

Related articles: "Argo CD components fail: Dex image pull when air-gapped, Redis timeouts in an ambient mesh, or dev shm full on ACP".

## Root Cause

### Cause 1: the AppProject is synchronized from a platform project and its cluster resource allow list is reset

An AppProject with the same name as a platform project is synchronized automatically from the platform project by gitops-controller. It carries the label `cpaas.io/project: <project>` and the annotation `gitops.app.cpaas.io/last-applied-configuration`. On every reconcile, the gitops-controller log prints `Reconcile project "/<project>"`, "The sourceRepos and destinations after merged", and `"Updating project" project="<project>"`, and applies a patch that contains `"spec":{"clusterResourceWhitelist":null}`. UI saves (the `PUT .../api/v1/projects/<project>` request returns `200 OK`), `kubectl edit`, and `kubectl patch` all revert. This is by design: it prevents a project from creating cluster-scoped resources and escalating privileges. A platform-synchronized AppProject does not support changes to its cluster resource allow list. Projects created by hand in Argo CD accept changes, and the `default` AppProject allows group `'*'` kind `'*'`, destinations `'*'`, and sourceRepos `'*'`.

### Cause 2: the API component behind the GitOps pages is not running

The GitOps application creation form loads, but the **Integration Project Name** list stays empty because the API component behind the GitOps pages has not started, for example because of insufficient resources. Once its resources are adjusted, it starts and the page works again.

### Cause 3: the business cluster that the repository targets has no Argo CD CRDs

All GitOps components on the cluster that runs Argo CD are `Running` (`argocd-gitops-application-controller`, `argocd-gitops-repo-server`, `argocd-gitops-server`, `argocd-gitops-redis-ha-*`, `gitops-api`, `gitops-controller`, `argocd-operator-controller-manager`). The business cluster that the repository and its applications target has no Argo CD CRD, because the Argo CD operator is not installed there. Installing the Argo CD operator on the business cluster creates the CRDs.

### Cause 4: the Application `repoURL` lacks the `oci://` prefix that the project uses

The Application exists in the cluster, but Argo CD rejects its spec, so it does not appear in the UI. The AppProject lists the Helm chart repository as `oci://<registry>/helm-charts`, while the Application uses `repoURL: <registry>/helm-charts` without the scheme. Because the address in the Application differs from the one registered for the project, Argo CD reports the repository as not permitted, even when the project's **SOURCE REPOSITORIES** is `*`.

## Resolution

### Cause 1: the AppProject is synchronized from a platform project and its cluster resource allow list is reset

1. Create a project by hand in the Argo CD UI, with a name that is not a platform project name, and add to its **CLUSTER RESOURCE ALLOW LIST** only the cluster-scoped kinds that the Application needs (for the example above: group `operator.alauda.io`, kind `ResourceSyncer`). The allow list of a manually created project is saved and kept.

2. Move the Application to that project. Moving it to the `default` AppProject also makes the sync work, as a quick workaround.

   > **Warning:** Moving an Application to another AppProject changes which destinations, source repositories, and resource kinds it may manage; `default` is permissive. Precondition: confirm that the target project allows only what this Application needs. Rollback: patch `spec.project` back to the original value.

   ```bash
   kubectl -n argocd patch applications.argoproj.io <application> --type=merge \
     -p='{"spec":{"project":"<own-project-or-default>"}}'
   ```

### Cause 2: the API component behind the GitOps pages is not running

1. Find the Pod and the reason it does not run (Diagnostic Steps, step 3).

2. If it is `Pending` with `Insufficient cpu` or `Insufficient memory`, free capacity on the nodes or lower its requests; if it is `OOMKilled`, raise its memory limit. Change the resources in the object that owns the workload. Direct edits to Deployments and StatefulSets that the operator manages are reverted. For the Argo CD components, the upstream `ArgoCD` resource has a `resources` field per component (for example `spec.controller.resources`, `spec.repo.resources`, `spec.server.resources`); for the operator itself, see "Configure Argo CD Operator container resources via its CSV on ACP".

   > **Warning:** Changing the resources rolls the component's Pods; the GitOps pages are unavailable until the new Pod is Ready. Precondition: only when the API Pod is not Running because of resources and the nodes have capacity for the new requests. Record the current values. Rollback: set the previous values again.

   ```bash
   kubectl -n <argocd-namespace> edit argocd <argocd-name>
   ```

3. The component starts, and the **Integration Project Name** dropdown is populated again.

### Cause 3: the business cluster that the repository targets has no Argo CD CRDs

On the business cluster that the applications deploy to, install the Argo CD operator from OperatorHub, as on the cluster that runs Argo CD. Then confirm that the `argoproj.io` CRDs exist (Diagnostic Steps, step 4) and check the repository connection again in the Argo CD UI.

### Cause 4: the Application `repoURL` lacks the `oci://` prefix that the project uses

Set `spec.source.repoURL` of the Application to exactly the address registered in the project, including `oci://`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: <application>
  namespace: <argocd-namespace>
spec:
  project: <project>
  source:
    repoURL: oci://<registry>/helm-charts
    chart: <chart>
    targetRevision: <chart-version>
  destination:
    name: <destination-cluster>
    namespace: <destination-namespace>
```

```bash
kubectl apply -f <application>.yaml
kubectl -n <argocd-namespace> get applications.argoproj.io <application> -o jsonpath='{.status.conditions}{"\n"}'
```

The `InvalidSpecError` condition is gone and the Application appears in the UI.

## Diagnostic Steps

1. Identify the instance and the component state:

   ```bash
   kubectl get argocd -A
   kubectl -n <argocd-namespace> get pods
   ```

2. For a sync that is not permitted, check whether the AppProject is platform-synchronized and whether gitops-controller resets it:

   ```bash
   kubectl -n argocd get appproject <project> -o jsonpath='{.spec.clusterResourceWhitelist}{"\n"}{.metadata.labels.cpaas\.io/project}{"\n"}'
   kubectl -n argocd get appproject <project> -o yaml | grep -c 'gitops.app.cpaas.io/last-applied-configuration'
   kubectl get pods -A | grep gitops-controller
   kubectl -n <gitops-controller-namespace> logs <gitops-controller-pod> --tail=500 | grep -E 'Reconcile project|Updating project|clusterResourceWhitelist'
   ```

   A project named after a platform project, with the `cpaas.io/project` label and the `last-applied-configuration` annotation, an empty whitelist that returns after each edit, and `"Updating project"` lines with `"clusterResourceWhitelist":null`, is Cause 1.

3. For an empty **Integration Project Name** list, find the API Pod and why it is not running:

   ```bash
   kubectl get pods -A | grep -E 'argocd-api|gitops-api'
   kubectl -n <namespace> describe pod <api-pod> | grep -iE 'insufficient|oomkilled|reason'
   ```

   A `Pending` Pod with `Insufficient cpu` or `Insufficient memory`, or a container that ends `OOMKilled`, is Cause 2.

4. For `Unable to disconnect repository: Not Found`, check the Argo CD CRDs on the business cluster that the applications target:

   ```bash
   kubectl get crd | grep argoproj.io
   ```

   No output on the business cluster is Cause 3.

5. For an Application that exists but does not appear in the UI, compare its `repoURL` with the project and the registered repositories:

   ```bash
   kubectl -n <argocd-namespace> get applications.argoproj.io <application> -o jsonpath='{.spec.source.repoURL}{"\n"}{.status.conditions}{"\n"}'
   kubectl -n <argocd-namespace> get appproject <project> -o jsonpath='{.spec.sourceRepos}{"\n"}'
   kubectl -n <argocd-namespace> get secret -l argocd.argoproj.io/secret-type=repository -o jsonpath='{range .items[*]}{.data.url}{"\n"}{end}' | while read u; do echo "$u" | base64 -d; echo; done
   ```

   `InvalidSpecError ... is not permitted in project` with a `repoURL` that differs from the registered repository only by the `oci://` prefix is Cause 4.

---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "3.12"
  - "4.3"
---

# devops-controller or devops-apiserver does not start or fails requests on ACP

## Issue

The DevOps API components in `cpaas-system` on the `global` cluster are down or fail requests, and pipeline pages that depend on them stay empty or stale. One of these signatures is shown:

- The `devops-controller` Pods are not Ready. The controller log repeats `Failed to watch v1alpha1.CodeRepository`, and the integrated GitLab answers `Internal server error` on `GET /api/v4/projects?membership=true&per_page=100`.
- On a standby (backup) data center, `devops-apiserver` and `devops-controller` are both down, and the controller log says it cannot get a ConfigMap because it has no permission.
- `devops-apiserver` crash-loops with `panic: unable to create REST storage for a resource due to context deadline exceeded, will die`, after normal INFO lines such as `cacher (*devops.JenkinsBinding): initialized`.
- Updating a pipeline fails with HTTP 500 and a message like `Get "https://[::1]:443/apis/devops.alauda.io/v1alpha1/clusterpipelinetasktemplates/<name>?resourceVersion=0": x509: certificate has expired or is not yet valid`, while the platform certificate pages show nothing relevant as expired.

A GitLab integration whose projects API returns 500 while these components are healthy is covered in "GitLab toolchain integration fails: token-gitlab not found, Internal error, projects API 500, or an extra bot project". An empty task list with these components Ready is covered in "Pipeline task list is empty, tasks are missing, or TektonHub cannot be viewed on ACP".

## Root Cause

### Cause 1: `Failed to watch v1alpha1.CodeRepository` because the integrated GitLab returns Internal server error

`devops-controller` watches `CodeRepository` objects and calls each integrated GitLab to list projects. When one GitLab answers `Internal server error` on `/api/v4/projects`, the watch fails and the controller Pods do not become Ready. The broken dependency is that GitLab integration; deleting the abnormal integration lets `devops-controller` start again. Restarting the controller does not clear it.

### Cause 2: the DevOps API ServiceAccount lacks permission to read ConfigMaps

On a standby data center the ServiceAccount used by the DevOps API components had fewer permissions than on the primary. The controller cannot get the ConfigMap it needs, and both `devops-apiserver` and `devops-controller` stay down. Granting the ServiceAccount the missing permission lets both recover.

### Cause 3: etcd does not answer in time while `devops-apiserver` builds its storage

At startup `devops-apiserver` connects to etcd and creates REST storage for its resources. If storage creation does not finish in time, the process panics from `registry.RESTInPeace` and the Pod restarts. On ACP 3.12 this was caused by an abnormal control-plane node; after the workload moved off that node the panics stopped. The first lines of the log are ordinary INFO messages, so the panic is visible only in the full log of a failed start.

### Cause 4: the DevOps API uses a serving certificate that has expired

The 500 response comes from a call to the aggregated `devops.alauda.io/v1alpha1` API. When no certificate in the platform views matches the expiry time in the message, the most likely explanation is that the devops component on the `global` cluster is still presenting a serving certificate that has expired. The exact mechanism is not confirmed; the recommended action is to restart `devops-apiserver` and `devops-controller`.

## Resolution

### Cause 1: `Failed to watch v1alpha1.CodeRepository` because the integrated GitLab returns Internal server error

1. Confirm the log signature. A controller that is down for an image pull is not this cause.

   ```bash
   kubectl -n cpaas-system get pods | grep devops-controller
   kubectl -n cpaas-system logs deploy/devops-controller --tail=80 | grep -E 'CodeRepository|Internal server error'
   ```

2. Identify the GitLab integration whose host appears in that log, and check that its projects API really fails:

   ```bash
   curl -sk -H "PRIVATE-TOKEN: <token>" "https://<gitlab-host>/api/v4/projects?membership=true&per_page=100" | head -c 300
   ```

3. Delete that integration from the console page where it was created (the toolchain integration list), after recording its settings.

   > **Warning:** Deleting the GitLab integration removes that code-host binding; repositories, triggers, and pipelines that use it stop resolving until it is created again. Only when `devops-controller` is not Ready, the log shows `Failed to watch v1alpha1.CodeRepository`, and this GitLab returns `Internal server error` on `/api/v4/projects`. Rollback: recreate the integration with the recorded settings once the GitLab projects API returns a project list again. Do not delete a healthy integration.

4. Watch the controller recover:

   ```bash
   kubectl -n cpaas-system rollout status deploy/devops-controller
   ```

   If the Pods stay down and the log no longer mentions GitLab, follow the new log.

### Cause 2: the DevOps API ServiceAccount lacks permission to read ConfigMaps

1. Find the ServiceAccount and test the permission named in the log:

   ```bash
   kubectl -n cpaas-system get deploy devops-controller -o jsonpath='{.spec.template.spec.serviceAccountName}{"\n"}'
   kubectl auth can-i get configmaps -n cpaas-system --as=system:serviceaccount:cpaas-system:<devops-sa>
   kubectl get clusterrolebinding -o wide | grep <devops-sa>
   ```

   `no` for that ServiceAccount is this cause. Compare its bindings with the same ServiceAccount on the primary data center.

2. Restore the binding the primary cluster has for this ServiceAccount. If that binding is not available, binding the ServiceAccount to `cluster-admin` also lets the components recover.

   > **Warning:** A `cluster-admin` binding gives every Pod that runs as this ServiceAccount full control of the cluster. Only when the log shows the ConfigMap permission error and `kubectl auth can-i` returns `no`, and only when the primary's exact binding cannot be copied. Rollback: `kubectl delete clusterrolebinding <binding-name>`.

   ```bash
   kubectl create clusterrolebinding <binding-name> --clusterrole=cluster-admin --serviceaccount=cpaas-system:<devops-sa>
   kubectl -n cpaas-system rollout restart deploy/devops-controller
   ```

3. `devops-apiserver` and `devops-controller` should become Ready and the permission error should leave the log.

### Cause 3: etcd does not answer in time while `devops-apiserver` builds its storage

1. Read the log of the failed start and check the control plane:

   ```bash
   kubectl -n cpaas-system logs deploy/devops-apiserver --previous | grep -E 'panic|deadline'
   kubectl get nodes -l node-role.kubernetes.io/control-plane=
   kubectl -n kube-system get pods -l component=etcd -o wide
   ```

   The panic together with a NotReady control-plane node or an etcd member that is not Running is this cause.

2. Restarting `devops-apiserver` does not help while etcd is slow. Repair the control-plane node, or move off it, following the cluster's control-plane maintenance procedure. `devops-apiserver` should then start without the panic; if the panic returns, the control-plane problem is still open.

### Cause 4: the DevOps API uses a serving certificate that has expired

1. Only when the 500 body contains `x509: certificate has expired or is not yet valid` for a `devops.alauda.io` path. Check the APIService and how long the Pods have run:

   ```bash
   kubectl get apiservice | grep devops.alauda.io
   kubectl -n cpaas-system get pods -o wide | grep -E 'devops-apiserver|devops-controller'
   kubectl -n cpaas-system logs deploy/devops-apiserver --tail=100 | grep -i x509
   ```

2. Restart both components on the `global` cluster.

   > **Warning:** The DevOps API is unavailable until the new Pods are Ready; pipeline pages and API calls fail in that window. Rollback: none; a restart changes no configuration.

   ```bash
   kubectl -n cpaas-system rollout restart deploy/devops-apiserver deploy/devops-controller
   kubectl -n cpaas-system rollout status deploy/devops-apiserver
   kubectl -n cpaas-system rollout status deploy/devops-controller
   ```

3. Save the pipeline again. If the x509 error returns after the restart, the certificate in its Secret is itself expired; collect the `devops-apiserver` log and `kubectl get apiservice <devops-apiservice> -o yaml` for the product team.

## Diagnostic Steps

```bash
kubectl -n cpaas-system get deploy,pods | grep -E 'devops-controller|devops-apiserver'
kubectl -n cpaas-system logs deploy/devops-controller --tail=80
kubectl -n cpaas-system logs deploy/devops-apiserver --previous --tail=200
```

| What you see | Cause |
| --- | --- |
| `Failed to watch v1alpha1.CodeRepository` plus GitLab `Internal server error` on `/api/v4/projects` | 1 |
| Controller log: cannot get a ConfigMap, no permission; `kubectl auth can-i` returns `no` | 2 |
| `devops-apiserver` panics with `unable to create REST storage ... context deadline exceeded` | 3 |
| Pipeline update returns 500 with `x509: certificate has expired or is not yet valid` on a `devops.alauda.io` path | 4 |
| GitLab webhook delivery fails while `devops-controller` is Ready | Not this article |

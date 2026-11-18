---
kind:
  - Troubleshooting
products:
  - Alauda Service Mesh
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
  - "4.4"
---

# Service Mesh delete is stuck on a failed to get cluster webhook denial or on pods that still have sidecar injection

## Issue

A service mesh, or its gateway, will not uninstall and the console stays on deleting. One of these is seen:

- The business cluster that the mesh belonged to no longer exists. Deleting the `servicemesh` object with `kubectl` is denied:

  ```text
  admission webhook "mservicemesh.alauda.io" denied the request: failed to get cluster "<cluster-name>": clusters.clusterregistry.k8s.io "<cluster-name>" not found
  ```

  The `servicemesh` can still show `Deployed`, and removing its `finalizers` is denied with the same message.
- The ASM delete does not complete, and the `asm-operator` log reports that pods outside the mesh workloads being removed still have sidecar injection enabled. After that is fixed, `istio-operator` still does not go away.

`servicemesh` objects live on the `global` cluster as `asm.alauda.io/v1alpha1` in `cpaas-system`, and the object name is the business cluster name. An unused mesh whose ASM process consumes a lot of CPU is removed through this same uninstall path.

Related articles: "Leftover Service Mesh v1 recreates istio-system against Mesh v2 or Istio Secret certificate alerts remain on ACP" covers leftovers after an uninstall.

## Root Cause

### Cause 1: the `mservicemesh.alauda.io` webhook cannot find the deleted cluster

The mutating webhook configuration `servicemesh-v1alpha1-mutation` (webhook `mservicemesh.alauda.io`, served by `asm-controller`) looks up the business cluster record for every change to a `servicemesh`. When that record is gone, the lookup fails and the webhook denies the delete and any finalizer patch, so the object can never be removed while the webhook is in place.

### Cause 2: other workloads still have sidecar injection enabled

ASM is deleted only after sidecar injection is disabled on every pod that still has it. A workload outside the mesh, for example `ingress-nginx`, can carry the sidecar injection annotation on its pod template; `asm-operator` then waits indefinitely. After injection is turned off, a leftover `istio-operator` object can still hold the delete and has to be force-removed.

## Resolution

### Cause 1: the `mservicemesh.alauda.io` webhook cannot find the deleted cluster

Run these steps on the `global` cluster.

1. If the cluster record still exists, this cause does not apply; remove the meshed workloads and delete normally:

   ```bash
   kubectl get clusters.clusterregistry.k8s.io <cluster-name>
   kubectl get servicemesh -n cpaas-system <cluster-name> -o yaml > /tmp/servicemesh-<cluster-name>.bak.yaml
   kubectl -n cpaas-system delete servicemesh <cluster-name> --wait
   ```

2. When the record is `not found`, back up the webhook configuration and the mesh objects, and inspect the webhook:

   ```bash
   kubectl get mutatingwebhookconfiguration servicemesh-v1alpha1-mutation -o yaml > /tmp/servicemesh-v1alpha1-mutation.bak.yaml
   kubectl get servicemesh -A -o yaml > /tmp/servicemesh-all.bak.yaml
   kubectl get mutatingwebhookconfiguration servicemesh-v1alpha1-mutation \
     -o jsonpath='{range .webhooks[*]}{.name}{" "}{.clientConfig.service.name}{" "}{.failurePolicy}{"\n"}{end}'
   ```

3. Take the webhook out of the path, using one of the two methods below.

   > **Warning:** While the webhook is bypassed, ServiceMesh changes on this `global` cluster are not validated by it. Only when the delete fails because the cluster record is missing and the backup files exist; use a maintenance window. Rollback: `kubectl apply -f /tmp/servicemesh-v1alpha1-mutation.bak.yaml` (remove `metadata.resourceVersion`, `uid`, `managedFields`, and `status` from the file if apply complains).

   - Method A: set `failurePolicy` of the `asm-controller` webhook to `Ignore`. This resolved a delete for a mesh whose cluster no longer existed. Kubernetes applies `failurePolicy` only when the webhook call itself fails; if the delete still returns the `failed to get cluster` denial after this change, use Method B.

     ```bash
     kubectl patch mutatingwebhookconfiguration servicemesh-v1alpha1-mutation --type=json \
       -p '[{"op":"replace","path":"/webhooks/0/failurePolicy","value":"Ignore"}]'
     ```

     Use the index of the `mservicemesh.alauda.io` entry from the listing in step 2 if it is not `0`.

   - Method B: delete the webhook configuration.

     ```bash
     kubectl delete mutatingwebhookconfiguration servicemesh-v1alpha1-mutation
     ```

4. Delete the mesh object.

   > **Warning:** The ServiceMesh object and the gateways and injection it owns are removed. Because the cluster record is gone, the object cannot be recreated until that record exists again; treat this delete as irreversible.

   ```bash
   kubectl get servicemesh -A
   kubectl delete servicemesh -n cpaas-system <cluster-name>
   ```

5. Restore the webhook immediately:

   ```bash
   kubectl apply -f /tmp/servicemesh-v1alpha1-mutation.bak.yaml
   kubectl get mutatingwebhookconfiguration servicemesh-v1alpha1-mutation -o jsonpath='{.webhooks[*].failurePolicy}{"\n"}'
   ```

   A gateway that was stuck in deleting leaves that state once the webhook no longer denies the request.

### Cause 2: other workloads still have sidecar injection enabled

1. Read the `asm-operator` log and find the workloads it names:

   ```bash
   kubectl get pods -A | grep asm-operator
   kubectl -n istio-system logs <asm-operator-pod> --tail=200 | grep -i -E 'sidecar|inject'
   kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{" "}{.spec.containers[*].name}{"\n"}{end}' | grep istio-proxy
   kubectl -n <namespace> get deploy <workload> -o jsonpath='{.spec.template.metadata.annotations}{"\n"}'
   ```

2. Set the Istio injection annotation `sidecar.istio.io/inject` to `"false"` on each named workload. Use `daemonset` instead of `deployment` where the workload is a DaemonSet.

   > **Warning:** The workload rolls and its new pods start without `istio-proxy`; ingress traffic through `ingress-nginx` can drop briefly. Only for workloads the `asm-operator` log names, and only when the mesh is really being removed. Rollback: set the annotation back to `"true"` (re-injection works only while the mesh is still installed).

   ```bash
   kubectl -n <namespace> patch deployment <workload> --type=merge \
     -p '{"spec":{"template":{"metadata":{"annotations":{"sidecar.istio.io/inject":"false"}}}}}'
   kubectl -n <namespace> rollout status deployment <workload>
   ```

3. Retry the ASM delete. If it stops on `istio-operator`, find which object is left:

   ```bash
   kubectl get ns | grep istio-operator
   kubectl get pods -A | grep istio-operator
   kubectl get istiooperator -A
   kubectl get istiooperator -n <namespace> <name> -o jsonpath='{.metadata.deletionTimestamp}{" "}{.metadata.finalizers}{"\n"}'
   ```

4. Force-remove the remaining object.

   > **Warning:** A force delete skips the controller's cleanup, so resources it would have removed can remain and need manual cleanup. Only after injection is disabled on the named workloads and the remaining `istio-operator` object has a `deletionTimestamp` or is stuck in `Terminating`. Rollback: none; keep the backup as a reference.

   ```bash
   kubectl get istiooperator -n <namespace> <name> -o yaml > /tmp/istiooperator.bak.yaml
   # stuck IstioOperator resource
   kubectl patch istiooperator -n <namespace> <name> --type=merge -p '{"metadata":{"finalizers":null}}'
   # Pod stuck in Terminating
   kubectl delete pod -n <namespace> <istio-operator-pod> --grace-period=0 --force
   ```

   Run only the line that matches the object left. The ASM delete should then complete. If the `servicemesh` on `global` is then denied with `failed to get cluster`, continue with Cause 1.

## Diagnostic Steps

1. On `global`, check the mesh object, the cluster record, and the webhook:

   ```bash
   kubectl -n cpaas-system get servicemesh
   kubectl get clusters.clusterregistry.k8s.io
   kubectl get mutatingwebhookconfiguration servicemesh-v1alpha1-mutation
   ```

2. On the business cluster, check what blocks `asm-operator`:

   ```bash
   kubectl -n istio-system logs <asm-operator-pod> --tail=200 | grep -i -E 'sidecar|inject'
   kubectl get ns,istiooperator -A | grep -i istio-operator
   ```

| What you see | Cause |
| --- | --- |
| Delete denied by `mservicemesh.alauda.io` with `failed to get cluster` and the cluster record `not found` | 1 |
| ASM delete hangs, `asm-operator` log names pods that are still injected (for example `ingress-nginx`), or `istio-operator` stays | 2 |
| `istio-system` keeps returning, or Istio Secret certificate alerts after Mesh v1 is gone | The leftover Mesh v1 article |

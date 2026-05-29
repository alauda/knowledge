---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500502
---

# OLM catalog-operator slow to start CatalogSource registry pod due to namespace ResourceQuota on ACP

## Issue

On Alauda Container Platform (`marketplace` chart `v4.3.7`), the OLM `catalog-operator` Deployment runs in the `cpaas-system` namespace and reconciles each `CatalogSource` of `sourceType: grpc` with a `spec.image` by ensuring a managed registry server pod (named `<catalogsource>-<random-suffix>`) exists for that CatalogSource. The ACP platform CatalogSources (`platform`, `system`, `custom` in `cpaas-system`) instead use `sourceType: grpc` with `spec.address=olm-registry-<lib>.cpaas-system.svc:50051` and no `spec.image`, so they do not have a managed registry pod and cannot exhibit this failure mode; the symptom described here applies to user-created `spec.image`-style `CatalogSource` objects placed into a namespace that has a `ResourceQuota` enforcing `requests.memory`.

When such a user-created `CatalogSource` lands in a namespace whose `ResourceQuota` would be exceeded by the registry pod's `requests.memory`, the registry pod admission is rejected by the kube-apiserver and `catalog-operator` cannot finish reconciling that CatalogSource. To external observers, `catalog-operator` then appears slow to start the corresponding registry pods because the queued work is not progressing past the blocked item, since the controller's work queue retries the same blocked CatalogSource item ahead of subsequent items rather than fully in parallel.

## Root Cause

The `catalog-operator` work queue processes some of its `CatalogSource` sync items in serial rather than fully in parallel, so a single CatalogSource whose registry pod cannot be admitted will back up later sync work on the same worker. The blocking signal is upstream Kubernetes admission: the core/v1 `ResourceQuota` admission plugin rejects a pod create with the message `pods "<pod>" is forbidden: exceeded quota: <quota>, requested: requests.memory=<N>, used: requests.memory=<U>, limited: requests.memory=<L>` when `used + requested > limited` for that quota's `requests.memory` scope — this rejection is produced by the kube-apiserver, not by OLM, so it is identical on any conformant Kubernetes cluster including ACP.

When `catalog-operator` cannot dial the gRPC registry service for a CatalogSource that is already in the listed set, it emits a `queueinformer_operator.go` sync error of the form `failed to list bundles: rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial tcp <ip>:50051: connect: connection refused"` — the `queueinformer_operator.go:<line>] sync ... failed: ...` emitter wrapper follows the standard upstream catalog-operator format on ACP (line-number drift only between source builds), and the dial-failure content shape mirrors upstream because the image is the unchanged operator-framework/olm build repackaged by Alauda.

## Resolution

Two equivalent options unblock the rejected registry pod admission so that `catalog-operator` can finish reconciling the affected `CatalogSource` and the serial work-queue progresses past the previously blocked item.

**Option A — raise the namespace `ResourceQuota` limit.** Increase the limited value of the reported resource (typically `requests.memory`, matching the scope named in the admission rejection) on the namespace's `ResourceQuota` so that `used + requested <= limited`; this allows the registry server pod admission to succeed on retry:

```bash
kubectl -n <catalogsource-namespace> edit resourcequota <quota-name>
```

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: <quota-name>
  namespace: <catalogsource-namespace>
spec:
  hard:
    requests.memory: <new-larger-value>
```

**Option B — remove the `ResourceQuota` for the namespace.** When the quota is not required for the namespace, deleting the `ResourceQuota` object eliminates the kube-apiserver admission gate for that namespace and allows the registry server pod to be created:

```bash
kubectl -n <catalogsource-namespace> delete resourcequota <quota-name>
```

After either change, the next reconcile of the affected `CatalogSource` admits the registry server pod and the work queue progresses past the previously blocked item.

## Diagnostic Steps

Read the `catalog-operator` pod logs to surface any `queueinformer_operator.go` sync errors that may wrap registry-dial failures for already-listed `CatalogSource` objects; the `ResourceQuota` admission rejection that explains why the new registry pod cannot be created is best inspected from the kube-apiserver admission response (for example, via a `kubectl create` dry-run against the same namespace) rather than mined from `catalog-operator` logs:

```bash
kubectl -n cpaas-system get pods -l app=catalog-operator
kubectl -n cpaas-system logs deploy/catalog-operator
```

Look for `queueinformer_operator.go` sync errors of the dial-failure shape `failed to list bundles: rpc error: code = Unavailable ... dial tcp <ip>:50051: connect: connection refused` against already-listed CatalogSources, which indicates the registry service for those sources is not reachable while the queue retries the blocked item.

Look as well for the kube-apiserver admission rejection `pods "<pod>" is forbidden: exceeded quota: <quota>, requested: requests.memory=<N>, used: requests.memory=<U>, limited: requests.memory=<L>` — this line names the offending quota, the pod that would have been created, and the `used` / `limited` values, which directly identify the namespace and `ResourceQuota` to adjust under Resolution.

Identify the affected user-created `spec.image`-style `CatalogSource` objects (the platform CatalogSources in `cpaas-system` are `spec.address`-style and are not subject to this failure mode) and inspect the `ResourceQuota` in the namespace where the registry pod is being created:

```bash
kubectl get catalogsource -A \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"\t"}{.spec.sourceType}{"\t"}{.spec.image}{"\n"}{end}'
kubectl -n <catalogsource-namespace> get resourcequota -o yaml
```

The `ResourceQuota` `spec.hard` block lists the limited scopes (for example `requests.memory`, `requests.cpu`, `limits.memory`, `limits.cpu`, `pods`); cross-reference the scope named in the admission rejection with the `spec.hard` entry that needs to be raised or removed.

---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

When OLM tries to install or upgrade an operator, the InstallPlan stays stuck and the operator never reconciles. The InstallPlan status shows the bundle-unpack job never finished:

```yaml
status:
  conditions:
    - message: bundle contents have not yet been persisted to installplan status
      reason: BundleNotUnpacked
      status: "True"
      type: BundleLookupNotPersisted
    - lastTransitionTime: "2026-03-30T14:52:10Z"
      message: unpack job not completed
      reason: JobIncomplete
      status: "True"
      type: BundleLookupPending
    - lastTransitionTime: "2026-03-30T15:02:12Z"
      message: Job was active longer than specified deadline
      reason: DeadlineExceeded
      status: "True"
      type: BundleLookupFailed
  bundleLookups:
    - identifier: example-operator.v4.8.1
```

The `bundleLookup` job in the marketplace namespace either crashed, exceeded its `activeDeadlineSeconds`, or the registry pod backing the catalog is unhealthy and the unpack pod can never reach it. The operator's CSV / Subscription continues to look "in progress" indefinitely; nothing else gets installed or upgraded.

## Root Cause

OLM materialises an operator bundle through a transient `Job` in the marketplace namespace. The job's pod pulls the bundle image from the catalog registry, parses the manifests, and writes the result back to the InstallPlan via the OLM controller. If the pod can't pull the image, can't reach the registry pod, runs out of CPU and never completes its work, or the registry pod is itself in `CrashLoopBackOff`, the bundle is never persisted into InstallPlan status.

Because OLM caps the unpack job with `activeDeadlineSeconds` (default ten minutes), a slow or failing pod ends up `DeadlineExceeded` — but the resulting `Failed` job sticks around. Subsequent retries find the failed job already present and refuse to re-create it (Job names are derived deterministically from the bundle digest). The InstallPlan therefore stays wedged in `BundleLookupFailed` until something cleans the failed job up.

## Resolution

Back up the relevant Subscription, InstallPlan and existing CSV before mutating anything — the operator's data plane is independent of these and is not affected by deleting them, but the safety net is cheap:

```bash
NS=cpaas-storage      # the namespace running the affected operator
SUB=example-operator
CSV=example-operator.v4.8.0
IP=install-abc123     # the failing InstallPlan name

kubectl -n "$NS" get subscription "$SUB"        -o yaml > "${SUB}-backup.yaml"
kubectl -n "$NS" get installplan  "$IP"         -o yaml > "${IP}-backup.yaml"
kubectl -n "$NS" get clusterserviceversion "$CSV" -o yaml > "${CSV}-backup.yaml"
```

### Step 1 — clear the failed unpack job

The failed bundle-unpack job lives in the marketplace namespace alongside the catalog source. Find it by InstallPlan ownership and delete it; OLM will recreate a fresh job on its next reconciliation:

```bash
MP_NS=cpaas-marketplace   # whichever namespace hosts the catalog source
kubectl -n "$MP_NS" get job -l olm.bundle-unpack-ref="$IP" -o name
kubectl -n "$MP_NS" delete job -l olm.bundle-unpack-ref="$IP"
```

If no jobs match the label (older OLM versions don't set it), narrow by recent failures and the bundle identifier:

```bash
kubectl -n "$MP_NS" get jobs -o wide \
  | awk '$3 == "0/1"'                        # never-completed jobs
```

After deletion, watch the InstallPlan progress. A healthy retry shows a fresh `bundleLookups` job whose pod completes within a few seconds:

```bash
kubectl -n "$NS" get installplan "$IP" -o yaml \
  | yq '.status.conditions[] | {type,reason,message}'
kubectl -n "$MP_NS" get pods -l job-name -w
```

### Step 2 — if the retry job fails the same way

The unpack job depends on a healthy catalog source. Confirm the registry pod backing the relevant CatalogSource is `Running` and serving:

```bash
kubectl -n "$MP_NS" get catalogsource
kubectl -n "$MP_NS" get pods -l olm.catalogSource
kubectl -n "$MP_NS" logs <catalog-registry-pod> --tail=200
```

Common root causes that show up in the registry pod logs:

- **Image pull failure** — the catalog image is not reachable from the cluster (proxy, air-gap, expired pull secret). Fix the registry first; OLM will recover automatically.
- **gRPC errors / `connection refused`** — the registry container has crashed or restarted. Delete the pod so the CatalogSource controller recreates it.
- **Out-of-memory** — registries with many bundles need more memory than the default 100Mi. Bump via `spec.grpcPodConfig.memoryRequests` on the CatalogSource.

### Step 3 — last resort: re-create the Subscription

If the InstallPlan continues to wedge after both job and registry are healthy, drop and re-create the Subscription. This is non-destructive: the running operator pods, CRs, and data plane are untouched because they live in the operator's own namespace and are owned by the CSV, not by the Subscription.

```bash
kubectl -n "$NS" delete subscription "$SUB"
kubectl apply -f "${SUB}-backup.yaml"
```

OLM will create a fresh InstallPlan, a fresh bundle-unpack job, and progress past the previous failure. The operator's existing CRs (workloads, storage clusters, application instances) continue to reconcile against the original CSV until the new one rolls out cleanly.

## Diagnostic Steps

To get the full picture of why the unpack pod failed, look at the pod (not just the job) inside the marketplace namespace:

```bash
JOB=$(kubectl -n "$MP_NS" get job -l olm.bundle-unpack-ref="$IP" -o name)
kubectl -n "$MP_NS" describe "$JOB"
kubectl -n "$MP_NS" logs job/${JOB##job/} --all-containers --tail=200
```

Inspect the unpack pod's image pull and exit reason:

```bash
kubectl -n "$MP_NS" get pods -l job-name="${JOB##job/}" -o yaml \
  | yq '.items[].status'
```

`ImagePullBackOff` on the bundle image points at registry / pull-secret problems, not OLM. `OOMKilled` on the unpack container means the bundle is large enough to need more memory — uncommon but possible for catalogs with many CRDs.

If the operator is part of the platform's bundled catalog and other operators in the same catalog also fail, the catalog itself is the problem; restart the catalog source registry pod:

```bash
kubectl -n "$MP_NS" delete pod -l olm.catalogSource=<your-catalog>
```

For deeper visibility into OLM's own state machine, the operator-lifecycle-manager controller logs spell out which condition gates each transition:

```bash
OLM_NS=cpaas-operators
kubectl -n "$OLM_NS" logs deploy/olm-operator --tail=500 \
  | grep -i "$IP"
```

A sequence of `bundle unpacker job ... still pending`, `marking InstallPlan as Failed`, then `creating new bundle unpack job` shows the controller doing the right thing once Step 1 cleared the wedged job.

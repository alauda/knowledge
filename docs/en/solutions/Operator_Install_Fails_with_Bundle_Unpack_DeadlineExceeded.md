---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Operator Install Fails with Bundle Unpack DeadlineExceeded
## Issue

An operator subscription on an OLM-backed cluster will not progress. The `Subscription` reports an `InstallPlanFailed` condition with a message similar to:

```text
bundle unpacking failed.
Reason: DeadlineExceeded, and Message: Job was active longer than specified deadline
```

No subsequent `CSV` is rolled out, and the user-facing extend surface shows the operator stuck in `Failed`. The same symptom appears whether the cluster is brand-new and pulling its first operator, mid-upgrade, or operating in an air-gapped network where the catalog mirror is the only image source.

## Root Cause

OLM unpacks operator bundles by scheduling a short-lived Job in the catalog namespace (typically the marketplace namespace where catalog sources live). The Job runs a small extractor against the bundle image and writes the manifest into a ConfigMap that the InstallPlan then consumes. The Job is created with conservative defaults:

```yaml
activeDeadlineSeconds: 600   # 10 minutes
backoffLimit: 3
```

If the Job cannot finish within ten minutes — or fails three times in a row — Kubernetes marks it `DeadlineExceeded` and OLM surfaces that on the Subscription. The dominant root causes, in roughly the order of frequency observed in the field:

- **Image pull failures.** The bundle image, the catalog index image, or both are unreachable. In an air-gapped cluster this often manifests as `Source image rejected: A signature was required, but no signature exists` because the local mirror is missing the cosign / sigstore manifests for the image.
- **Slow registry.** The mirror or upstream registry serves the layers but slower than the 10-minute window allows.
- **Stuck Job pod.** A node-local issue (CNI not ready, DNS unresolved, image-pull secret missing) leaves the unpack pod in `ImagePullBackOff` until the deadline elapses.

A platform fix (`operatorframework.io/bundle-unpack-min-retry-interval` on the OperatorGroup) does land an automatic retry once the underlying issue is gone, but it does **not** address the actual unpack failure. Retrying a pull that has no path to the image will fail forever.

## Resolution

### Find the real failure first

The DeadlineExceeded message is a symptom; the unpack-pod events almost always show the actual failure. Investigate before deleting anything.

```bash
# The Subscription that flagged InstallPlanFailed
kubectl -n <operator-ns> get sub <name> \
  -o jsonpath='{.status.conditions}' | jq .

# The catalog namespace where unpack jobs run
NS=cluster-marketplace   # or your platform's catalog namespace
kubectl -n $NS get jobs --sort-by=.status.startTime
kubectl -n $NS get pods -l job-name=<unpack-job-name>
kubectl -n $NS describe pod <unpack-pod>
kubectl -n $NS logs <unpack-pod> --all-containers --tail=200
```

The `describe` events block will say one of:

- `Failed to pull image ...` — image pull problem (mirror, secret, signature);
- `back-off restarting failed container` — the extractor itself is crashing on a malformed bundle;
- nothing useful, but the pod sat `ContainerCreating` for ten minutes — node / CNI problem on whichever node the Job landed on.

Fix the actual cause before recycling the Job. Refreshing the unpack will not change the outcome if the root cause is permanent.

### Air-gapped pull rejection

When the events read `Source image rejected: A signature was required, but no signature exists`, the local mirror is enforcing image signatures but the mirrored bundle does not have a signature in the local registry. Either:

- mirror the cosign signature alongside the image (preferred — keep signature enforcement on);
- scope the signature-policy file so the catalog namespace is exempt; or
- temporarily relax `policy.json` for that registry path until the signature is mirrored.

Restart the unpack Job after the policy is corrected; it will pick up the new image immediately.

### Refresh the unpack Job

Once the underlying pull/network issue is resolved, recycle the unpack Job and ConfigMap so OLM re-attempts the bundle. Use the namespace-scoped commands below; do not bulk-delete every Job in the catalog namespace.

```bash
NS=cluster-marketplace
NAME=<bundle-unpack-job-name>          # from `kubectl -n $NS get jobs`
kubectl -n $NS delete job $NAME
kubectl -n $NS delete configmap $NAME  # same name as the job
```

OLM detects the missing artefacts on the next reconcile and re-creates the Job. Watch the new Job to its `Complete` condition:

```bash
kubectl -n $NS get jobs -w
```

### When the InstallPlan is irrecoverable

If the bundle has been corrected but the original InstallPlan still references the broken artefacts, delete it so a fresh one is generated. **Validate first** that the InstallPlan only references the operator under repair — InstallPlans can carry multiple CSVs in a transitive resolution, and deleting one mid-flight can break unrelated workloads.

```bash
kubectl -n <operator-ns> get installplan
kubectl -n <operator-ns> get installplan <ip-name> -o yaml | grep -A1 clusterServiceVersionNames

# Only delete after confirming scope:
kubectl -n <operator-ns> delete installplan <ip-name>
```

For a clean re-install, also remove the failed Subscription and CSV so the next reconcile starts from scratch:

```bash
kubectl -n <operator-ns> delete sub <name>
kubectl -n <operator-ns> delete csv <name>
```

Re-create the Subscription via the platform's extend surface; OLM regenerates the InstallPlan and the unpack Job.

### Auto-retry annotation

For clusters where transient catalog-network problems are expected, set the auto-retry annotation on the OperatorGroup so a future single-shot failure does not require manual cleanup:

```yaml
metadata:
  annotations:
    operatorframework.io/bundle-unpack-min-retry-interval: "5m"
```

This only changes the *retry cadence* — it does not turn a permanent failure into success.

## Diagnostic Steps

A small triage sequence to isolate the root cause:

1. **Confirm DeadlineExceeded is the actual symptom**, not just a stale condition:

   ```bash
   kubectl -n <operator-ns> get sub <name> \
     -o jsonpath='{.status.conditions[?(@.type=="InstallPlanFailed")].message}{"\n"}'
   ```

2. **Locate the unpack Job and inspect events**:

   ```bash
   kubectl -n cluster-marketplace get jobs --sort-by=.status.startTime | tail -n 5
   kubectl -n cluster-marketplace get events --sort-by=.lastTimestamp | tail -n 30
   ```

3. **Test the bundle image pull from a debug pod on the same nodes** the unpack lands on:

   ```bash
   kubectl run pull-test --rm -it --restart=Never \
     --image=<your-bundle-image> -- sh -c "echo ok"
   ```

   If this also fails, the cluster has a registry / network / signature problem unrelated to OLM.

4. **Check pod-pull duration** — even if the image eventually pulls, anything slower than ~5 minutes is at risk of hitting the 10-minute deadline on top of extractor work:

   ```bash
   kubectl -n cluster-marketplace get pod <unpack-pod> \
     -o jsonpath='{.status.containerStatuses[*].state}{"\n"}'
   ```

5. **Catalog source health** — if the catalog itself is unhealthy, every operator under it will exhibit the same DeadlineExceeded:

   ```bash
   kubectl -n cluster-marketplace get catalogsources -o wide
   kubectl -n cluster-marketplace describe catalogsource <name>
   ```

---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Migrating Security Profiles Operator from namespace-scoped 0.8.6 to cluster-scoped 0.9.0
## Overview

The Security Profiles Operator (SPO) is the upstream `kubernetes-sigs/security-profiles-operator` project that delivers `Seccomp` and `SELinux` profiles as first-class Kubernetes objects (`SeccompProfile`, `SelinuxProfile`, `ProfileBinding`). Versions up to and including `0.8.6` ran the operator in a namespace-scoped configuration: the operator and its CRDs only handled profiles inside the namespace where it was installed.

`0.9.0` switches to a cluster-scoped configuration. The operator now reconciles profiles cluster-wide; the CRDs and their existing instances change shape because the profile resources are no longer scoped to a single namespace. The transition cannot be performed by a simple in-place operator upgrade — the existing namespace-scoped CRDs must be uninstalled and replaced, which is a destructive change for any object stored against the old CRDs.

This article describes a safe, ordered migration from `0.8.6` to `0.9.0`. Treat the procedure as a single change window: the cluster has no SPO between steps 4 and 6, so any pod that depends on `ProfileBinding` for its security profile must tolerate the gap.

## Resolution

### 1. Pre-migration checks

Before any destructive step, capture the current state:

```bash
# Confirm running version and namespace scope
kubectl -n <spo-namespace> get deploy security-profiles-operator -o yaml \
  | grep -E 'image:|namespace:'

# Catalogue every profile and binding currently in use
kubectl -n <spo-namespace> get seccompprofile,selinuxprofile,profilebinding \
  -o yaml > spo-state-pre-migration.yaml

# Confirm no in-flight reconciles
kubectl -n <spo-namespace> get pod
```

Save `spo-state-pre-migration.yaml` outside the cluster — it is the only record of the existing profile content once the namespace-scoped CRDs are deleted.

### 2. Back up profiles, bindings, and operator config

The cluster-scoped install will accept the same `Seccomp` and `SELinux` profile contents — the change is in scope, not in shape — so a per-resource backup keyed by name is sufficient.

```bash
# Per-resource YAML, sufficient for restore
mkdir -p backups/spo
for kind in seccompprofile selinuxprofile profilebinding rawselinuxprofile; do
  kubectl -n <spo-namespace> get $kind -o yaml > backups/spo/${kind}.yaml || true
done

# Capture the operator's own configuration if customised (config CR, leader-election ConfigMap, RBAC overrides, etc.)
kubectl -n <spo-namespace> get spod,configmap,role,rolebinding,clusterrole,clusterrolebinding \
  -l 'app=security-profiles-operator' -o yaml > backups/spo/operator-config.yaml
```

### 3. Drain workloads from the old profile bindings

Profile bindings on `0.8.6` mutate pods on creation. Once the bindings are removed, new pods will start without those profiles. Either:

- Pause the workloads that depend on those bindings until step 6 completes, or
- Tolerate that new pods between step 4 and step 6 will run with the cluster-default profile (typically `runtime/default`).

Document which workloads fall in which bucket before continuing.

### 4. Remove the namespace-scoped operator and CRDs

Delete the operator deployment and the CRDs in this order:

```bash
# Operator workload first — stops new reconciles
kubectl -n <spo-namespace> delete deploy security-profiles-operator
kubectl -n <spo-namespace> delete spod --all

# Then the CR instances
kubectl -n <spo-namespace> delete profilebinding --all
kubectl -n <spo-namespace> delete seccompprofile --all
kubectl -n <spo-namespace> delete selinuxprofile --all
kubectl -n <spo-namespace> delete rawselinuxprofile --all 2>/dev/null || true

# Finally the CRDs themselves
kubectl delete crd \
  seccompprofiles.security-profiles-operator.x-k8s.io \
  selinuxprofiles.security-profiles-operator.x-k8s.io \
  profilebindings.security-profiles-operator.x-k8s.io \
  rawselinuxprofiles.security-profiles-operator.x-k8s.io \
  spods.security-profiles-operator.x-k8s.io 2>/dev/null || true
```

If a CRD deletion stalls in `Terminating`, look for finalizers on remaining CR instances and remove them with `kubectl patch ... --type=merge -p '{"metadata":{"finalizers":[]}}'`.

Confirm the namespace is now clean of SPO resources:

```bash
kubectl api-resources | grep security-profiles-operator   # empty
kubectl -n <spo-namespace> get all
```

### 5. Install the cluster-scoped 0.9.0 operator

Install via the platform's operator catalog. The `0.9.0` channel runs the operator from a dedicated namespace but watches all namespaces:

```yaml
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: security-profiles-operator
  namespace: security-profiles-operator
spec:
  channel: release-0.9
  name: security-profiles-operator
  source: <catalog-source>
  sourceNamespace: <catalog-source-namespace>
```

Apply and confirm the operator pod is Running and the new CRDs are registered:

```bash
kubectl apply -f spo-subscription.yaml
kubectl -n security-profiles-operator get pod
kubectl api-resources | grep security-profiles-operator
```

The expected CRDs after `0.9.0`:

- `seccompprofiles.security-profiles-operator.x-k8s.io` (cluster-scoped)
- `selinuxprofiles.security-profiles-operator.x-k8s.io` (cluster-scoped)
- `profilebindings.security-profiles-operator.x-k8s.io` (still namespaced — bindings are per-namespace by design)
- `spod.security-profiles-operator.x-k8s.io` (cluster-scoped operator config)

### 6. Restore profiles cluster-scoped

Edit the backup files to remove the `metadata.namespace` field from `SeccompProfile` and `SelinuxProfile` objects (they are now cluster-scoped) and update `ProfileBinding` references to point at the cluster-scoped profile name. Then re-apply:

```bash
# Strip namespace from cluster-scoped resources
yq eval 'del(.items[].metadata.namespace)' -i \
  backups/spo/seccompprofile.yaml backups/spo/selinuxprofile.yaml

kubectl apply -f backups/spo/seccompprofile.yaml
kubectl apply -f backups/spo/selinuxprofile.yaml
kubectl apply -f backups/spo/profilebinding.yaml
```

### 7. Update workload references

Workloads previously referencing a profile by namespaced path (`localhostProfile: <ns>/<name>.json`) must be updated to the new on-disk path that the cluster-scoped operator publishes. The operator places profiles at `/var/lib/kubelet/seccomp/operator/<name>.json` (without a namespace prefix), and exposes the resolved path via the `SeccompProfile.status.localhostProfile` field. Read the field on each profile and update the matching workloads:

```bash
kubectl get seccompprofile <name> -o jsonpath='{.status.localhostProfile}'
```

Patch each pod template that referenced the old path, then roll the workload to pick up the new path.

### 8. Verify

For every restored binding, confirm a freshly-created pod is admitted with the expected profile:

```bash
kubectl -n <workload-ns> get pod <pod> -o jsonpath='{.spec.securityContext.seccompProfile}'
kubectl -n <workload-ns> get pod <pod> -o jsonpath='{.spec.securityContext.seLinuxOptions}'
```

A populated value matches what the binding promised. If the field is empty, the binding's selector did not match — re-check namespace labels and pod labels against the binding's `spec.selector`.

## Diagnostic Steps

1. Confirm the operator version actually running:

   ```bash
   kubectl -n security-profiles-operator get deploy \
     security-profiles-operator -o jsonpath='{.spec.template.spec.containers[0].image}'
   ```

2. Check the operator log for reconcile failures:

   ```bash
   kubectl -n security-profiles-operator logs deploy/security-profiles-operator --tail=300
   ```

3. Verify each profile is published on the kubelet's seccomp directory on every node. Run from a privileged debug pod with `chroot /host`:

   ```bash
   ls /var/lib/kubelet/seccomp/operator/
   ```

4. If a workload that used to be admitted is now rejected by the runtime with `setting up seccomp ... no such file or directory`, the kubelet has not yet observed the new profile — wait for the operator's DaemonSet to reach the affected node, or drain and re-add the node to force re-publication.

5. Roll back path: if the migration must be aborted mid-window, re-install `0.8.6` from the saved `Subscription`, re-apply `spo-state-pre-migration.yaml`, and roll the affected workloads. The cluster-scoped CRDs from `0.9.0` must be deleted before `0.8.6` can re-install its namespaced ones.

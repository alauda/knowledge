---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
---

# Cluster import stuck with the alb module Failed: grpcroutes CRD status.storedVersions v1 must appear in spec.versions on ACP

## Issue

Importing an existing Kubernetes cluster (for example a managed cloud cluster such as Alibaba Cloud ACK) into ACP 4.0.11 never finishes and stays at the import step. On the `global` cluster, the cluster's `alb` module is `Failed`, while other modules such as `cert-manager`, `acp-business`, `marketplace`, `auth-manager`, `base` and `sentry` are `Running`.

On the imported cluster, the `alauda-alb2` chart release keeps failing with phase `DeployFailed` and this message:

```text
failed to install chart acp/chart-alauda-alb2-<version>, err: failed to install chart for release "alauda-alb2":
failed to install CRD: failed to apply CustomResourceDefinition "/grpcroutes.gateway.networking.k8s.io":
CustomResourceDefinition.apiextensions.k8s.io "grpcroutes.gateway.networking.k8s.io" is invalid:
status.storedVersions[0]: Invalid value: "v1": must appear in spec.versions
```

The release shows `Validate` = `True` (`ChartDownloaded`), `Sync` = `False` (`Failed`) and `Health` = `Unknown`, and a Warning `ChartSynced` event repeats thousands of times.

## Root Cause

The target cluster already had a `grpcroutes.gateway.networking.k8s.io` CRD before it was imported, installed by something other than the platform, for example an earlier Gateway API installation. Objects of that CRD have been stored as version `v1`, so `v1` is recorded in the CRD's `status.storedVersions`.

The ALB chart installs its own definition of the same CRD, and that definition does not list `v1` in `spec.versions`. The Kubernetes API server rejects any CRD update that would drop a version still listed in `status.storedVersions`, so applying the chart's CRD fails. The `alauda-alb2` release cannot be installed, the `alb` module stays `Failed`, and the import never reaches the ready state.

## Resolution

1. On the imported cluster, confirm the conflict and list any GRPCRoute objects that would be lost:

   ```bash
   kubectl get crd grpcroutes.gateway.networking.k8s.io \
     -o jsonpath='spec.versions={.spec.versions[*].name}  storedVersions={.status.storedVersions}{"\n"}'
   kubectl get grpcroutes.gateway.networking.k8s.io -A
   ```

   Continue only if `storedVersions` contains `v1` and the release message is the one shown in the Issue section.

2. Back up the CRD and its objects:

   ```bash
   kubectl get crd grpcroutes.gateway.networking.k8s.io -o yaml > grpcroutes-crd.yaml
   kubectl get grpcroutes.gateway.networking.k8s.io -A -o yaml > grpcroutes.yaml
   ```

3. Delete the conflicting CRD.

   > **Warning:** Deleting a CRD deletes every object of that kind in the cluster. Run this only when the `storedVersions` conflict above is confirmed, and only after step 1 shows no GRPCRoute objects you still need, or they are saved by step 2. Whatever installed the existing CRD may also depend on it. To roll back, run `kubectl create -f grpcroutes-crd.yaml` and then `kubectl create -f grpcroutes.yaml`. The objects can only be restored while their version is still served by the CRD that is installed at that time.

   ```bash
   kubectl delete crd grpcroutes.gateway.networking.k8s.io
   ```

4. The chart release is retried automatically. Watch it on the imported cluster until it is synced, and confirm the `alb` module becomes `Running` on `global`:

   ```bash
   kubectl get ars -A | grep -i alb
   kubectl get moduleinfo -l cpaas.io/cluster-name=<cluster-name>   # on the global cluster
   ```

   Once all modules are `Running`, the import completes.

## Diagnostic Steps

1. On `global`, find the module that blocks the import. A stuck import with only `alb` `Failed` points at the ALB chart:

   ```bash
   kubectl get moduleinfo -l cpaas.io/cluster-name=<cluster-name>
   ```

2. On the imported cluster, read the ALB chart release status. The `storedVersions[0]: Invalid value: "v1": must appear in spec.versions` message on `grpcroutes.gateway.networking.k8s.io` identifies this issue. A different message, for example an API version the cluster does not serve, is a different problem:

   ```bash
   kubectl get ars -A | grep -i alb
   kubectl get ars -n <namespace> <alb-release-name> -o yaml
   ```

3. Confirm that the CRD existed before the import and was not created by the platform. Its creation time is earlier than the import and its versions include `v1`:

   ```bash
   kubectl get crd grpcroutes.gateway.networking.k8s.io \
     -o jsonpath='{.metadata.creationTimestamp}  {.spec.versions[*].name}{"\n"}'
   ```

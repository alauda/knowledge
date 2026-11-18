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

# Leftover Service Mesh v1 recreates istio-system against Mesh v2 or Istio Secret certificate alerts remain on ACP

## Issue

After Service Mesh v1 (ASM v1) was removed, or while Mesh v2 is being installed on a cluster that used to run v1, one of these is seen:

- Creating Istio-type resources for Mesh v2 fails. Namespace `istio-system` and ServiceAccount `istio-reader-service-account` reappear on the business cluster on their own after they are deleted.
- Certificate monitoring keeps reporting that Istio Secrets are expired or about to expire, although ASM v1 has been uninstalled.

Mesh v1 and Mesh v2 must not be deployed on one cluster at the same time; two Istio installs cannot coexist. Mesh v2 support starts with platform 4.1.1, ASM v1 is no longer maintained, and Service Mesh v1 is removed in platform 4.4.

Related articles: "Service Mesh delete is stuck on a failed to get cluster webhook denial or on pods that still have sidecar injection" covers a delete that does not finish. "Platform certificate expiry alert for a cert-manager serving certificate that renews by itself on ACP" covers Istio CA alerts of a mesh that is still installed.

## Root Cause

### Cause 1: Mesh v1 `servicemesh` and `servicemeshgroup` are still on `global`

The `global` cluster still holds Mesh v1 `servicemesh` and `servicemeshgroup` objects. `global-asm-controller` sees them and keeps creating `istio-system` and related objects on the business cluster. Those objects collide with the Mesh v2 install.

### Cause 2: Istio Secrets left behind by the ASM v1 uninstall

The Secrets named in the alert are leftovers of the ASM v1 uninstall, not the certificate of a live mesh that failed to renew. Nothing renews them any more, so the alert keeps firing until they are removed.

## Resolution

### Cause 1: Mesh v1 `servicemesh` and `servicemeshgroup` are still on `global`

1. On `global`, confirm the v1 objects and find the controller; on the business cluster, back up the Mesh v2 objects:

   ```bash
   # global cluster
   kubectl get servicemesh,servicemeshgroup -A
   kubectl get servicemesh,servicemeshgroup -A -o yaml > /tmp/mesh-v1-leftovers.bak.yaml
   kubectl get deploy -A | grep global-asm-controller
   # business cluster
   kubectl get istio,istiocni -A -o yaml > /tmp/mesh-v2.bak.yaml
   ```

2. Delete the v1 objects on `global`.

   > **Warning:** Mesh v1 reconciliation stops for every business cluster these objects point at. Only when the v1 objects exist and `istio-system` is being recreated against a v2 install, and the backup exists. Rollback: `kubectl apply -f /tmp/mesh-v1-leftovers.bak.yaml` if v1 is still needed and v2 is not installed. If the delete is denied with `failed to get cluster`, follow the stuck-delete article first.

   ```bash
   kubectl delete servicemesh -n <servicemesh-namespace> <servicemesh-name>
   kubectl delete servicemeshgroup -n <servicemeshgroup-namespace> <servicemeshgroup-name>
   ```

3. On the business cluster, delete the conflicting Mesh v2 resources and `istio-system`.

   > **Warning:** This removes the mesh control plane, gateways, and sidecar injection on that cluster; meshed calls fail until Mesh v2 is installed again. Only after step 2 is done and `/tmp/mesh-v2.bak.yaml` exists; use a maintenance window. Rollback: install Mesh v2 again; use the backup only as a reference for its settings.

   ```bash
   kubectl delete istio -n <istio-namespace> <istio-name>
   kubectl delete istiocni <istiocni-name>
   kubectl delete namespace istio-system
   ```

4. Install Mesh v2 again only after `kubectl get servicemesh,servicemeshgroup -A` on `global` shows nothing for this cluster and `istio-system` is no longer recreated.

### Cause 2: Istio Secrets left behind by the ASM v1 uninstall

1. List the Secrets the alert names and confirm that no mesh still uses them:

   ```bash
   kubectl get secret -A | grep -Ei 'istio|cacert'
   kubectl get servicemesh,istio,istiocni -A
   kubectl get pods -A | grep -Ei 'istiod|istio-operator|asm-controller'
   ```

   A Secret referenced by a running Mesh v2 control plane, or by a mesh that is still installed, is not a leftover; leave it.

2. Back up and delete each leftover Secret.

   > **Warning:** Deleting a Secret that a live control plane uses breaks that mesh's certificates. Only when ASM v1 is uninstalled, no v1 `servicemesh` remains, and no running `istiod` mounts the Secret. The backup contains a private key; store it securely. Rollback: `kubectl apply -f /tmp/istio-secret-<name>.bak.yaml`.

   ```bash
   kubectl get secret -n <secret-namespace> <secret-name> -o yaml > /tmp/istio-secret-<secret-name>.bak.yaml
   kubectl delete secret -n <secret-namespace> <secret-name>
   ```

3. Repeat for each Secret the alert names. The certificate alerts stop after the leftovers are gone.

## Diagnostic Steps

1. On `global`:

   ```bash
   kubectl get servicemesh,servicemeshgroup -A
   kubectl get deploy -A | grep -E 'global-asm-controller|asm-controller'
   ```

2. On the business cluster:

   ```bash
   kubectl get istio,istiocni -A
   kubectl get ns istio-system
   kubectl get sa -n istio-system istio-reader-service-account
   kubectl get pods -n istio-system
   ```

| What you see | Cause |
| --- | --- |
| `istio-system` or `istio-reader-service-account` returns after deletion, `global` still has `servicemesh` or `servicemeshgroup`, Mesh v2 resources fail to create | 1 |
| Certificate alert on Istio Secrets after ASM v1 is uninstalled, no running `istiod` uses them | 2 |
| Alert on `asm-istio-cacerts-<cluster>` for a mesh that is still installed | Not a leftover; see the certificate expiry article |

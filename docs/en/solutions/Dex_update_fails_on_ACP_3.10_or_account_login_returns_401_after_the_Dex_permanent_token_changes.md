---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.10"
  - "3.10.2"
  - "3.16"
  - "4.0"
  - "4.2"
  - "4.2.1"
  - "4.3"
  - "4.3.2"
  - "4.3.3"
---

# Dex update fails on ACP 3.10 or account login returns 401 after the Dex permanent token changes

## Issue

One of these is reported:

- On ACP 3.10, the dex component update fails, which raises the question of whether the platform upgrade can continue.
- Right after someone updates the permanent token in the Dex ConfigMap (`dex-configmap` in `cpaas-system`), account login returns HTTP 401. Restarting the container runtime on the node does not clear it.

Related articles: "OIDC clients and pages are sent to the wrong Dex issuer address on ACP" and "Dex login options, CORS, SSO user identity, and the Dex deployment layout on ACP".

## Root Cause

### Cause 1: on 3.10 the dex update fails while the `ui-*` ConfigMaps keep `helm.sh/resource-policy`

The ConfigMaps `ui-logos`, `ui-login-logo`, and `ui-login-bg` in `cpaas-system` carry the annotation `helm.sh/resource-policy`, and the dex update fails. This is a defect in that version, fixed in 3.10.2. Removing the annotation lets the update proceed on a 3.10 build that does not have the fix.

### Cause 2: login returns 401 after the permanent token in `dex-configmap` changes

Account login returns 401 immediately after the permanent token in `dex-configmap` is updated. Restarting the container runtime on the node does not clear the 401; restarting `kube-apiserver` on all clusters does. No deeper root cause was established, so treat the restart as the change that clears the symptom, not as proof of a token-format problem.

## Resolution

### Cause 1: on 3.10 the dex update fails while the `ui-*` ConfigMaps keep `helm.sh/resource-policy`

Prefer upgrading to 3.10.2, which contains the fix. On a 3.10 cluster that must finish the update first:

1. Confirm the annotation on the three ConfigMaps:

   ```bash
   kubectl get cm -n cpaas-system ui-logos ui-login-logo ui-login-bg \
     -o custom-columns=NAME:.metadata.name,ANN:.metadata.annotations
   ```

2. Remove the annotation.

   > **Warning:** Without `helm.sh/resource-policy`, the next dex Helm release may replace `ui-logos`, `ui-login-logo`, and `ui-login-bg`, so logos and login backgrounds that exist only in those objects can be replaced. Precondition: only when the dex update on 3.10 fails and the three objects show `helm.sh/resource-policy`. Back them up first. Rollback: `kubectl apply -f /tmp/dex-ui-cm.bak.yaml` restores the ConfigMaps and the annotation.

   ```bash
   kubectl -n cpaas-system get cm ui-logos ui-login-logo ui-login-bg -o yaml > /tmp/dex-ui-cm.bak.yaml
   kubectl annotate -n cpaas-system cm ui-logos ui-login-logo ui-login-bg helm.sh/resource-policy-
   ```

3. Retry the dex update.

### Cause 2: login returns 401 after the permanent token in `dex-configmap` changes

Apply this only when the 401 started right after the permanent token inside `cpaas-system/dex-configmap` was changed, and a container-runtime restart on the node left the 401 in place.

1. Restart `kube-apiserver` on each control-plane node, one node at a time, by moving its static Pod manifest out and back.

   > **Warning:** Restarting `kube-apiserver` drops API requests on that control-plane node until the static Pod is Ready again. Do one control-plane node at a time and wait for it before the next one. Precondition: only when this cause is confirmed and the other control-plane nodes are Ready. Rollback: if the node stays down with the manifest moved aside, move `/tmp/kube-apiserver.yaml` back to `/etc/kubernetes/manifests/kube-apiserver.yaml`.

   ```bash
   sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/kube-apiserver.yaml
   sleep 20
   sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/kube-apiserver.yaml
   kubectl get nodes
   kubectl -n kube-system get pods -o wide | grep kube-apiserver
   ```

2. Repeat on the remaining control-plane nodes and on every other cluster that shows the 401.

3. Log in again. Account login succeeds after `kube-apiserver` has been restarted on all clusters.

## Diagnostic Steps

```bash
kubectl get cm -n cpaas-system ui-logos ui-login-logo ui-login-bg \
  -o custom-columns=NAME:.metadata.name,ANN:.metadata.annotations
kubectl -n cpaas-system get cm dex-configmap -o yaml > /tmp/dex-configmap.now.yaml
```

- The dex update fails on 3.10, and the three `ui-*` ConfigMaps have `helm.sh/resource-policy`: Cause 1.
- HTTP 401 on account login starts immediately after the permanent token in `dex-configmap` is updated: Cause 2.

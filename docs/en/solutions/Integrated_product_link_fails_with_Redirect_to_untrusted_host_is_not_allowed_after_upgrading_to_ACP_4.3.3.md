---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x
---

# Integrated product link fails with Redirect to untrusted host is not allowed after upgrading to ACP 4.3.3

## Issue

After the platform is upgraded to ACP 4.3.3, an external product that was integrated into the console no longer opens from the platform. The product is listed under **Platform Settings** > **Product Configuration** as an integrated product, with its entry shown, single sign-on enabled and an external product link.

Clicking the entry opens `/console/api/v2/token/redirect?redirect_url=<product-link>`, and the page shows:

```text
Redirect to untrusted host is not allowed
```

The same entry worked before the upgrade.

## Root Cause

In the new version, the console only performs token redirects to hosts that are explicitly allowed. The allowed hosts are listed under the `allowed-redirect-hosts` key of the ConfigMap `console-configmap` in the `cpaas-system` namespace of the `global` cluster.

When the host of an integrated product link is not on that list, the console does not trust it and rejects the redirect. After the upgrade, products that were integrated earlier can be in this state.

## Resolution

1. On a control plane node of the `global` cluster, back up the ConfigMap and look at the current list:

   ```bash
   kubectl -n cpaas-system get configmap console-configmap -o yaml > console-configmap.before.yaml
   kubectl -n cpaas-system get configmap console-configmap -o jsonpath='{.data.allowed-redirect-hosts}{"\n"}'
   ```

2. Edit the ConfigMap and add the host of every integrated product link (the host part of `<product-link>`) to `allowed-redirect-hosts`. Follow the format of the existing entries, and leave the other keys, such as `enable-api-auth`, unchanged:

   ```bash
   kubectl -n cpaas-system edit configmap console-configmap
   ```

3. Restart the console frontend pods so that they load the new list.

   > **Warning:** While the frontend pods restart, the console can be briefly unavailable or show errors to logged-in users; workloads are not affected. Do this only after the `Redirect to untrusted host is not allowed` message is confirmed and the ConfigMap is updated. If the console misbehaves afterwards, restore the backup with `kubectl apply -f console-configmap.before.yaml` and restart the frontend pods again.

   ```bash
   kubectl -n cpaas-system get deploy | grep -i frontend
   kubectl -n cpaas-system rollout restart deploy <frontend-deployment>
   kubectl -n cpaas-system rollout status deploy <frontend-deployment>
   ```

4. Open the integrated product entry from the console again. It redirects to the product.

## Diagnostic Steps

1. Reproduce the failure in the browser and note the exact URL. The `/console/api/v2/token/redirect?redirect_url=...` path together with `Redirect to untrusted host is not allowed` identifies this issue.

2. Compare the host of `redirect_url` with the allowed list. If the host is missing from `allowed-redirect-hosts`, this is the cause:

   ```bash
   kubectl -n cpaas-system get configmap console-configmap -o jsonpath='{.data.allowed-redirect-hosts}{"\n"}'
   ```

3. If the host is already listed but the error persists, check that the frontend pods were restarted after the change (their age is newer than the edit):

   ```bash
   kubectl -n cpaas-system get pods | grep -i frontend
   ```

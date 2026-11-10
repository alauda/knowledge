---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x
---

# Storage navigation entries added by plugins or Operators cannot be hidden with custom-navconfig-platform on ACP

## Issue

On ACP 4.3, an administrator wants to hide some entries under **Storage** in the left navigation of the **Administrator** view, such as **Distributed Storage**, **Local Storage** and **Object Storage**. Following "Customizing the Left Navigation" in the product documentation, `"hidden": true` is added for those entries in the `buildIn` data of the ConfigMap `custom-navconfig-platform` (namespace `cpaas-system`, `global` cluster), and the browser is refreshed. The entries are still shown.

Hiding the whole `storage_management` group, or the documented built-in children such as `storageclasses`, works as expected.

## Root Cause

`custom-navconfig-platform` only customizes the **built-in** navigation. The built-in children of `storage_management` are `storageclasses` (StorageClasses), `nav_pv` (PersistentVolumes), `object_storage_class` (Object StorageClass) and `bucket` (Buckets). Keys that do not match a built-in item have no effect.

The **Distributed Storage**, **Local Storage** and **Object Storage** entries are not built-in items: they are added to the navigation when the corresponding storage plugins or Operators are installed. There is no separate switch to hide them, so no key in `custom-navconfig-platform` removes them.

## Resolution

1. Decide whether the storage capability behind the entry is used. An entry contributed by a plugin or Operator disappears only when that plugin or Operator is uninstalled.

2. If the capability is not needed, uninstall the corresponding plugin or Operator from **Administrator** > **Marketplace** (**Cluster Plugins** or **OperatorHub**, depending on how it was installed). Its navigation entry is removed with it.

   > **Warning:** Uninstalling a storage plugin or Operator removes the storage service it provides. Workloads that use volumes or buckets from it lose access to that storage, and data held only there can become unavailable. Uninstall it only after confirming that no PersistentVolumeClaim, StorageClass or bucket in any cluster still depends on it. Reinstalling the plugin or Operator restores the entry and the service, but not data that was removed with it.

3. If the capability is in use, keep the plugin or Operator installed: its entry cannot be hidden.

4. For the built-in items, hiding keeps working as documented. For example, to hide the PersistentVolumes entry:

   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: custom-navconfig-platform
     namespace: cpaas-system
   data:
     buildIn: |
       {
         "nav_pv": {
           "hidden": true
         }
       }
   ```

   Refresh the browser after editing.

## Diagnostic Steps

1. Check what is currently configured. The ConfigMap must be in `cpaas-system` on the `global` cluster:

   ```bash
   kubectl -n cpaas-system get configmap custom-navconfig-platform -o yaml
   kubectl -n cpaas-system get configmap | grep navconfig
   ```

2. Compare the keys under `buildIn` with the built-in storage items `storage_management`, `storageclasses`, `nav_pv`, `object_storage_class` and `bucket`. Keys such as `distributed_storage` or `local_storage` are not built-in names and are ignored.

3. Check whether the entry belongs to an installed storage plugin or Operator: it appears after that component is installed and is absent on clusters where it is not installed. Such an entry cannot be hidden through `custom-navconfig-platform`.

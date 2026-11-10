---
kind:
  - Troubleshooting
products:
  - Alauda Service Mesh
ProductsVersion: []
---

# Service mesh history is not visible after switching the Elasticsearch integration to another cluster on ACP

## Issue

A service mesh stores its data in the platform Elasticsearch of the `global` cluster, and it has to move to the Elasticsearch of another cluster. Administrators ask whether the setting can be changed in place, and after the change they find that the data recorded before the switch no longer appears in the mesh views.

The mesh's **Update Elasticsearch Integration Configuration** dialog shows **Source** set to **Platform** (the alternative is **External**), **Cluster** set to `global`, and an automatically filled **Access Address** that ends in `/es_proxy`.

## Root Cause

The Elasticsearch integration of a service mesh can be changed directly: selecting another cluster with **Source** = **Platform** points the mesh at that cluster's platform Elasticsearch, and the access address is generated automatically.

The switch does not migrate data. Historical data stays in the Elasticsearch of the original cluster. After the switch, the mesh creates new indices in the new Elasticsearch, writes new data there, and queries only those new indices. Data recorded before the switch is therefore not visible from the mesh, although it still exists in the original Elasticsearch.

## Resolution

1. Open the service mesh and its **Update Elasticsearch Integration Configuration** dialog.

2. Keep **Source** as **Platform**, select the target cluster in **Cluster**, and check that **Access Address** is regenerated for that cluster (it still ends in `/es_proxy`).

3. Click **Update**.

   > **Warning:** After the update, the mesh writes to and reads from the new Elasticsearch only. Data recorded before the switch is not copied and is no longer shown in the mesh, although it remains in the original Elasticsearch. Plan the switch at a time when the loss of history in the mesh views is acceptable, and keep the original Elasticsearch until its data is no longer needed. To roll back, open the same dialog, select the original cluster again and click **Update**. Data written to the new cluster in the meantime stays there and is not copied back.

4. Generate some traffic in the mesh and confirm that new data appears in the mesh views.

## Diagnostic Steps

1. Reopen **Update Elasticsearch Integration Configuration** and check that **Cluster** shows the new cluster and **Access Address** points to it.

2. If the new data appears but the old data does not, this is the expected result of the switch, not a failure: the old data is still in the original cluster's Elasticsearch.

3. If no new data appears either, check that the platform Elasticsearch of the target cluster is installed and healthy before suspecting the mesh configuration.

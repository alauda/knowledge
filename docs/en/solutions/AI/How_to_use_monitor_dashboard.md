---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.2
id: #need review first, then get it from TieYan Zhou
---

# Observe Dashboards in Alauda AI 1.5

## Observe Dashboards loading stuck workaround

When Alauda AI is deployed on ACP 4.2.0, changes in ACP’s default security policies may cause monitoring data to be unavailable on the monitoring details page of inference services created by Alauda AI. This issue will be fixed in a future ACP release.

As a temporary workaround, perform the following steps in the corresponding business cluster:

```bash
kubectl edit clusterroles warlock -n cpass-system
```

Add the following rules:

```yaml
rules:
  - apiGroups:
      - components.aml.dev
    resources:
      - amls/finalizers
    verbs:
      - update
```

After applying the changes, restart the warlock deployment:

```bash
kubectl rollout restart deployment warlock -n cpaas-system
```

## Add MonitorDashboard

In the Administrator view, navigate to Operations Center and select the Monitor menu. Expand it and click Dashboards.

On the Dashboards page, click the Create button in the upper-right corner.

In the Create Dashboard form, provide a Dashboard Name and select a Folder. Note that the Folder must be set to AML.

After creation, you can switch to the newly created dashboard in the Alauda AI view under Observe Dashboards by clicking the Switch button.

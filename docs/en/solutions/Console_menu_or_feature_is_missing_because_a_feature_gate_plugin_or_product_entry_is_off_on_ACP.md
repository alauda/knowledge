---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
  - "4.4"
---

# Console menu or feature is missing because a feature gate, plugin, or product entry is off on ACP

## Issue

The console opens, but a menu, a feature, or a product entry is missing or shows an error, typically after an upgrade:

- Namespace-scoped CRD management, available on 3.18, is not visible on 4.x.
- The namespace audit switch is greyed out.
- The UI cannot be switched to Chinese after an upgrade to 4.2.4.
- Load balancers are no longer listed in platform management after an upgrade.
- The data services entry is missing from the portal after an upgrade to 4.0.10.
- Clicking a cluster name in **Alerts** > **Real-time Alerts** shows `缺少翻译文件：插件console-core-service缺少zh语言翻译文件：plugin_console-core-service.json` (missing translation file: plugin console-core-service lacks the zh translation file).
- The **EXEC** entry is missing from Pod and application pages; see [EXEC and Debug entries missing from Pod and application pages until the cpc-exec feature gate is enabled on ACP](EXEC_and_Debug_entries_missing_from_Pod_and_application_pages_until_the_cpc-exec_feature_gate_is_enabled_on_ACP.md).

Feature gates are managed at `<platform-access-address>/console-platform/feature-gate`, and are `AlaudaFeatureGate` objects (`alaudafeaturegates.alauda.io`) in `cpaas-system`.

Related article: [Console menu bar or Data Services navigation does not load because of a workload cluster ALB or a credential on ACP](Console_menu_bar_or_Data_Services_navigation_does_not_load_because_of_a_workload_cluster_ALB_or_a_credential_on_ACP.md).

## Root Cause

### Cause 1: namespace-scoped CRD management is behind the namespace-resource-manage gate

The feature was not removed in 4.x. It is off by default behind the feature gate `namespace-resource-manage`, which a search for an obvious name on the feature gate page does not find.

### Cause 2: the namespace audit switch is greyed out because namespaceaudits is disabled

The availability of the namespace audit switch is controlled by the `namespaceaudits` entry of a feature gate resource, not by the switch itself. While that entry is disabled, the switch stays grey.

### Cause 3: the Chinese language pack plugin is not deployed

After the upgrade to 4.2.4, Chinese cannot be selected until the Chinese language pack plugin is deployed.

### Cause 4: the alb2 feature gate is off

After an upgrade, load balancers are missing from platform management because the `alb2` `AlaudaFeatureGate` in `cpaas-system` is not enabled.

### Cause 5: the data services ProductEntry has packType AdminPage

`kubectl get ProductEntry console-dataservices -o yaml` shows an `alauda.io/v1alpha1` `ProductEntry` (owned by the Helm release `application-services-core` in `cpaas-system`) with `spec.entrypoint: /console-dataservices` and `spec.packType: AdminPage`. With `packType: AdminPage`, the entry is not shown on the portal.

### Cause 6: the new web console plugin has no Chinese translation file

In the browser developer tools on the real-time alert page, `GET /console-i18n/zh/plugin__console-core-service.json` returns `404 Not Found` with header `X-Alb-Err-Reason: BackendError ...`, and other plugin translation requests such as `plugin__web-cli-service` can fail too. The new web console plugins (`console-core`) insert jump links into the existing console pages but do not ship the matching Chinese translation file. The Chinese language pack is upgraded separately, and its latest version contains the file.

## Resolution

### Cause 1: namespace-scoped CRD management is behind the namespace-resource-manage gate

Open `/console-platform/feature-gate`, search for `namespace-resource-manage`, and enable it. Namespace-scoped CRD management is shown again.

### Cause 2: the namespace audit switch is greyed out because namespaceaudits is disabled

1. Find the feature gate resource kind:

   ```bash
   kubectl api-resources | grep -i featuregate
   ```

2. In **Resource Management**, open the feature gate object that contains `namespaceaudits` and set its `enabled` field to `true`.

   > **Warning:** This turns on namespace audit for the platform. Do it only when the switch is greyed out and this entry is disabled. To roll back, set `enabled` back to `false`.

### Cause 3: the Chinese language pack plugin is not deployed

Deploy the Chinese language pack plugin from the cluster plugins page, then switch the UI language again. No feature gate change is needed.

### Cause 4: the alb2 feature gate is off

1. Read the gate:

   ```bash
   kubectl get alaudafeaturegates -n cpaas-system alb2 -o yaml
   ```

2. Enable it and set the annotation `cpaas.io/ignoreme` to `true`.

   > **Warning:** This enables load balancer management in the console. Apply it only when load balancers are missing after an upgrade and `spec.enabled` is not already `true`. To roll back, set `spec.enabled` to `false` and remove the annotation.

   ```bash
   kubectl patch alaudafeaturegates alb2 -n cpaas-system --type=merge -p '{"spec":{"enabled":true},"metadata":{"annotations":{"cpaas.io/ignoreme":"true"}}}'
   ```

3. Reload platform management. Load balancers are listed again.

### Cause 5: the data services ProductEntry has packType AdminPage

> **Warning:** Changing `packType` changes how the portal classifies the entry. Do it only when the entry is missing and `spec.packType` is `AdminPage`. Keep a copy first; to roll back, set `spec.packType` back to `AdminPage`.

```bash
kubectl get ProductEntry console-dataservices -o jsonpath='{.spec.packType}{"\n"}'
kubectl get ProductEntry console-dataservices -o yaml > "$HOME/console-dataservices.yaml"
kubectl patch ProductEntry console-dataservices --type=merge -p '{"spec":{"packType":"Buildin"}}'
```

The portal shows the data services entry once `spec.packType` is `Buildin`.

### Cause 6: the new web console plugin has no Chinese translation file

1. Confirm the signature in the browser developer tools: the request for `/console-i18n/zh/plugin__console-core-service.json` returns 404.
2. Upgrade the Chinese language pack plugin to its latest version, which contains the translation file.
3. If the new web console is not used and the language pack cannot be upgraded yet, uninstalling the new web console plugins also removes the error.

   > **Warning:** Uninstalling those plugins removes the new web console jump links and any page that depends on them. Remove only the plugins added for the new web console, not other console plugins. To roll back, install them again.

## Diagnostic Steps

```bash
kubectl get alaudafeaturegates -n cpaas-system | grep -E 'alb2|exec|namespace'
kubectl get ProductEntry console-dataservices -o yaml
```

```text
CRD management missing on 4.x, namespace-resource-manage off          -> Cause 1
namespace audit switch greyed out                                     -> Cause 2
cannot switch to Chinese after 4.2.4                                  -> Cause 3
load balancers missing after an upgrade, alb2 disabled                -> Cause 4
data services entry missing, packType AdminPage                       -> Cause 5
plugin_console-core-service.json missing, /console-i18n/zh/... 404    -> Cause 6
EXEC missing, cpc-exec disabled                                       -> the cpc-exec article linked above
```

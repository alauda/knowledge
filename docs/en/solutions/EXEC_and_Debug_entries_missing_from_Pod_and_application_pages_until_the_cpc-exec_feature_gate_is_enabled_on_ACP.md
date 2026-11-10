---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.4.x
---

# EXEC and Debug entries missing from Pod and application pages until the cpc-exec feature gate is enabled on ACP

## Issue

The product documentation for containers describes how to open a shell in a container (**EXEC**) and how to debug a Pod with an ephemeral container (**Debug**) from the web console: **Container Platform** > **Workloads** > **Pods** > ⋮ > **Debug** or **EXEC**, or **EXEC** on a workload in the application details. In the console of an ACP 4.4.1 cluster, the ⋮ menu of the Pods and the application pages shows neither **EXEC** nor **Debug**, and the container documentation does not mention any switch for them.

## Root Cause

**EXEC** and **Debug** in the console are Alpha features that are controlled by the feature gate `cpc-exec`. The console shows the **EXEC** and **Debug** entries on application-related pages only when this gate is enabled. While the gate is off, the entries are hidden.

A second Alpha gate, `cpc-exec-file`, controls file transfer inside **EXEC** and **Debug**. When it is enabled, a file transfer entry appears in the EXEC and Debug windows.

Because both are Alpha features, they are also hidden when Alpha features are turned off for the whole platform in the **Stage Setting** section of the feature gate page.

## Resolution

1. Open the feature gate page at `<platform-access-address>/console-platform/feature-gate`. For example, if the platform access address is `https://demo.example.com/console-portal/`, open `https://demo.example.com/console-platform/feature-gate`.

2. Enable `cpc-exec`:

   - To enable it for one cluster, find the gate list titled with the display name of that cluster and turn on `cpc-exec` there.
   - Check that the **Alpha Feature** switch in **Stage Setting** is on, and that `cpc-exec` is not turned off in **System Settings**, which disables a gate for all clusters.

3. Optionally, enable `cpc-exec-file` in the same place to get file transfer inside EXEC and Debug.

4. Reload the console and open **Container Platform** > **Workloads** > **Pods** > ⋮. The **EXEC** and **Debug** entries are now shown.

The command line does not depend on these gates. Without the console entries, `kubectl exec -it <pod-name> -c <container-name> -n <namespace> -- /bin/sh` and `kubectl debug -it <pod-name> --image=<debug-image> --target=<container-name> -n <namespace>` work as usual.

## Diagnostic Steps

1. On the feature gate page, look up `cpc-exec` and `cpc-exec-file`. Expected: both have the stage `Alpha`. For this issue `cpc-exec` is off for the cluster, or Alpha features are off in **Stage Setting**.

2. After enabling the gate, check the ⋮ menu of a Pod in that cluster. If the entries are still missing, make sure that you enabled the gate in the list of the cluster you are viewing and not of another one, and reload the page.

3. If **EXEC** or **Debug** is shown but the terminal does not open or the debug container does not initialize, the gate is working and the problem is elsewhere, for example in the web terminal component or in a security policy that blocks ephemeral containers. That is not covered by this article.

---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
---

# Envoy Gateway console pages differ between two environments because different gateway UI plugins are installed on ACP

## Issue

The Envoy Gateway pages in the web console look different in two environments, for example development and production:

- In one environment the route page is under **Network > Route**. It offers only the `HTTPRoute`, `TCPRoute` and `UDPRoute` route types, and it shows no routes.
- In the other environment the route page is under **Network > Gateway > Route**, next to **Gateway** and **Policy** sub-menus. It offers `HTTPRoute`, `TCPRoute`, `UDPRoute`, `TLSRoute` and `GRPCRoute`, and lists routes with their gateway and listener.
- Both environments run the same ACP version (for example 4.2.5), both have the `TLSRoute` and `GRPCRoute` CRDs, and both use the same network mode.

## Root Cause

### Cause 1: different gateway UI plugins are installed in the two environments

The page layout and the route types come from the console plugin that serves the gateway pages, not from the cluster CRDs. **Administrator > Marketplace > Cluster Plugins** shows different plugins in the two environments, for example:

- **Alauda Container Platform GatewayAPI Plugin** ("User Interface and extended API server for the GatewayAPI"), `v4.3.4`, Installed, in one;
- **Alauda Container Platform Ingress Gateway**, `v4.2.9`, Installed, in the other.

The GatewayAPI Plugin is the GatewayAPI UI of later ACP versions, opened at **Container Platform > Network > Gateway**, which matches the layout with **Gateway**, **Route** and **Policy** sub-menus. The plugin difference causes the page differences.

## Resolution

### Cause 1: different gateway UI plugins are installed in the two environments

Only when the ACP version and the route CRDs are the same in both environments, and the installed gateway plugins differ.

The difference is only in the console pages; the Gateway API resources are the same. If both environments must show the same pages, install the same plugin at the same version in both. On ACP 4.2, [How to Install the GatewayAPI UI Plugin for Shared Gateways in ACP 4.2](How_to_Install_GatewayAPI_UI_Which_Could_ShareGateway_IN_ACP_4.2.md) installs the GatewayAPI Plugin on the `global` cluster from **Administrator > Marketplace > Cluster Plugins**, after the plugin package is obtained from the platform maintenance team and uploaded with `violet`. That guide first hides the built-in GatewayAPI page with the `gatewayapi` feature gate:

> **Warning:** Setting the `gatewayapi` feature gate to `false` hides the built-in GatewayAPI page for every user of the platform until the plugin page is installed. It does not delete Gateway API resources. Have the plugin package for this version on hand, schedule the change with the console users, and record the current value. To roll back, patch `spec.enabled` back to `true`.

```bash
kubectl get alaudafeaturegates.alauda.io gatewayapi -n cpaas-system -o jsonpath='{.spec.enabled}{"\n"}'
kubectl patch alaudafeaturegates.alauda.io gatewayapi -n cpaas-system --type=merge -p '{"spec":{"enabled":false}}'
```

Then follow the guide's upload and install steps, and open **Container Platform > Network > Gateway** in both environments.

The feature gate step belongs to this ACP 4.2 plugin installation. It is not a way to hide the **Gateway** menu entry on ACP 4.3, where that entry is provided by the `gatewayapi-plugin` cluster plugin pre-installed on the `global` cluster.

## Diagnostic Steps

1. Compare the versions and the CRDs first. If they differ, the page difference can come from them instead:

   ```bash
   kubectl get crd | grep -E 'tlsroutes|grpcroutes|httproutes'
   kubectl get gatewayclass
   ```

2. Compare the installed plugins in **Administrator > Marketplace > Cluster Plugins** in both environments, or on the `global` cluster. One environment listing the GatewayAPI Plugin and the other the Ingress Gateway plugin, or different versions, is Cause 1:

   ```bash
   kubectl get moduleinfo | grep -i -E 'gateway'
   kubectl get alaudafeaturegates.alauda.io gatewayapi -n cpaas-system -o jsonpath='{.spec.enabled}{"\n"}'
   ```

3. A route that exists in the cluster and is missing from one page is not proof that the route is broken. Read it from the cluster:

   ```bash
   kubectl get httproute,tlsroute,grpcroute -A
   ```

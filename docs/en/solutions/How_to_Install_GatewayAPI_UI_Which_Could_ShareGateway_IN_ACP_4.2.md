---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2
tags:
  - LB
---
# How to Install the GatewayAPI UI Plugin for Shared Gateways in ACP 4.2

## Overview

ACP 4.2 includes a built-in GatewayAPI UI, but that UI was not adapted for Envoy Gateway shared-gateway scenarios. When creating or updating a Route, the built-in page cannot select listeners from Gateways in other namespaces. This makes it inconvenient to use one Gateway as the shared traffic entry point for Routes from multiple namespaces.

This guide explains how to install the newer GatewayAPI UI plugin on ACP 4.2 and use it instead of the built-in GatewayAPI page. This plugin is the GatewayAPI UI used by later ACP versions; this procedure only installs it earlier on ACP 4.2.

The procedure installs only the UI plugin and its API service. It does not install Envoy Gateway itself.

## Prerequisites

Before installing the GatewayAPI UI plugin, ensure the following requirements are met:

1. **ACP version**: The platform is ACP 4.2.

2. **Envoy Gateway Operator**: The Envoy Gateway Operator must already be installed and available in the cluster where GatewayAPI resources will be used.

3. **UI plugin package**: Contact the platform maintenance team to obtain the GatewayAPI plugin package and rename it to `gatewayapi-plugin.tgz`.

4. **Administrative access**: You can run `kubectl` against the platform cluster and can upload cluster plugin packages with `violet`.

## Installation

### Step 1: Hide the Built-in GatewayAPI UI

On ACP 4.2, disable the built-in GatewayAPI page before using the plugin page:

```bash
kubectl patch alaudafeaturegates.alauda.io gatewayapi -n cpaas-system --type=merge -p '{"spec":{"enabled":false}}'
```

This hides the old UI page. It does not delete existing GatewayAPI resources.

Verify that the feature gate is disabled:

```bash
kubectl get alaudafeaturegates.alauda.io gatewayapi -n cpaas-system -o jsonpath='{.spec.enabled}{"\n"}'
```

The expected output is:

```text
false
```

### Step 2: Upload the GatewayAPI UI Plugin

Use the `violet` command to publish the plugin package to the platform repository:

```bash
violet push --debug --platform-address $ACP_PLATFORM_ADDRESS --platform-username $ACP_PLATFORM_USERNAME --platform-password $ACP_PLATFORM_PASSWORD gatewayapi-plugin.tgz
```

### Step 3: Install the Plugin on the Global Cluster

1. Navigate to **Administrator** > **Marketplace** > **Cluster Plugins**
2. Switch to the `global` cluster
3. Locate and install the **Alauda Container Platform GatewayAPI Plugin**
4. After the installation is complete, open **Container Platform** > **Network** > **Gateway**

Install this plugin only on the `global` cluster. It provides the GatewayAPI UI and API service for the platform console; workload clusters do not need a separate plugin installation.

## Verification

1. Open **Container Platform** > **Network** > **Gateway** and confirm the new Gateway page is available.
2. Open a Route creation or update page in an application namespace.
3. In the listener selection field, confirm that the page can show listeners from a Gateway in another namespace when that Gateway listener allows Routes from the Route namespace.

## Known Limitation

When creating policies in environments installed using this manual approach, user information and creation/update timestamps are not automatically populated.

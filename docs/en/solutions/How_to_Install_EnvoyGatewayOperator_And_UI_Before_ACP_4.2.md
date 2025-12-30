---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB251200023
---

# How to Install Envoy Gateway Operator and UI Before ACP 4.2

## Overview

This guide explains how to manually install the Envoy Gateway Operator and GatewayAPI UI for ACP versions before 4.2.

**Note:**
- **ACP 4.2+**: The Envoy Gateway Operator is available directly in the OperatorHub. You can skip the "Installing the Operator" section.
- **ACP 4.3+**: The GatewayAPI UI package is pre-installed. You can skip the "Installing the GatewayAPI UI" section.


## Installing the Operator

### Prerequisites

Before installing the Envoy Gateway Operator, ensure the following requirements are met:

1. **Gateway API CRDs**: The Gateway API custom resource definitions must be installed in your cluster, as Envoy Gateway depends on them.

2. **Installation Package**: Download the Envoy Gateway Operator installation file from Alauda Cloud and rename it to `envoy-gateway-operator.tgz`.

3. **Publish to Platform Repository**: Use the `violet` command to publish the package to the platform repository:

   ```bash
   violet push --debug --platform-address $ACP_PLATFORM_ADDRESS --platform-username $ACP_PLATFORM_USERNAME --platform-password $ACP_PLATFORM_PASSWORD ./envoy-gateway-operator.tgz
   ```

### Installation Steps

#### Step 1: Install the Operator

1. Navigate to **Administrator** > **Marketplace** > **OperatorHub**
2. Under the **Networking** category and **Alauda** source, locate the **Envoy Gateway Operator**
3. Click **Install** to begin the installation process
4. In the **Install Alauda build of Envoy Gateway** dialog, click **Install**
5. Click **Confirm** to complete the installation

Once installation is complete, the status will change to **Installed** on the OperatorHub page.

#### Step 2: Create the EnvoyGatewayCtl Instance

1. On the OperatorHub page, click **Alauda build of Envoy Gateway** to open its details page
2. Navigate to the **All Instances** tab
3. Click **Create** to create a new instance
4. Select **EnvoyGatewayCtl** as the instance type and click **Create**
5. In most cases, the default configuration is sufficient. Click **Create** to complete the setup.

## Installing the GatewayAPI UI

### Important Notes

- **ACP versions before 4.2**: Only platform administrators can create gateways through the UI. Other user roles will encounter errors when attempting to create gateways.
- **ACP 4.2**: If you install the GatewayAPI UI plugin in ACP 4.2, you can hide the old UI page by running the following command:

  ```bash
  kubectl patch alaudafeaturegates.alauda.io gatewayapi -n cpaas-system --type=merge -p '{"spec":{"enabled":false}}'
  ```

- **Known Limitation**: When creating policies in environments installed using this manual approach, user information and creation/update timestamps will not be automatically populated.

### Prerequisites

Before installing the GatewayAPI UI, ensure the following requirements are met:

1. **Envoy Gateway Operator**: The Envoy Gateway Operator must be installed (see previous section).

2. **UI Plugin Package**: Download the GatewayAPI Plugin installation file from Alauda Cloud and rename it to `gatewayapi-plugin.tgz`.

3. **Publish to Platform Repository**: Use the `violet` command to publish the plugin to the platform repository:

   ```bash
   violet push --debug --platform-address $ACP_PLATFORM_ADDRESS --platform-username $ACP_PLATFORM_USERNAME --platform-password $ACP_PLATFORM_PASSWORD gatewayapi-plugin.tgz
   ```

### Installation Steps

1. Navigate to **Administrator** > **Marketplace** > **Cluster Plugins**
2. Locate and install the **Alauda Container Platform GatewayAPI Plugin**
3. Once installed, a new **Gateway** menu item will appear under **Container Platform** > **Network**

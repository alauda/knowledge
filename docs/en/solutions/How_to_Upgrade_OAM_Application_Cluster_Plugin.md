---
products: 
  - Alauda Container Platform
kind:
  - Solution
id: none
---

# How to Upgrade OAM Application Cluster Plugin

## Overview
This document provides instructions for upgrading **OAM Application** (cluster plugin) within a cluster managed by the ACP. It specifically applies when your ACP platform version is being upgraded **from a version earlier than 4.2 to version 4.2 or later**.

## Prerequisites
Before proceeding with the cluster plugin upgrade, ensure the following conditions are met:
- **Plugin Installed**: The OAM Application plugin has been installed in the target cluster.
- **ACP Platform Upgraded**: The ACP platform itself must have been successfully upgraded to version 4.2 or later.
- **Cluster Health**: The target cluster must be in a healthy state. Verify that all core components and nodes are functioning normally.
- **Administrative Permissions**: You must have the necessary administrative permissions (e.g., cluster administrator) within ACP to perform upgrade operations on cluster-level plugins.

## Upgrade Procedure
Follow these steps to upgrade the OAM Application cluster plugin:

### Pre-Upgrade Check & Preparation
1. Log in to the ACP web console.
2. Navigate to the **Administrator** page.
3. Click **Marketplace** > **Cluster Plugins** to open the cluster plugin management page.
4. Find the **Alauda Container Platform Application Management for KubeVela** plugin and ensure it is in the **Installed** state.

### Performing the Upgrade

#### Obtaining the Upload Tool
Navigate to `Administrator` -> `Marketplace` -> `Upload Packages` to download the upload tool named `violet`. After downloading, grant execute permissions to the binary.

#### Upload the Plugin
Download the oam-application installation file: `oam-application.x.tgz`

Use the `violet` command to publish to the platform repository:
```bash
violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password=<platform-admin-password> oam-application-ALL.2.x.tgz
```
Parameter description:
* `--platform-address`: ACP Platform address.
* `--platform-username`: ACP Platform administrator username.
* `--platform-password`: ACP Platform administrator password.

After the `violet` command execution is complete, navigate to the details page of **Alauda Container Platform Application Management for KubeVela** plugin at [Administrator] -> [Marketplace] -> [Cluster Plugins]. You will see the new plugin version.

#### Upgrade the Plugin
Click **Upgrade** to upgrade the plugin.
The upgrade process may take some time. Wait for the upgrade to complete.

### Manual Configuration Update
**Important**: You must update the metis MutatingWebhookConfiguration and ValidatingWebhookConfiguration resources to remove a specific webhook configuration that will cause conflicts with the new plugin version.

**Reason for this action**:
In previous ACP versions (before 4.2), the webhook configuration for OAM application mutation and validation was managed directly by the platform. In ACP 4.2, this functionality has been migrated into the new version of the cluster plugin. If this webhook configuration is not removed from old metis MutatingWebhookConfiguration and ValidatingWebhookConfiguration resources, it will cause conflicts as duplicate webhooks will attempt to handle the same resources, potentially leading to admission errors or unexpected behavior.

#### Execute the following commands to delete the mutatingwebhookconfiguration entry via CLI:

1. Backup the current configuration (recommended):
```bash
kubectl get mutatingwebhookconfiguration metis-mutation -o yaml > metis-mutation-backup.yaml
```
2. Modify the current configuration:
```bash
kubectl edit mutatingwebhookconfiguration metis-mutation
```
3. In the editor, locate the webhook entry with name: oamapp.cpaas.io, delete the webhook entry such as below.
```yaml
  - admissionReviewVersions:
      - v1
      - v1beta1
    clientConfig:
      caBundle: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURCekNDQWUrZ0F3SUJBZ0lSQU95N05ON2RCK3owYnVuRGdHdVhpSmt3RFFZSktvWklodmNOQVFFTEJRQXcKQURBZUZ3MHlOVEV3TWpjd09EVTJORE5hRncwek5URXdNalV3T0RVMk5ETmFNQUF3Z2dFaU1BMEdDU3FHU0liMwpEUUVCQVFVQUE0SUJEd0F3Z2dFS0FvSUJBUURGd1o5bGJhNU51Mmk1em5EZGEyMFhvV0ZIUlJnTjgwWVA2aE5nClg2QjVlek85TVc1T2dUQ2JWaURzUzdCMWRaeU55ZjdwaVBvcHFaV0EvMmt1L3k1OU56K01hZk9VS05XSXhjUTEKN3MxOXFHZUxHZDQ1WnJzZXRTZ1o3L2pCQ3ZVdnNCbGRaNjgrdG15YTZaWGVna3E5cm9PQ0VPbU5waEFZT2dCYQp0Ymw2UGxySmt2MW16d2QvNklCSXdWc3RCVS9tZkdFTlNJMEpyY25CcGsrUWNOYmxpTXpLb0F4Nk82TmJDVEkzCmh0TmNqb3Z2b1M1NjFMUTlnQVduNjhzQTZ1Zkg3WmVsYzI4MDVNa2pzeC9SV3djeEw5dVk4Uk5QTUM5N3FYQmoKVXRtaE0rL2tqQW1OWERqRXl2Nkh5dU5TblQ0ODhwbVN6OXRmY0pRdjg0Z3pWQUpCQWdNQkFBR2pmREI2TUE0RwpBMVVkRHdFQi93UUVBd0lGb0RBTUJnTlZIUk1CQWY4RUFqQUFNRm9HQTFVZEVRRUIvd1JRTUU2Q0htMWxkR2x6CkxYZGxZbWh2YjJzdVkzQmhZWE10YzNsemRHVnRMbk4yWTRJc2JXVjBhWE10ZDJWaWFHOXZheTVqY0dGaGN5MXoKZVhOMFpXMHVjM1pqTG1Oc2RYTjBaWEl1Ykc5allXd3dEUVlKS29aSWh2Y05BUUVMQlFBRGdnRUJBSXZSOVBFaApIRERabDQzU005UnpBQjEybHFEdk1UQVVsOU0wWjJoQUw3MTUrUFl6R1pySXpVKy81SHVKN0U1bFB4ekEyR01VCkRSOWQwZ2g0NnNja2ZQS0VzRG9yMWYybEVicVd2aDVFMTloanIycCtRMXNOTnE0ZDFZR0RoLytQMkVLUjhOOFgKN0x2RklGOU0ySjN6QWlwUlBRR0NDMkY0dkR0TnNCODBqVFBieDdmMWVPYXZMR3NGU2ltNmZBaHFwVEJXRStPVAo4VVNYdHpjdys0bDI0aGovSTUvOTl5dlJlSXRrVmhQY3NzVktHU2dmb3d1TEkxRVdrWEZXMXFDUDdxSzZzM3RUCnREVjJiV0k3RG9RYmZDNmlhVzB3MGZ0OHZVa01HQnV3QUdqakU3WWtGSkpNV1FlTDdrU1dhMnB5dXdUZWt1aGsKbmc3Qm13SU00SXVUcUZNPQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==
      service:
        name: metis-webhook
        namespace: cpaas-system
        path: /oam/app-mutate
        port: 443
    failurePolicy: Fail
    matchPolicy: Equivalent
    name: oamapp.cpaas.io
    namespaceSelector: {}
    objectSelector: {}
    reinvocationPolicy: Never
    rules:
      - apiGroups:
          - core.oam.dev
        apiVersions:
          - v1beta1
        operations:
          - CREATE
          - UPDATE
        resources:
          - applications
        scope: "*"
    sideEffects: NoneOnDryRun
    timeoutSeconds: 10
```
4. Save and exit the editor.

5. Verify the webhook has been removed:
```bash
kubectl get mutatingwebhookconfiguration metis-mutation -o yaml | grep oamapp.cpaas.io
```

#### Execute the following commands to delete the validatingwebhookconfiguration entry via CLI:

1. Backup the current configuration (recommended):
```bash
kubectl get validatingwebhookconfiguration metis-validation -o yaml > metis-validation-backup.yaml
```
2. Modify the current configuration:
```bash
kubectl edit validatingwebhookconfiguration metis-validation
```
3. In the editor, locate the webhook entry with name: oamapp.cpaas.io, delete the webhook entry such as below.
```yaml
  - admissionReviewVersions:
      - v1
      - v1beta1
    clientConfig:
      caBundle: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURCekNDQWUrZ0F3SUJBZ0lSQU95N05ON2RCK3owYnVuRGdHdVhpSmt3RFFZSktvWklodmNOQVFFTEJRQXcKQURBZUZ3MHlOVEV3TWpjd09EVTJORE5hRncwek5URXdNalV3T0RVMk5ETmFNQUF3Z2dFaU1BMEdDU3FHU0liMwpEUUVCQVFVQUE0SUJEd0F3Z2dFS0FvSUJBUURGd1o5bGJhNU51Mmk1em5EZGEyMFhvV0ZIUlJnTjgwWVA2aE5nClg2QjVlek85TVc1T2dUQ2JWaURzUzdCMWRaeU55ZjdwaVBvcHFaV0EvMmt1L3k1OU56K01hZk9VS05XSXhjUTEKN3MxOXFHZUxHZDQ1WnJzZXRTZ1o3L2pCQ3ZVdnNCbGRaNjgrdG15YTZaWGVna3E5cm9PQ0VPbU5waEFZT2dCYQp0Ymw2UGxySmt2MW16d2QvNklCSXdWc3RCVS9tZkdFTlNJMEpyY25CcGsrUWNOYmxpTXpLb0F4Nk82TmJDVEkzCmh0TmNqb3Z2b1M1NjFMUTlnQVduNjhzQTZ1Zkg3WmVsYzI4MDVNa2pzeC9SV3djeEw5dVk4Uk5QTUM5N3FYQmoKVXRtaE0rL2tqQW1OWERqRXl2Nkh5dU5TblQ0ODhwbVN6OXRmY0pRdjg0Z3pWQUpCQWdNQkFBR2pmREI2TUE0RwpBMVVkRHdFQi93UUVBd0lGb0RBTUJnTlZIUk1CQWY4RUFqQUFNRm9HQTFVZEVRRUIvd1JRTUU2Q0htMWxkR2x6CkxYZGxZbWh2YjJzdVkzQmhZWE10YzNsemRHVnRMbk4yWTRJc2JXVjBhWE10ZDJWaWFHOXZheTVqY0dGaGN5MXoKZVhOMFpXMHVjM1pqTG1Oc2RYTjBaWEl1Ykc5allXd3dEUVlKS29aSWh2Y05BUUVMQlFBRGdnRUJBSXZSOVBFaApIRERabDQzU005UnpBQjEybHFEdk1UQVVsOU0wWjJoQUw3MTUrUFl6R1pySXpVKy81SHVKN0U1bFB4ekEyR01VCkRSOWQwZ2g0NnNja2ZQS0VzRG9yMWYybEVicVd2aDVFMTloanIycCtRMXNOTnE0ZDFZR0RoLytQMkVLUjhOOFgKN0x2RklGOU0ySjN6QWlwUlBRR0NDMkY0dkR0TnNCODBqVFBieDdmMWVPYXZMR3NGU2ltNmZBaHFwVEJXRStPVAo4VVNYdHpjdys0bDI0aGovSTUvOTl5dlJlSXRrVmhQY3NzVktHU2dmb3d1TEkxRVdrWEZXMXFDUDdxSzZzM3RUCnREVjJiV0k3RG9RYmZDNmlhVzB3MGZ0OHZVa01HQnV3QUdqakU3WWtGSkpNV1FlTDdrU1dhMnB5dXdUZWt1aGsKbmc3Qm13SU00SXVUcUZNPQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==
      service:
        name: metis-webhook
        namespace: cpaas-system
        path: /oam/app-validate
        port: 443
    failurePolicy: Fail
    matchPolicy: Equivalent
    name: oamapp.cpaas.io
    namespaceSelector: {}
    objectSelector: {}
    rules:
      - apiGroups:
          - core.oam.dev
        apiVersions:
          - v1beta1
        operations:
          - CREATE
          - UPDATE
        resources:
          - applications
        scope: "*"
    sideEffects: NoneOnDryRun
    timeoutSeconds: 10
```
4. Save and exit the editor.
5. Verify the webhook has been removed:
```bash
kubectl get validatingwebhookconfiguration metis-validation -o yaml | grep oamapp.cpaas.io
```

By carefully following this guide, you can successfully upgrade the OAM Application Cluster Plugin to ensure optimal performance and compatibility with ACP 4.2.

---
kind:
   - Solution
products:
  - Alauda DevOps
ProductsVersion:
   - 4.0,4.1
id: KB251000011
---

# Restricting Docker Image Push Size and Tag Count using the Registry Gateway Plugin

## Introduction \{#introduction}

### What is OCI Registry Gateway

A Registry Gateway for OCI Registry use to limit the image size and tag count. It could provides the limitation ability for the any OCI Registry.

### Features

- **Image Size Limit**: Limit the image size based on the size of the layers.
- **Tag Count Limit**: Limit the number of tags for a repository
- **Global/Path-Specific Limit**: Limit the image size and tag count for all repositories or specific repositories using path-based rules

### Architecture

**Used before Docker Registry**

```
+--------------+         +---------------------+         +------------------+
|  Docker      |  <--->  |  Registry Gateway   |  --->   |  Docker Registry |
|  Client      |         | (Size/Tag Limiter)  |         |                  |
+--------------+         +---------------------+         +------------------+
```

**Used in Harbor**

```
+------------------+
|                  |
|  Docker Client   |
|                  |
+------------------+
         ^
         |
         v
+---------------------------------------------+      +---------------------------------------+
|                 Harbor                      |      |                                       |
|                                             |      |                                       |
|  +-----------------------+                  |      |                                       |
|  |       Core            |------------------+----->|   Registry Gateway (Size/Tag Limiter) |
|  +-----------------------+                  |      |                                       |
|                                             |      |                                       |
|  +-----------------------+                  |      |                                       |
|  |   Docker Registry     |<-----------------+------|                                       |
|  +-----------------------+                  |      |                                       |
+---------------------------------------------+      +---------------------------------------+

```

### Implementation Limitation

- The image size limitation is based on the size of the layers, not the size of the image after decompression.
- The tag count limitation is unstable, especially in concurrent scenarios when the tag count is just about to reach the limit value. But once it exceeds the limit, the limitation will be stable in concurrent scenarios.

### Unsupport "Docker Image Format v1 and Docker Image manifest version 2" formats

- Given that Docker has deprecated the "Docker Image Format v1 and Docker Image manifest version 2" formats, the current Registry Gateway does not support these formats. For more information, please refer to:
  * [OCI Image Manifest](https://github.com/opencontainers/image-spec/blob/v1.0/manifest.md#image-manifest-property-descriptions)
  * [Docker Image Manifest Version 2, Schema 2](https://github.com/distribution/distribution/blob/v2.8.3/docs/spec/manifest-v2-2.md#image-manifest-version-2-schema-2)
  * [Docker Deprecated Schema v1](https://github.com/distribution/distribution/blob/v2.8.3/docs/spec/deprecated-schema-v1.md)
  * [Docker Deprecated Push and Pulling with Image Manifest v2, Schema 1](https://docs.docker.com/engine/deprecated/#pushing-and-pulling-with-image-manifest-v2-schema-1)


## Installing the OCI Registry Gateway Plugin \{#installing-the-oci-registry-gateway-plugin}

### Prerequisites

1.  Prepare an operations machine running Windows, Linux, or macOS that can access the platform. Linux is recommended; the following instructions use Linux as an example.
2.  Ensure the operations machine has network access to the `platform`.
3.  Download the cluster plugin package and save it to your working directory on the operations machine.

:::info
Search for "Registry Gateway" in the Alauda Cloud Marketplace to find the cluster plugin package.
:::

### Obtaining the Upload Tool

Navigate to `Platform Management` -> `Marketplace` -> `Upload Packages` to download the upload tool. After downloading, grant execute permissions to the binary.

### Uploading the Cluster Plugin

> Whether you are importing a new cluster plugin or updating an existing one, you can use the `upload tool` with the same commands.

Run the following command in your working directory:

```bash
./violet push \
    <plugin-package> \
    --platform-address <platform-address> \
    --platform-username <platform-username> \
    --platform-password <platform-password> \
    --clusters <clusters>
```

For more details on the `violet push` command, refer to the [violet push documentation](https://docs.alauda.io/container_platform/4.0/ui/cli_tools/index.html).

### Installing the Cluster Plugin

After uploading the Cluster Plugin, go to `Platform Management` -> `Marketplace` -> `Cluster Plugin`, switch to the target cluster, and deploy the corresponding Cluster Plugin.

The Cluster Plugin has the following configuration parameters:

**Namespace**

The namespace where you want to deploy the registry gateway. Typically, this should match the namespace of your OCI registry deployment.

If you are proxying Harbor, set the namespace to the same one as your Harbor deployment.

**Registry URL**

The upstream registry URL to be proxied. This can be a Kubernetes service address accessible by the registry gateway.

- For Harbor: set the registry URL to the Harbor registry service address, e.g., `http://harbor-registry:5000`.
- For Docker Registry: set the registry URL to the internal Docker Registry address, e.g., `http://docker-registry:5000`.

**Note:** Only HTTP addresses are supported.

**External URL**

The external URL of the registry gateway. This should match the registry URL used for pulling and pushing images to the registry.

- For Harbor: set the external URL to your Harbor's external address, e.g., `https://harbor.example.com`.
- For Docker Registry: set the external URL to your Docker Registry's external address, e.g., `https://docker-registry.example.com`.

### Configuring the Registry Gateway \{#configuring-the-registry-gateway}

#### Setting Image Size and Tag Count Limits \{#setting-image-size-and-tag-count-limits}

After installing the cluster plugin, a ConfigMap named `registry-gateway-config` will be created in the target namespace.

You can configure the registry gateway in two ways:

1. **Global Limits:** Set default limitations that apply to all repositories.
2. **Path-Specific Limits:** Define custom limitations for specific repositories using path-based rules.

Any changes to this ConfigMap are applied immediately.

##### Global Limits \{#global-limits}

To set global image size and tag count limits, specify the following keys in the ConfigMap:

- `max_image_size`: The maximum allowed image size. Supported units: GB, MB, KB, B. Default: 1GB.
- `tag_count_limit`: The maximum number of tags allowed per repository. Default: 1000.

Example:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: registry-gateway-config
data:
  max_image_size: "100MB"      # string value
  tag_count_limit: "100"       # string value
```

All repositories will inherit these global limits unless overridden by a path-specific rule.

##### Path-Specific Limits \{#path-specific-limits}

To define custom limits for specific repositories, add a `rules` entry to the ConfigMap. Each rule consists of a regular expression `path` and a `limit` block specifying the image size and tag count limits.

Example: The following configuration applies different limits to `project-1` and `project-2` repositories.

- The `project-1/` repository is limited to a maximum image size of 20MB and a maximum of 3 tags.
- The `project-2/` repository is limited to a maximum image size of 50MB and a maximum of 10 tags.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: registry-gateway-config
data:
  max_image_size: "100MB"
  tag_count_limit: "100"
  rules: |
    - path: ^project-1/.*
      limit:
        max_image_size: "20MB"
        tag_count_limit: "3"
    - path: ^project-2/.*
      limit:
        max_image_size: "50MB"
        tag_count_limit: "10"
```

The `path` field supports regular expressions. Rules are evaluated in order, and the first matching rule is applied. If no rule matches, the global limits are used.

**Note:** When defining path-specific rules, both `max_image_size` and `tag_count_limit` must be specified for each rule.

##### Additional Examples

- Limit the `project-1/` repository to 20MB and 3 tags.
- Limit the `project-2/big-image/` repository to 5GB and 200 tags.
- Limit the `project-2/` repository to 50MB and 10 tags.
- Apply a default limit of 100MB and 100 tags to all other repositories.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: registry-gateway-config
data:
  max_image_size: "100MB"
  tag_count_limit: "100"
  rules: |
    - path: ^project-1/.*
      limit:
        max_image_size: "20MB"
        tag_count_limit: "3"
    - path: ^project-2/big-image/.*
      limit:
        max_image_size: "5GB"
        tag_count_limit: "200"
    - path: ^project-2/.*
      limit:
        max_image_size: "50MB"
        tag_count_limit: "10"
```

#### Configuring Harbor Authentication \{#configuring-harbor-authentication}

**Note:** If you are proxying Docker Registry, you can skip this step.

If you are proxying Harbor, you must provide Harbor authentication credentials in the Secret `registry-gateway-external-registry-secret`.

The Secret should contain the following keys:

- `username`: Harbor username.
- `password`: Harbor password or robot token.
- `insecure`: Whether to skip certificate verification or use HTTP instead of HTTPS. Default: `false`. Optional value is `true` or `false`.

For example:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: registry-gateway-external-registry-secret
data:
  username: <base64-encoded-harbor-username>
  password: <base64-encoded-harbor-password>
  insecure: <base64-encoded-insecure-flag> # optional
```

It is recommended to use a Harbor robot account to generate this secret. The robot account must have `repository:pull` and `tag:list` permissions.

After updating the authentication Secret, restart the `registry-gateway-gateway` pod for the changes to take effect:

```bash
kubectl scale deployment registry-gateway-gateway --replicas=0 -n <namespace>
kubectl scale deployment registry-gateway-gateway --replicas=1 -n <namespace>
```

#### Changing the Harbor Registry URL in Harbor Core \{#changing-the-harbor-registry-url-in-harbor-core}

**Note:** If you are proxying Docker Registry, you can skip this step.

If you are proxying Harbor, update the Harbor registry address in the Harbor Core ConfigMap to point to the registry gateway service address:

```bash
kubectl patch configmap harbor-core -n <namespace> --type=strategic -p '{"data": {"REGISTRY_URL": "http://registry-gateway-service:5000"}}'
```

If you are using the Alauda Build of Harbor, add the annotation `skip-sync: "true"` to the Harbor Core ConfigMap to prevent the operator from reverting your changes:

```bash
kubectl patch configmap harbor-core -n <namespace> --type=strategic -p '{"metadata": {"annotations": {"skip-sync": "true"}}}'
```

After updating the registry address, restart the Harbor Core pod for the changes to take effect:

```bash
kubectl scale deployment harbor-core --replicas=0 -n <namespace>
kubectl scale deployment harbor-core --replicas=1 -n <namespace>
```

### Uninstalling the Cluster Plugin \{#uninstalling-the-cluster-plugin}

To uninstall the cluster plugin, navigate to **Platform Management** → **Marketplace** → **Cluster Plugin**, switch to the target cluster, and uninstall the corresponding Cluster Plugin.

:::warning
By default, uninstalling the Cluster Plugin will also delete the `registry-gateway-config` ConfigMap and the `registry-gateway-external-registry-secret` Secret.

If you are using the Alauda Platform, a `ResourcePatch` resource is created whenever you modify the `registry-gateway-config` ConfigMap or the `registry-gateway-external-registry-secret` Secret.

Uninstalling the Cluster Plugin does **not** remove the `ResourcePatch` resource. When you reinstall the Cluster Plugin, any existing `ResourcePatch` resources will be automatically applied to the `registry-gateway-config` ConfigMap and the `registry-gateway-external-registry-secret` Secret.

If you are **not** using resource patches, remember to back up these resources before uninstalling the Cluster Plugin.
:::

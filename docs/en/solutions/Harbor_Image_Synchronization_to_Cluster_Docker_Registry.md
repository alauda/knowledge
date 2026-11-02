---
id: KB250600014
products: 
   - Alauda Container Platform
   - Alauda DevOps
kind:
   - Solution
---
# Harbor Image Synchronization to Cluster Docker Registry

This guide explains how to configure Harbor replication rules to automatically synchronize images from Harbor to Docker registries in clusters when new images are pushed.

## Prerequisites

- A running Harbor service
- Docker client or other image management tools installed locally for pushing images to Harbor
- A Kubernetes cluster with a Docker registry deployed
- Kubectl installed locally and configured to access the Kubernetes cluster

## Overview

**Key Configurations in Harbor**

- **Registry Endpoint**: Add target Docker registry information to Harbor
- **Replication Rule**: Define which images to sync and the synchronization path

**Process Overview**

| Step | Operation | Description |
|------|-----------|-------------|
| 1 | Configure Registry Endpoint | Add target cluster registry endpoint to Harbor |
| 2 | Configure Replication Rule | Define image synchronization policies |
| 3 | Verify Image Synchronization | Test the synchronization workflow |

## Configuration Steps

### Step 1: Configure Registry Endpoint in Harbor

First, configure the target Docker registry information in Harbor using the `Registry Endpoint` feature.

1. Log into Harbor and navigate to **Administration > Registries**
2. Click **NEW ENDPOINT** and configure the following:

- **Provider**: Select your registry type. For this example, choose `Docker Registry`
- **Name**: Provide a descriptive name for your target registry. We recommend using the format `<cluster-name>-registry` for easy identification in this example.
- **Endpoint URL**: Enter your registry URL (e.g., `https://cluster1-registry.example.com`)
- **Access ID**: Username with `Push/Delete` permissions for the target registry
- **Access Secret**: Password for the above user
- **Verify Remote Cert**: Determines whether to verify the remote registry's certificate. Uncheck for self-signed or untrusted certificates

3. Click **TEST CONNECTION** to verify configuration and network connectivity
4. Click **OK** to save the configuration

### Step 2: Configure Replication Rule in Harbor

Next, configure a replication rule to define how Harbor synchronizes images to the target registry.

1. Navigate to **Administration > Replications**
2. Click **NEW REPLICATION RULE** and configure:

**Basic Settings**

- **Name**: Use a descriptive name like `<cluster-name>-registry-replication`
- **Replication mode**: Select `Push-based` to trigger sync when images are pushed to Harbor

**Source Resource Filter**

Configure filters to identify which artifacts to replicate:

- **Name**: Filter by resource name. Leave empty or use `**` to match all. For this example, leave empty to sync all repositories
- **Tag**: Filter by tag/version. Leave empty or use `**` to match all tags. For this example, leave empty to sync all tags
- **Label**: Filter by artifact labels. Leave empty to match all artifacts. For this example, leave empty to sync all artifacts
- **Resource**: Filter the type of resources. For this example, select `ALL` to sync all artifact types

**Destination**

Define the sync target and path structure:

- **Destination registry**: Select the registry endpoint configured in Step 1
- **Namespace**: The name of the namespace in which to replicate resources. If empty, the resources will be put under the same namespace as the source. For this example, leave empty to use the same namespace as the source
- **Flattening**: Reduce the nested repository structure when copying images. Leave empty to preserve the original image hierarchy

**Additional Settings**
- **Trigger Mode**: Decide how to trigger the sync. Select `Event Based` to trigger sync on Harbor push events for this example
  - Check "Delete remote resources when locally deleted" if you want deletions in Harbor to propagate to the target registry
- **Bandwidth**: Set maximum network bandwidth per replication worker (use -1 for unlimited)
- **Options**:
  - Check `Override` to overwrite existing resources at the destination
  - Check `Enable rule` to activate the replication rule

### Step 3: Verify Image Synchronization

**Push an Image to Harbor**

Push an image to Harbor to trigger the sync:

```bash
docker pull alpine:latest
docker tag alpine:latest <your-harbor-address>/library/alpine:latest
docker push <your-harbor-address>/library/alpine:latest
```

**Monitor Synchronization Job in Harbor**

1. In Harbor, navigate to **Administration > Replications**
2. Select your newly created replication rule to see the automatically triggered sync job
3. Click on the execution record to view detailed information

**Verify Synchronization Results**

Create a pod in the target cluster to test that the image was successfully synchronized:

```bash
kubectl run alpine-test --image=<your-cluster-registry-address>/library/alpine:latest -- sleep 3600
```

If the pod starts successfully, the synchronization is working correctly.

## Summary

This configuration establishes automatic image synchronization from Harbor to cluster registries, maintaining consistent image paths and enabling seamless deployment workflows across your infrastructure. The push-based replication ensures that images are available in target registries immediately after being pushed to Harbor.

## References

- [Harbor Replication](https://goharbor.io/docs/2.12.0/administration/configuring-replication/)

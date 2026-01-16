---
products:
   - Alauda DevOps
kind:
   - Solution
id: KB260100010
---

# Kube Event Enricher Installation Guide

This guide provides step-by-step instructions for installing and configuring the Kube Event Enricher Sink  in your Kubernetes cluster.

## Prerequisites

Before installing the Kube Event Enricher Sink , ensure you have:

- A Kubernetes cluster (v1.33 or later recommended)
- [Knative Eventing](https://knative.dev/docs/install/) installed
- `kubectl` configured to access your cluster
- Sufficient permissions to create namespaces, deployments, and RBAC resources

## Offline Package Preparation

This section describes how to prepare the installation package for air-gapped or offline environments.

### Required Materials

The following components are required for installation:

- Manifest YAML files for kubeevent-enricher deployment
- Container images for kubeevent-enricher-sink

### Downloading the Offline Installation Package

Download the installation package from AlaudaCloud to your working directory:

```bash
export DOWNLOAD_URL=https://xxx.xx/kubeveent-enricher.tar.gz

mkdir kubeevent-enricher
cd kubeevent-enricher
wget ${DOWNLOAD_URL}
tar -xvzf ./kubeevent-enricher.tar.gz
```

### Uploading Images to Cluster Registry

Based on your cluster architecture, upload the container images to your cluster's image registry and update the registry references in the manifest.

```bash
# Set your cluster registry address
export CLUSTER_REGISTRY={change-to-your-cluster-registry}

# Load the image archive
podman load -i ./dist/kubeevent-enricher-sink-amd64.image.tar

# Tag the image for your cluster registry
podman tag build-harbor.alauda.cn/devops/kubeevent-enricher-sink/enricher:xxx ${CLUSTER_REGISTRY}/devops/kubeevent-enricher-sink/enricher:xxx

# Push to your cluster registry
podman push ${CLUSTER_REGISTRY}/devops/kubeevent-enricher-sink/enricher:xxx

# Update the manifest with your registry address
# Note: On macOS, sed requires a space between -i and the backup extension
# Use: sed -i '' "s/..." (with space) on macOS
# Use: sed -i "s/..." (without '') on Linux
sed -i'' "s/registry.alauda.cn:60070/${CLUSTER_REGISTRY}/g" dist/install.yaml
```

**Note**: All subsequent commands in this guide assume you are working from the `kubeevent-enricher` directory.

## Installation

### Using Released Manifest

Apply the released installation manifest:

```bash
kubectl apply -f dist/install.yaml
```

### Verify Installation

Check that the deployment is running:

```bash
# Check deployment status
kubectl -n kubeevent-enricher rollout status deploy/kubeevent-enricher-sink

# Verify pods are running
kubectl -n kubeevent-enricher get pods

```

## Configuration

The Kube Event Enricher Sink  is configured via command-line flags in the deployment manifest.
you can modify these flags by editing the `kubeevent-enricher-sink` deployment in `dist/install.yaml` file before applying it or by updating the  `kubeevent-enricher-sink` deployment in the `kubeevent-enricher` namespace after installation.

### Available Flags

| Flag | Description | Default Value | Required |
|------|-------------|---------------|----------|
| `--broker-ingress` | Knative Broker ingress URL to send enriched events to. The enricher constructs the full broker URL as `<broker-ingress>/<namespace>/<broker-name>` | `http://broker-ingress.knative-operators.svc.cluster.local` | No |
| `--log-level` | Log level for the application. Valid values: `debug`, `info`, `warn`, `error` | `info` | No |
| `--event-type-prefix` | Prefix to add to the CloudEvent type attribute. The final type will be `<prefix>.<kind>.<reason>.v1alpha1` | `dev.katanomi.cloudevents.kubeevent` | No |

## Uninstallation

To remove the Kube Event Enricher Sink  from your cluster:

```bash
kubectl delete -f dist/install.yaml
```

## Troubleshooting

### Check Service Status

```bash
# View deployment details
kubectl -n kubeevent-enricher describe deploy kubeevent-enricher-sink

# View pod logs
kubectl -n kubeevent-enricher logs -l app=kubeevent-enricher-sink --tail=100
```

### Common Issues

**Issue**: Pods fail to start with "ImagePullBackOff"
- **Solution**: Ensure your cluster has access to the container registry. Check image pull secrets if using a private registry.

**Issue**: Events are not being enriched
- **Solution**:
  - Verify the APIServerSource is correctly configured to send to the enricher service
  - Check that the enricher has proper RBAC permissions to read the involved resources
  - Review enricher logs for error messages

**Issue**: Events not reaching the broker
- **Solution**:
  - Verify the `--broker-ingress` flag points to the correct broker ingress service
  - Check network policies allow traffic from the enricher namespace to the broker
  - Ensure the broker exists in the target namespace

## Next Steps

After installation, refer to the following documentation:

- [Artifact Promotion Notifications](ArtifactPromotionRun_Approval_Notification_with_CorpWeChat.md) - Implement artifact promotion scenario notifications using Kube Event Enricher

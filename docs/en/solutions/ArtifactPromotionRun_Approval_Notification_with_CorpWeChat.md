---
products:
   - Alauda DevOps
kind:
   - Solution
---

# ArtifactPromotionRun Approval Event Notification with CorpWeChat

## Overview

This guide demonstrates how to use **Kube Event Enricher** to enable personalized subscriptions to artifact promotion approval events and deliver notifications via CorpWeChat.

### Architecture Flow

```text
K8s Events (ArtifactPromotionRun)
    ↓
APIServerSource (Watches Event resources)
    ↓
Kube Event Enricher Sink (Enriches event data)
    ↓
Knative Broker (Event distribution)
    ↓
ClusterSubscription (Personal subscription + CloudEvent filtering)
    ↓
CorpWeChat Notification Service (Katanomi Plugin)
```

### Supported Event Types

| Event Type | CloudEvent Type | Trigger Scenario | Notification Recipients |
|---------|----------------|----------|---------|
| Approval Pending | `dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvalpending.v1alpha1` | Artifact promotion request pending approval | Approvers |
| Approval Denied | `dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvaldenied.v1alpha1` | Promotion request has been rejected | Requester |
| Approval Approved | `dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.running.v1alpha1` | Promotion request approved and now executing | Requester |
| Promotion Failed | `dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.failed.v1alpha1` | Promotion operation has failed | Requester |

---

## Prerequisites

ACP Version Requirement: >= 4.0

### Required Components

Before proceeding, ensure the following components are installed and configured:

- **Alauda DevOps v3**: Provides ArtifactPromotion and subscription/notification capabilities
- **Knative Eventing**: Supplies Broker and Trigger mechanisms for event routing, deployed in ACP Global
- **Kube Event Enricher Sink**: Event enrichment service (installed in this guide), deployed in ACP Global

### Permission Requirements

- **System Administrator**: Responsible for infrastructure setup and notification template configuration
- **Project Administrator/Developer**: Configures personal subscriptions for team members and individual users

---

## Offline Package Preparation

This section describes the required materials for deploying artifact promotion notifications in offline environments.

### Required Materials

The following components are required:

- Kube Event Enricher Sink deployment manifests and container images
- Artifact promotion notification template YAML files

### Downloading and Preparing the Installation Package

For downloading the offline installation package and uploading container images to your cluster registry, refer to the **[Offline Package Preparation](./ArtifactPromotionRun_Approval_Notification_with_CorpWeChat_Install_kubeevent-enricher.html#offline-package-preparation)** section in the Installation Guide.

**Note**: All subsequent commands in this guide assume you are working from the `kubeevent-enricher` directory.

## Setup Overview

This solution consists of two phases: **System Configuration** (one-time) and **User Configuration** (on-demand).

---

## System Configuration

### 1.1 Deploy Kube Event Enricher Sink

Refer to the [Kube Event Enricher Sink Installation Guide](ArtifactPromotionRun_Approval_Notification_with_CorpWeChat_Install_kubeevent-enricher.md) for deployment instructions.

### 1.2 Create APIServerSource to Watch Kubernetes Events

Create a dedicated namespace and deploy an APIServerSource to watch all Kubernetes Events:

```bash
# Create watcher namespace
kubectl create namespace kubeevent-watcher

# Create APIServerSource and RBAC configuration
cat <<EOF | kubectl apply -f -
apiVersion: sources.knative.dev/v1
kind: ApiServerSource
metadata:
  name: kubeevent-watcher
  namespace: kubeevent-watcher
spec:
  resources:
  - apiVersion: v1
    kind: Event
  mode: Resource
  serviceAccountName: kubeevent-watcher-sa
  namespaceSelector:
    matchExpressions:
    - key: cpaas.io/inner-namespace # Watches all ACP Project namespaces
      operator: Exists
  sink:
    ref:
      apiVersion: v1
      kind: Service
      name: kubeevent-enricher-sink
      namespace: kubeevent-enricher
    uri: "?broker=cloudevents-katanomi-dev" # Target Knative Broker in Cluster, cloudevents-katanomi-dev is the default Broker name that receives events by ClusterSubscription
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kubeevent-watcher-sa
  namespace: kubeevent-watcher
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubeevent-watcher
rules:
- apiGroups: [""]
  resources: ["events"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeevent-watcher
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kubeevent-watcher
subjects:
- kind: ServiceAccount
  name: kubeevent-watcher-sa
  namespace: kubeevent-watcher
EOF
```

For more information about `ApiServerSource`, refer to the [Knative Eventing ApiServerSource documentation](https://knative.dev/docs/eventing/sources/apiserversource/getting-started/).

### 1.3 Configure CorpWeChat Notification Server

Configure the ACP notification server for CorpWeChat integration. Refer to the ACP documentation for detailed parameter descriptions.

Replace the placeholder values with your CorpWeChat credentials:

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
stringData:
  displayNameEn: xx
  displayNameZh: xx
  corpId: <BASE64_ENCODED_CORP_ID>
  corpSecret: <BASE64_ENCODED_CORP_SECRET>
  agentId: <BASE64_ENCODED_AGENT_ID>
kind: Secret
metadata:
  labels:
    cpaas.io/notification.server.category: Corp
    cpaas.io/notification.server.type: CorpWeChat
  name: platform-corpwechat-server
  namespace: cpaas-system
type: NotificationServer
EOF
```

The WeChat Work corpId, corpSecret, agentId acquisition methods can be referenced in the official documentation: https://developer.work.weixin.qq.com/document/path/90665

### 1.4 Create Notification Templates

Create notification templates for artifact promotion events:

```bash
export PLATFORM_URL=xx # Set to ACP platform URL
cat dist/kubeevent.artifactpromotionrun.template.yaml | envsubst | kubectl apply -f -
```

This manifest contains four NotificationTemplate resources:
- `kubeevent.artifactpromotionrun.approvalpending` - Approval Pending
- `kubeevent.artifactpromotionrun.approvaldenied` - Approval Denied
- `kubeevent.artifactpromotionrun.running` - Approval Approved/Executing
- `kubeevent.artifactpromotionrun.failed` - Promotion Failed

### 1.5 Update Katanomi Platform Configuration

Update the Katanomi configuration to enable the CorpWeChat notification channel and associate notification templates in the ACP Global Cluster:

```bash
cat <<EOF | kubectl patch configmap katanomi-config -n cpaas-system --patch-file /dev/stdin
data:
  # CorpWeChat notification address
  cloudeventsDelivery.sinkPluginAddress.corpwechat: http://katanomi-plugin.cpaas-system.svc/plugins/v1alpha1/notifications/corpwechat

  # Notification plugin types
  cloudeventsDelivery.sinkPluginclasses: |
    - corpwechat

  # Configure plugin type mapping
  cloudeventsDelivery.sinkPluginclassesConfig: |
    - pluginClass: corpwechat
      aitMethod: CorpWeChat

  # Configure event type to notification template mapping
  notification.templates: |
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvalpending.v1alpha1"
      templateRef:
        name: kubeevent.artifactpromotionrun.approvalpending
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvaldenied.v1alpha1"
      templateRef:
        name: kubeevent.artifactpromotionrun.approvaldenied
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.running.v1alpha1"
      templateRef:
        name: kubeevent.artifactpromotionrun.running
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.failed.v1alpha1"
      templateRef:
        name: kubeevent.artifactpromotionrun.failed
EOF
```

---

## User Configuration

This section is performed by project administrators or individual users.

### 2.1 Configure User CorpWeChat ID in ACP Platform

Obtain the user's CorpWeChat ID from your CorpWeChat administrator, then configure it in the ACP platform:
- Navigate to **Administrator → Users → Users** (for administrators)
- Or update in personal profile settings (for individual users)

### 2.2 Create Personal Subscription

Create a `ClusterSubscription` resource for each user who needs to receive notifications. This resource allows you to:
- Define subscriber information
- Specify event types to subscribe to with filtering criteria
- Configure notification channels (e.g., CorpWeChat)

#### Example: Create subscription for user `admin`

```bash
cat <<EOF | kubectl apply -f -
kind: ClusterSubscription
apiVersion: core.katanomi.dev/v1alpha1
metadata:
  name: "admin-artifactpromotionrun-subscription"
  annotations:
    # Specifies notification channel: CorpWeChat
    "core.katanomi.dev/sink.pluginclasses": "corpwechat"
    # User ownership annotation, must match spec.subscriber.name
    katanomi.dev/owned.username: "admin"
spec:
  subscriber:
    # Subscriber information
    apiGroup: rbac.authorization.k8s.io
    kind: User
    name: admin
    info:
      # ACP User ID
      id: 21232f297a57a5a743894a0e4a801fc3
      # ACP User Email
      mail: admin@example.com

  subscriptions:
  - object:
      # Subscribed resource type
      kind: ArtifactPromotionRun
      apiVersion: artifacts.katanomi.dev/v1alpha1
      namespace: "devops"  # Subscribe to this namespace

    events:
    # 1. Approval pending event: for approvers
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvalpending.v1alpha1"
      filter:
        exact:
          involvedobjectkind: ArtifactPromotionRun
          involvedobjectgroup: artifacts.katanomi.dev
        # CEL expression: notifies only if the subscriber is an approver
        cel: |
          ce.data.object.status.artifactPromotionSpec.approvalSpec.users.exists(item, item.name == "\$(subscriber.name)")

    # 2. Approval denied event: for requester
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvaldenied.v1alpha1"
      filter:
        exact:
          involvedobjectkind: ArtifactPromotionRun
          involvedobjectgroup: artifacts.katanomi.dev
        # CEL expression: notifies only if the subscriber is the requester
        cel: |
          ce.data.object.status.triggeredBy.user.name == "\$(subscriber.name)"

    # 3. Approval approved event: for requester
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.running.v1alpha1"
      filter:
        exact:
          involvedobjectkind: ArtifactPromotionRun
          involvedobjectgroup: artifacts.katanomi.dev
        # CEL expression: notifies on first running event only if the subscriber is the requester
        cel: |
          !has(ce.data.event.message) && ce.data.object.status.triggeredBy.user.name == "\$(subscriber.name)"

    # 4. Promotion failed event: for requester
    - type: "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.failed.v1alpha1"
      filter:
        exact:
          involvedobjectkind: ArtifactPromotionRun
          involvedobjectgroup: artifacts.katanomi.dev
        # CEL expression: notifies only if the subscriber is the requester
        cel: |
          ce.data.object.status.triggeredBy.user.name == "\$(subscriber.name)"
EOF
```

#### Required Parameter Customization

Customize the following parameters for each user:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `metadata.name` | Unique resource name identifying the subscription | `admin-artifactpromotionrun-subscription` |
| `metadata.annotations["katanomi.dev/owned.username"]` | Username of the notification recipient (must match `spec.subscriber.name`) | `admin` |
| `spec.subscriber.name` | Kubernetes username of the subscriber | `admin` |
| `spec.subscriber.info.id` | ACP user ID, retrieve via: `kubectl get users` and filter by `{subscriber.name}`  | `21232f297a57a5a743894a0e4a801fc3` |
| `spec.subscriber.info.mail` | User email address | `admin@example.com` |
| `spec.subscriptions[].object.namespace` | Namespace to subscribe to for events | `devops` |

**Note**: Create a separate `ClusterSubscription` for each user. For detailed configuration options, refer to the [Advanced Configuration](#advanced-configuration-and-references) section.

## Verification and Testing

### 3.1 Verify Resource Status

```bash
# 1. Check APIServerSource status
kubectl -n kubeevent-watcher get apiserversource

# 2. Check ClusterSubscription status
kubectl get clustersubscription -A
```

### 3.2 Test with ArtifactPromotionRun

Use ACP DevOps v3 to create artifact promotion policies and initiate a promotion request to trigger notifications.

### 3.3 Expected Notification Behavior

When an artifact promotion workflow is triggered, users should receive notifications according to the following timeline:

- **Approval Pending**: Approvers receive notifications when a promotion request awaits approval
- **Approval Denied**: Requesters receive notifications when their promotion request is rejected
- **Approval Approved**: Requesters receive notifications when their promotion request is approved and execution begins
- **Promotion Failed**: Requesters receive notifications if the promotion operation fails

## Troubleshooting

### Not Receiving CorpWeChat Notifications

If users are not receiving notifications, follow these troubleshooting steps:

1. **Verify CorpWeChat server configuration**:
   ```bash
   kubectl get secret -n cpaas-system platform-corpwechat-server -o yaml
   ```
   Ensure all credentials are correctly configured.

2. **Confirm user CorpWeChat ID**:
   Verify that the user's CorpWeChat ID is correctly configured in the ACP platform.

3. **Check ClusterSubscription status**:
   ```bash
   kubectl get clustersubscription <subscription-name> -o yaml
   ```
   Ensure `sink.pluginclasses` annotation contains `corpwechat` and the status shows `Ready`.

4. **Review kubeevent-enricher-sink logs**:
   ```bash
   kubectl -n kubeevent-enricher logs -l app=kubeevent-enricher-sink --tail=100
   ```

5. **Review katanomi-plugin logs**:
   ```bash
   kubectl -n cpaas-system logs -l control-plane=katanomi-plugin --tail=100
   ```


---

## Advanced Configuration and References

### Subscribing to Multiple Namespaces

To subscribe a single user to promotion events across multiple namespaces, add multiple subscription entries:

```bash
kubectl apply -f - <<EOF
kind: ClusterSubscription
metadata:
  name: user1-subscription
spec:
  subscriptions:
  - object:
      kind: ArtifactPromotionRun
      apiVersion: artifacts.katanomi.dev/v1alpha1
      namespace: "devops-1"
    events:
      # . . .
  - object:
      kind: ArtifactPromotionRun
      apiVersion: artifacts.katanomi.dev/v1alpha1
      namespace: "devops-2"
    events:
      # . . .
EOF
```

### Customizing Notification Templates

To modify the content of notification templates, edit the existing template resources:

```bash
# Edit the approval pending template
kubectl edit notificationtemplate -n cpaas-system kubeevent.artifactpromotionrun.approvalpending
```

The data structure sent to notification templates follows the CloudEvents format described in [CloudEvents Data Structure](#cloudevents-data-structure).

### ClusterSubscription Configuration Guide

#### Key Field Descriptions

| Field | Description | Example |
|-------|-------------|---------|
| `metadata.annotations["core.katanomi.dev/sink.pluginclasses"]` | Notification channels (supports multiple comma-separated values) | `"wechat,corpwechat,email"` |
| `spec.subscriber.name` | Kubernetes username of the subscriber | `admin` |
| `spec.subscriber.info.id` | Unique ACP user ID (retrieve via: `kubectl get users` and filter by `{subscriber.name}` in ACP Global Cluster) | `21232f297a57a5a743894a0e4a801fc3` |
| `spec.subscriber.info.mail` | User email address | `admin@example.com` |
| `subscriptions[].object.namespace` | Target namespace for event subscriptions | `devops` |
| `subscriptions[].events[].filter.cel` | CEL filter expression for precise event filtering. Use `ce.data` to access CloudEvent data fields | See examples below |

#### CEL Filter Expression Examples

```text
# Scenario 1: Subscriber is an approver
ce.data.object.status.artifactPromotionSpec.approvalSpec.users.exists(item, item.name == "$(subscriber.name)")

# Scenario 2: Subscriber is the requester
ce.data.object.status.triggeredBy.user.name == "$(subscriber.name)"
```

### CloudEvents Data Structure

The following example shows the structure of CloudEvents emitted by Kube Event Enricher:

```json
{
  "specversion": "1.0",
  "type": "dev.katanomi.cloudevents.kubeevent.artifactpromotionrun.approvalpending.v1alpha1",
  "source": "/apis/artifacts.katanomi.dev/v1alpha1/namespaces/default/artifactpromotionrun/my-promotion/",
  "id": "abc-123",
  "involvedobjectgroup": "artifacts.katanomi.dev",
  "involvedobjectversion": "v1alpha1",
  "involvedobjectkind": "ArtifactPromotionRun",
  "involvedobjectname": "my-promotion",
  "involvedobjectnamespace": "default",
  "eventreason": "approvalpending",
  "eventtype": "Normal",
  "data": {
    "event": { /* Original K8s Event */ },
    "object": { /* Complete ArtifactPromotionRun CR */ }
  }
}
```

This data structure can be used to:
- Filter CloudEvents in `ClusterSubscription` resources using CEL expressions
- Render dynamic content in notification templates

## References

- [Knative Eventing Documentation](https://knative.dev/docs/eventing/)
- [CEL Expression Syntax](https://github.com/google/cel-spec)

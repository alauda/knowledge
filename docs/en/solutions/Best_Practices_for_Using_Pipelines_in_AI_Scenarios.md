# Best Practices for Using Pipelines in AI Scenarios

This document introduces advanced usage and best practices for using pipelines in AI scenarios. This assumes users have deployed `Alauda DevOps Pipelines`.

## Triggering Pipelines from GitLab

In Alauda AI, models and datasets are stored in GitLab. This section explains how to configure Tekton and GitLab to automatically trigger a pipeline execution when code is pushed to GitLab.

### Creating an EventListener

Create an EventListener in the namespace where the pipeline is located. Refer to the following YAML:

> **Note**: In all the example YAML files below, `metadata.name` and `metadata.namespace` can be replaced as needed.

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata:
  name: demo
  namespace: demo-namespace
spec:
  namespaceSelector: {}
  resources: {}
  serviceAccountName: default
  triggers:
  - triggerRef: demo
```

#### Configuring EventListener Permissions

Tekton creates a Deployment for the EventListener to receive and process events. Configure permissions for the ServiceAccount of this Deployment.

**Create a RoleBinding to grant permissions in the current namespace**, as follows:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: eventlistener
  namespace: demo-namespace
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: tekton-triggers-eventlistener-roles
subjects:
- kind: ServiceAccount
  name: default
  namespace: demo-namespace
```

**Create a ClusterRoleBinding to grant cluster resource view permissions**, as follows:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: tekton-triggers-aggregate-view:demo-namespace:default
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: tekton-triggers-aggregate-view
subjects:
- kind: ServiceAccount
  name: default
  namespace: demo-namespace
```

#### Configuring External Access Address for EventListener

Tekton creates a Service for the EventListener to receive requests, but this Service is of type `ClusterIP` and can only be accessed within the cluster. To access it from outside the cluster, create a Service with external access or provide an access entry through Ingress or other methods. The following example creates a `LoadBalancer` Service to obtain an external access address:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: demo
  namespace: demo-namespace
spec:
  ports:
  - name: http-listener
    port: 8080
    protocol: TCP
    targetPort: 8080
  selector:
    app.kubernetes.io/managed-by: EventListener
    app.kubernetes.io/part-of: Triggers
    eventlistener: demo                                # Value is the name of the EventListener
  type: LoadBalancer
```

### Creating a Trigger

In the `Alauda Container Platform` view, navigate to the corresponding namespace, then select `Pipelines / Triggers` in the left navigation, and click the `Create` button on the right side of the page.

In the pop-up dialog:

- In the `Basic Info` tab, fill in `demo` in the `Name` field, which should match the name of `triggerRef` in the EventListener
- In the `Interceptors` tab, select `gitlab-push` in the `Event` field
- In the `Pipeline` tab, select the pipeline name to trigger in the `Pipeline` field
  - In `Parameters`, configure the trigger parameters for the pipeline
  - Use `$(tt.params.xxx)` to reference relevant information from GitLab events. Example values:
    - `$(tt.params.git-repo-name)` represents the name of the GitLab repository
    - `$(tt.params.git-revision)` represents the branch or tag of the Git commit
    - `$(tt.params.git-commit-sha)` represents the SHA value of the Git commit
    - View all available parameters by checking the `ClusterTriggerBinding` resource `gitlab-push`

### Enhancing Trigger Security

To enhance Trigger security, configure interceptors in the Trigger to verify the authenticity of Webhook events.

#### Configuring GitLab Interceptor

Update the newly created Trigger by switching to YAML mode and adding `spec.interceptors` as follows:

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: Trigger
metadata:
  name: demo
  namespace: demo-namespace
spec:
  ......
  interceptors:
  - params:
    - name: secretRef
      value:
        secretKey: webhook.secret
        secretName: gitlab-webhook-config
    ref:
      kind: ClusterInterceptor
      name: gitlab
  ......
```

The above YAML shows that an interceptor has been added to the Trigger, which references the `ClusterInterceptor` named `gitlab` and configures the `secretRef` parameter to verify the Webhook secret.

#### Creating Secret

Create a Secret named `gitlab-webhook-config` that includes the `webhook.secret` field. Refer to the following:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: gitlab-webhook-config
  namespace: demo-namespace
data:
  webhook.secret: ......                  # Base64 encoded secret value
type: Opaque
```

The value of `webhook.secret` can be set arbitrarily, and the same value needs to be configured in GitLab's Webhook later for verification.

### Configuring GitLab Webhook

In GitLab project settings, go to Webhooks and add a webhook configuration:

- Fill in the external access address of the EventListener in the Webhook URL
- Select `Push events` in the Webhook Trigger
- Fill in the original value of `webhook.secret` from the `gitlab-webhook-config` Secret in the Webhook `Secret token` (must match the value configured in the Secret)

After the above configuration, when code is pushed to GitLab, the EventListener will receive the event and execute the configured pipeline.

## Triggering Another Pipeline from a Pipeline

In some scenarios, pipelines need to work together. For example, after a model training pipeline completes, it can trigger another pipeline for model quality evaluation. There are two methods to achieve this goal, which will be described in detail below.

### Method 1: Creating PipelineRun in Pipeline Task to Execute another Pipeline

Add a `kubectl` Task to the previous pipeline. The content of this Task is to create a PipelineRun resource. A PipelineRun represents the execution of a pipeline. After this resource is created, Tekton will start the corresponding pipeline.

The disadvantage of this method is that the two pipelines are tightly coupled. If the downstream pipeline has parameter changes, or the upstream pipeline needs to start another pipeline, the upstream pipeline content needs to be modified.

### Method 2: Triggering Pipeline Through Custom Events

To understand this method, some basic concepts of Tekton need to be introduced:

- **EventListener**: An event listener that receives and processes events, as introduced above
- **Event**: In Tekton, an Event can be understood as an HTTP request with an arbitrary JSON body
- **TriggerBinding / ClusterTriggerBinding**: Extracts valid information from Event requests by extracting content from the Body as parameters for reference when the pipeline executes. The content of the `ClusterTriggerBinding` `gitlab-push` mentioned above is as follows:

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: ClusterTriggerBinding
metadata:
  name: gitlab-push
spec:
  params:
  - name: project-id
    value: $(body.project.id)
  - name: project-name
    value: $(body.project.name)
  - name: project-path
    value: $(body.project.path_with_namespace)
  ......
```

- **Interceptor / ClusterInterceptor**: An interceptor responsible for filtering and judging events to prevent illegal or unwanted events from triggering pipeline execution
- **Trigger**: Responsible for associating events, interceptors, and pipelines

After understanding the above, define custom events and use Tekton's Trigger mechanism to handle the relationship between pipelines.

Taking model training as an example:

**Step 1: Define the Model Training Completion Event**

Define a model training completion event in the following JSON format:

```json
{
    "model_type": "xxx",
    "model_name": "demo-model",
    "model_output_url": "http://xxx.xxx.xxx.xxx/xxx"
}
```

**Step 2: Create the Corresponding TriggerBinding**

The TriggerBinding configuration is as follows:

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: model-output
  namespace: demo-namespace
spec:
  params:
  - name: model-type
    value: $(body.model_type)
  - name: model-name
    value: $(body.model_name)
  - name: model-url
    value: $(body.model_output_url)
```

**Step 3: Create a Trigger to Use the Custom TriggerBinding**

The following example also shows how to use the `CEL` ClusterInterceptor to filter events:

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: Trigger
metadata:
  name: model-output
  namespace: demo-namespace
spec:
  bindings:
  - kind: TriggerBinding
    ref: model-output
  interceptors:
  - ref:
      kind: ClusterInterceptor
      name: cel
    params:
    - name: filter
      value: 'body.model_type == "llm"'                # triggers only when model_type is "llm"
  template:
    spec:
      params:
      - name: model-type
      - name: model-name
      - name: model-url
      resourcetemplates:
      - apiVersion: tekton.dev/v1
        kind: PipelineRun
        metadata:
          generateName: next-pipeline-
        spec:
          params:
            - name: MODEL_URL
              value: $(tt.params.model-url)
          pipelineRef:
            name: next-pipeline
```

**Step 4: Modify the EventListener Configuration**

Add the following under `spec.triggers` in the EventListener:

```yaml
- triggerRef: model-output
```

**Step 5: Send Events to Trigger Downstream Pipelines**

Send events to the EventListener's Service address in the upstream pipeline to trigger downstream pipeline execution.

Use curl to send a request to verify that the configuration is correct. If correct, the pipeline `next-pipeline` will start executing:

```bash
curl -X POST http://el-demo -H "Content-Type: application/json" \
  -d '{"model_type": "llm", "model_name": "demo-model", "model_output_url": "http://a.b.c.d/xxx"}'
```

With this method, after defining the event format, the upstream pipeline only needs to send events according to the convention and no longer needs to care about the subsequent processing flow of events. Event handling can be configured by adjusting the EventListener and Trigger configuration.

## Storing Pipelines in Code Repositories

Pipeline As Code (PAC) is a method provided by the Tekton community to store pipelines in code repositories. It solves the version inconsistency problem that may occur when pipelines and code are stored separately.

### Installing PAC

Create the following resources:

```yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: pipelines-as-code
---
apiVersion: operator.tekton.dev/v1alpha1
kind: OpenShiftPipelinesAsCode
metadata:
  name: pipelines-as-code
spec:
  settings:
    application-name: Pipelines as Code CI
    auto-configure-new-github-repo: "false"
    bitbucket-cloud-check-source-ip: "true"
    custom-console-name: ""
    custom-console-url: ""
    custom-console-url-namespace: ""
    custom-console-url-pr-details: ""
    custom-console-url-pr-tasklog: ""
    error-detection-from-container-logs: "false"
    error-detection-max-number-of-lines: "50"
    error-detection-simple-regexp: ^(?P<filename>[^:]*):(?P<line>[0-9]+):(?P<column>[0-9]+):([
      ]*)?(?P<error>.*)
    error-log-snippet: "true"
    hub-catalog-name: tekton
    hub-url: http://tekton-hub-api.tekton-pipelines.svc:8000/v1
    remote-tasks: "true"
    secret-auto-create: "true"
    secret-github-app-token-scoped: "true"
    skip-push-event-for-pr-commits: "true"
  targetNamespace: pipelines-as-code
```
The Tekton operator will deploy PAC components such as controller, watcher, and webhook in the `pipelines-as-code` namespace.

### Configuring External Access Address

The `pipelines-as-code-controller` is responsible for receiving GitLab events, but the Service created by the Tekton operator for it is of type `ClusterIP` and can only be accessed within the cluster. To access it from outside the cluster, create a Service with external access or provide an access entry through Ingress or other methods. The following example creates a `LoadBalancer` Service to obtain an external access address:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: pipelines-as-code-controller-external
  namespace: pipelines-as-code
spec:
  ports:
  - name: http-listener
    nodePort: 31007
    port: 8080
    protocol: TCP
    targetPort: 8082
  selector:
    app.kubernetes.io/component: controller
    app.kubernetes.io/instance: default
    app.kubernetes.io/name: controller
    app.kubernetes.io/part-of: pipelines-as-code
  type: LoadBalancer
```

### Configuring Code Repository

Create the following resources:

```yaml
apiVersion: pipelinesascode.tekton.dev/v1alpha1
kind: Repository
metadata:
  name: repo
  namespace: demo-repo
spec:
  git_provider:
    secret:
      key: ""
      name: gitlab-webhook-config
    type: gitlab
    url: https://<gitlab-url>/
    webhook_secret:
      key: ""
      name: gitlab-webhook-config
  url: https://<gitlab-url>/<group>/<project>
```

Fill in the GitLab information as needed.

The content of the Secret `gitlab-webhook-config` is as follows:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: gitlab-webhook-config
  namespace: demo-namespace
data:
  provider.token: ......
  webhook.secret: ......
type: Opaque
```

Where:
- **provider.token** is the Access Token generated by GitLab, used when PAC calls the GitLab API.
- **webhook.secret** can be filled in arbitrarily, and it needs to be configured on GitLab's Webhook later to verify the authenticity of GitLab events.

### GitLab Configuration

In GitLab project settings, go to Webhooks and add a webhook configuration:

- Fill in the external access address of `pipelines-as-code-controller` in the Webhook URL
- Select `Push events` in the Webhook Trigger
- Fill in the original value of `webhook.secret` from the `gitlab-webhook-config` Secret in the Webhook `Secret token`

### Storing Pipelines in Code

Pipelines stored in code follow these conventions:

- Must be placed in the `.tekton` directory
- Must be in YAML format with file extension `xxx.yaml`
- File content must be a PipelineRun resource

Example:

```yaml
# filepath: .tekton/demo.yaml
---
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: demo
  namespace: demo-namespace
  annotations:
    pipelinesascode.tekton.dev/on-target-branch: "[main]"    # Must specify the matching branch
    pipelinesascode.tekton.dev/on-event: "[push]"            # Must specify the matching event
                                                             # Reference: https://pipelinesascode.com/docs/guide/matchingevents/
spec:
  pipelineSpec:                                              # Using embedded Pipeline
    params:
    - name: git-url
      type: string
    - name: git-revision
      type: string
    - name: git-commit
      type: string
    tasks:
    - name: demo
      params:
      - name: args
        value:
        - GIT_URL=$(params.git-url)
        - GIT_REVISION=$(params.git-revision)
        - GIT_COMMIT=$(params.git-commit)
      - name: script
        value: |
          export "$@"
          echo "Git URL: ${GIT_URL}"
          echo "Git Revision: ${GIT_REVISION}"
          echo "Git Commit: ${GIT_COMMIT}"
      taskRef:
        params:
        - name: kind
          value: task
        - name: catalog
          value: catalog
        - name: name
          value: kubectl
        - name: version
          value: "0.1"
        resolver: hub
  params:
  - name: git-url
    value: "{{ repo_url }}"                    # PAC will process dynamic variables like {{ var }}
                                               # Reference: https://pipelinesascode.com/docs/guide/authoringprs/#dynamic-variables
  - name: git-revision
    value: "{{ source_branch }}"
  - name: git-commit
    value: "{{ revision }}"
```

After committing the above YAML file to GitLab, a PipelineRun resource named `demo-xxxx` will be created in the namespace specified in the YAML, indicating that the pipeline has started execution.

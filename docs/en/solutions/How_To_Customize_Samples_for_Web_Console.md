---
products
   - Alauda Container Platform
kind
   - Solution
---

# How to Customize Samples for Web Console

You can dynamically add YAML examples to any Kubernetes resources at any time. 

## Rerequisites

- You must have cluster administrator privileges. 
- The resource you want to add a sample for must already exist in the cluster.

## Resolution

Creating a YAML example for the `Deployment` resource.

Create a `ConsoleYAMLSample` object.
```yaml
apiVersion: console.alauda.io/v1
kind: ConsoleYAMLSample
metadata:
  name: sample-deployment
spec:
  title: "NGINX Deployment"
  description: "Sample deployment with 2 replicas"
  targetResource:
    apiVersion: apps/v1
    kind: Deployment
  yaml: |
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: nginx-deploy
    spec:
      replicas: 2
      selector:
        matchLabels:
          app: nginx
      template:
        metadata:
          labels:
            app: nginx
        spec:
          containers:
          - name: nginx
            image: nginx:1.25
```

Note​​: ConsoleYAMLSample is a cluster-scoped resource – do not specify a namespace during creation.


Below is the field specification:
| Field | Description |  Required/Optional |
| --- | --- | --- |
| title | The title of the sample as displayed in the web UI. | Required |
| description | A detailed description of the sample. | Required |
| targetResource | Specifies the target resource type using apiVersion and kind. This supports both native Kubernetes resources and Custom Resource Definitions (CRDs). | Required |
| yaml | The actual YAML template. Must conform to the schema of the target resource. | Required |
| snippet | When set to true, only a code snippet is displayed instead of the full YAML. | Optional |


This resource allows users to seamlessly integrate custom YAML examples directly into the Alauda web console, improving usability and accelerating development workflows.


---
id: KB250500023
products: 
   - Alauda Container Platform
kind:
   - Solution
---
# How to Create an Application on ACP Platform

## Overview

This document describes two methods for deploying applications on the ACP platform : one using Git (Helm scenario) and one using Template. Each has its own advantages; choose based on your requirements.

### Prerequisites

- **kubectl**: installed
- **kubectl-acp**: installed
- **helm**: installed (Helm scenario)
- **git**: installed and configured (Helm scenario)
- **Chart repository**: application charts are available (Helm scenario)

## Create a Namespace

1. **Login to ACP**
   
   ```shell
   kubectl acp login <acp_address> --idp=<idp_name> --cluster=<cluster-name>
   ```

2. **Create Project**
   
   ```shell
   # if project not exist
   kubectl acp create project <project-name> --cluster=<cluster-list> 
   ```

3. **Create namespace and configure ResourceQuota and LimitRange**
   
   ```shell
   kubectl acp process <template-name> --namespace cpaas-system | kubectl acp apply -f -
   ```

4. **Bind role**
   
   ```shell
   kubectl acp bind <role-name> <username>  --namespace <namespace>
   ```

## Deploy Application

### Method 1: Deploy with Helm

1. **Login to ACP and Select Namespace**
   
   ```shell
   kubectl acp login <acp_address> --idp=<idp_name> --cluster=<cluster-name> --namespace=<namespace-name>
   ```

2. **Clone Application Chart Repository**
   
   ```shell
   git clone https://github.com/test/hello-world.git
   ```

3. **Install via Helm Template**
   
   ```shell
   helm template hello  --set replicas=1 --set image.repository=<image-repository> ./hello-world | kubectl acp apply -f -
   ```

### Method 2: Deploy with ACP Templates

1. **Login to ACP**
   
   ```shell
   kubectl acp login <acp_address> --idp=<idp_name> -u <username> -p <password> --cluster=<cluster-name> --namespace <namespace-name>
   ```

2. **Deploy Application via Template**
   
   ```shell
   # Note: --namespace specifies the namespace where the Template CR lives, not the namespace into which resources will be deployed
   kubectl acp process <template-name> --namespace cpaas-system  -p replica=1 -p image=<image-info> | kubectl acp apply -f -
   ```

## Template Overview

**Template** is a mechanism that combines multiple resource definitions (such as Services, Storage, Workloads, etc.) into a single file, making it easy to describe and manage the entire application deployment process at once. By using parameter placeholders within a Template, the same definition can be reused across different environments; you simply supply different parameter values at deployment time to generate resource manifests tailored to the target environment, thereby achieving configuration‑as‑code separation.

### Template CRD

Ensure that the Template CRD already exists in your Kubernetes cluster.

```yaml
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  annotations:
    controller-gen.kubebuilder.io/version: v0.17.3
  name: templates.template.alauda.io
spec:
  group: template.alauda.io
  names:
    kind: Template
    listKind: TemplateList
    plural: templates
    singular: template
  scope: Namespaced
  versions:
  - name: v1
    schema:
      openAPIV3Schema:
        description: Template contains the inputs needed to produce a Config.
        properties:
          apiVersion:
            description: |-
              APIVersion defines the versioned schema of this representation of an object.
              Servers should convert recognized schemas to the latest internal value, and
              may reject unrecognized values.
              More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#resources
            type: string
          kind:
            description: |-
              Kind is a string value representing the REST resource this object represents.
              Servers may infer this from the endpoint the client submits requests to.
              Cannot be updated.
              In CamelCase.
              More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#types-kinds
            type: string
          labels:
            additionalProperties:
              type: string
            description: |-
              labels is a optional set of labels that are applied to every
              object during the Template to Config transformation.
            type: object
          message:
            description: |-
              message is an optional instructional message that will
              be displayed when this template is instantiated.
              This field should inform the user how to utilize the newly created resources.
              Parameter substitution will be performed on the message before being
              displayed so that generated credentials and other parameters can be
              included in the output.
            type: string
          metadata:
            type: object
          objects:
            description: |-
              objects is an array of resources to include in this template.
              If a namespace value is hardcoded in the object, it will be removed
              during template instantiation, however if the namespace value
              is, or contains, a ${PARAMETER_REFERENCE}, the resolved
              value after parameter substitution will be respected and the object
              will be created in that namespace.
            items:
              type: object
              x-kubernetes-preserve-unknown-fields: true
            type: array
            x-kubernetes-preserve-unknown-fields: true
          parameters:
            description: |-
              parameters is an optional array of Parameters used during the
              Template to Config transformation.
            items:
              description: |-
                Parameter defines a name/value variable that is to be processed during
                the Template to Config transformation.
              properties:
                description:
                  description: description of a parameter. Optional.
                  type: string
                displayName:
                  description: 'Optional: The name that will show in UI instead of
                    parameter ''Name'''
                  type: string
                from:
                  description: from is an input value for the generator. Optional.
                  type: string
                generate:
                  description: |-
                    generate specifies the generator to be used to generate random string
                    from an input value specified by From field. The result string is
                    stored into Value field. If empty, no generator is being used, leaving
                    the result Value untouched. Optional.

                    The only supported generator is "expression", which accepts a "from"
                    value in the form of a simple regular expression containing the
                    range expression "[a-zA-Z0-9]", and the length expression "a{length}".

                    Examples:

                    from             | value
                  type: string
                name:
                  description: |-
                    name must be set and it can be referenced in Template
                    Items using ${PARAMETER_NAME}. Required.
                  type: string
                required:
                  description: 'Optional: Indicates the parameter must have a value.  Defaults
                    to false.'
                  type: boolean
                value:
                  description: |-
                    value holds the Parameter data. If specified, the generator will be
                    ignored. The value replaces all occurrences of the Parameter ${Name}
                    expression during the Template to Config transformation. Optional.
                  type: string
              required:
              - name
              type: object
            type: array
        required:
        - objects
        type: object
    served: true
    storage: true
```

### Create namespace with resourceQuota and limitRange

#### create template resource in cpaas-system

```yaml
apiVersion: template.alauda.io/v1
kind: Template
metadata:
  name: namepace-quota-limit
  namespace: cpaas-system
objects:
- apiVersion: v1
  kind: Namespace
  metadata:
    labels:
      cpaas.io/cluster: "${CLUSTER}"
      cpaas.io/project: "${PROJECT}"
    name: "${NAMESPACE}"
  spec:
    finalizers:
    - kubernetes
- apiVersion: v1
  kind: ResourceQuota
  metadata:
    name: default
    namespace: "${NAMESPACE}"
  spec:
    hard:
      limits.cpu: "4"
      limits.memory: 8Gi
      pods: "10"
      requests.cpu: "2"
      requests.memory: 4Gi
- apiVersion: v1
  kind: LimitRange
  metadata:
    name: default
    namespace: "${NAMESPACE}"
  spec:
    limits:
    - default:
        cpu: 500m
        memory: 512Mi
      defaultRequest:
        cpu: 250m
        memory: 256Mi
      max:
        cpu: "1"
        memory: 1Gi
      min:
        cpu: 100m
        memory: 128Mi
      type: Container
parameters:
- description: The name of the namespace
  displayName: namespaceName
  name: NAMESPACE
  required: true
- description: The name of the project which the namespace belongs to
  displayName: projectName
  name: PROJECT
- description: The name of the cluster which the namespace belongs to
  displayName: clusterName
  name: CLUSTER
  required: true
```

#### Check the rendered result

```shell
kubectl acp process namepace-quota-limit -n cpaas-system -p NAMESPACE=tpl-ns -p PROJECT=test-project -p CLUSTER=workload
```

#### Create namespace

```shell
kubectl acp process namepace-quota-limit -n cpaas-system -p NAMESPACE=tpl-ns -p PROJECT=test-project -p CLUSTER=workload | kubectl acp appl
y -f -
```

### Deploy Application

#### Create template resource with deployment and service in the specified namespace

```yaml
apiVersion: template.alauda.io/v1
kind: Template
metadata:
  name: hello-world
  namespace: tpl-ns
objects:
- apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: ${NAME}
    namespace: tpl-ns
  spec:
    selector:
      matchLabels:
        service.cpaas.io/name: hello-world
    template:
      metadata:
        labels:
          service.cpaas.io/name: hello-world
      spec:
        affinity: {}
        containers:
        - image: hello-world:${TAG}
          imagePullPolicy: IfNotPresent
          name: nginx
          ports:
          - containerPort: 80
            protocol: TCP
- apiVersion: v1
  kind: Service
  metadata:
    name: ${NAME}-service
    namespace: tpl-ns
  spec:
    ipFamilies:
    - IPv4
    ipFamilyPolicy: SingleStack
    ports:
    - name: http
      port: 80
      protocol: TCP
      targetPort: 80
    selector:
      service.cpaas.io/name: hello-world
    type: ClusterIP
parameters:
- description: The name of the namespace
  displayName: appname
  name: NAME
  required: true
- description: The image tag
  displayName: imagetag
  name: TAG
  required: true
```

#### Check the application yaml

```shell
kubectl acp  process  hello-world -n tpl-ns -p NAME=hello -p TAG=latest
```

#### Deploy application in current namespace

```shell
kubectl acp  process  hello-world -n tpl-ns -p NAME=hello -p TAG=latest | kubectl acp apply -f -
```

---
products: 
   - Alauda Container Platform
   - Alauda Service Mesh
kind:
   - Solution
id: KB250500011
---
# CI/CD Integration Example with Alauda Container Platform

This document provides an example CI/CD pipeline integration for deploying applications on the Alauda Container Platform (ACP), using tools such as Argo Rollouts, Gateway API, and Skopeo. This is one of many possible approaches. Users are encouraged to adapt this example to fit their own deployment strategies and tools.

For alternative deployment methods, please refer to:

- ACP Deployment Strategies
- Migrating from Istio to the Alauda Service Mesh

## Prerequisites

- Alauda Container Platform environment and account.
- Project and namespaces already created inside Alauda Container Platform with the necessary permissions.
- Application manifests and image repository. For this guide, a public repository is used (index.docker.io) and instructions on how to integrate external third-party image repositories will be provided.
- [Kubectl CLI](https://kubectl.docs.kubernetes.io/installation/kubectl/) installed. All main interactions with the cluster will be done using kubectl.
- `kubectl acp plugin` installed. Authentication to the cluster is done using the kubectl acp login command.
- [Skopeo](https://github.com/containers/skopeo) installed. Skopeo is used for syncing container images between registries. If deployment is done directly using the source image, this tool becomes unnecessary.
- Alternatively use [Docker](https://docs.docker.com/get-docker/) or [Podman](https://podman.io/docs/installation) installed to copy images from source to target repository. These are alternative tools for syncing container images between registries.
- Optionally install [Kubectl argo rollouts plugin](https://argoproj.github.io/argo-rollouts/installation/#kubectl-plugin-installation) to be used for watching and manually promoting rollouts based on Argo Rollouts.

**Note**: Some tools above (e.g., Skopeo, Argo Rollouts) are used in this example only. You can substitute them with other tools or skip them if unnecessary in your setup.

## Procedure

Having all the prerequisites in place, the process of deploying an application using blue/green and canary deployment strategies is divided into the following stages:

1. Choose a deployment strategy (blue/green or canary)
2. Prepare application manifests and container images
3. Onboard the application into ACP
4. Configure and fine-tune your CI/CD pipeline
5. Use the pipeline to deploy and manage your application


![](../assets/blue-green-canary-pipeline.drawio.png)


## Step 1: Choose a deployment strategy

The first step is to decide on the deployment strategy. You can choose between blue/green and canary deployment strategies. The choice of strategy will depend on your application requirements and the desired level of control over the deployment process. If no specific requirements are present, you can choose the blue/green deployment strategy as it is easier to implement and manage, or use regular rolling updates.

- **Blue/green deployment**: This strategy involves deploying the new version of the application alongside the old version and then switching traffic to the new version. This allows for quick rollback in case of issues with the new version.
- **Canary deployment**: This strategy involves deploying the new version of the application to a small subset of users before rolling it out to the entire user base. This allows for testing the new version in a production environment with minimal risk.


After picking a deployment strategy, you should also decide on the rollout strategy. The rollout strategy defines how the new version of the application will be deployed. You can choose between automatic and manual rollout strategies. For automatic strategies, you can also choose to use metrics-based rollouts.

### 1.1 Blue/green deployment

When picking a blue/green deployment strategy, you need to prepare the following:

- **Services**: You need to create two services for the application. One service will be used for the old version of the application (blue) and the other service will be used for the new version of the application (green). For initial setup, the service manifest can have the same specifications, and the Rollout will take care of switching matching labels inside the service definition.

- **Gateway**: You need to create a Gateway resource for the application. The Gateway resource defines the entry point for the application.

- **HTTPRoute**: For successful traffic routing, you need to create an HTTPRoute resource. The HTTPRoute resource defines the routing rules for the application.

- **Rollout**: You need to create a Rollout resource for the application. The Rollout resource defines the deployment strategy and the services to be used.

A more advanced tutorial is provided separately.

### 1.2 Canary deployment

In a canary deployment, you need to create a new version of the application and deploy it alongside the old version. The new version will be gradually rolled out to a small subset of users before being rolled out to the entire user base. This allows for testing the new version in a production environment with minimal risk.

When picking a canary deployment strategy, you need to prepare the following:

- **Services**: You need to create two services for the application. One service will be used for the stable version of the application and the other service will be used for the canary version of the application. For initial setup, the service manifest can have the same specifications, and the Rollout will take care of switching matching labels inside the service definition.

- **Gateway**: You need to create a Gateway resource for the application. The Gateway resource defines the entry point for the application.

- **HTTPRoute**: For successful traffic routing, you need to create an HTTPRoute resource. The HTTPRoute resource defines the routing rules for the application.

- **Rollout**: You need to create a Rollout resource for the application. The Rollout resource defines the deployment strategy and the services to be used.

A more advanced tutorial is provided separately.

### 1.3 Canary using Istio

For microservices that are part of a service mesh, you can use Istio to manage traffic routing and deployment strategies. You need to create a VirtualService resource for the application. The VirtualService resource defines the routing rules for the application and can be used to implement canary deployments.

- **Services**: You need to create two services for the application. One service will be used for the stable version of the application and the other service will be used for the canary version of the application. For initial setup, the service manifest can have the same specifications, and the Rollout will take care of switching matching labels inside the service definition.

- **VirtualService**: You need to create a VirtualService resource for the application. The VirtualService resource defines the routing rules for the application and can be used to implement canary deployments.

- **Rollout**: You need to create a Rollout resource for the application. The Rollout resource defines the deployment strategy and the services to be used.

- **Namespace**: Make sure the namespace is part of the Istio service mesh. This can be done by the Platform Administrator.

A more advanced tutorial is provided separately.

## Step 2: Prepare application manifests and container images

The next step is to prepare the application manifests and container images artifacts. You need to make sure that the application manifests are ready for deployment and that the container images are available in the target image repository.
For this tutorial, a simple `Deployment`, `Service`, and application image are used.


### Example application

The following steps will guide you through the process of preparing the application manifests and container images artifacts. In case your application is defined using different methods, please adjust accordingly.

**Deployment Manifest**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bluegreen-demo
spec:
  revisionHistoryLimit: 10
  selector:
    matchLabels:
      app: bluegreen
  strategy:
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 25%
    type: RollingUpdate
  template:
    metadata:
      labels:
        app: bluegreen
    spec:
      containers:
        # the image may need to be changed depending on connectivity to quay.io
        - image: quay.io/codefresh/rollouts-demo:red
          name: rollout
          ports:
            - containerPort: 8080
              protocol: TCP
```

**Service Manifest**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: bluegreen-active
spec:
  ports:
    - port: 80
      targetPort: 8080
      protocol: TCP
      name: http
  selector:
    app: bluegreen
```

You can apply the manifest using the `kubectl apply` command:

```bash
kubectl acp login -u <username> -p <password> <alauda container platform url> [--idp=<idp>]
kubectl acp set-cluster <workcluster-name>
kubectl apply -n <namespace> -f <manifest-file>
```

## Step 3: Onboard the Application

Once the application manifests and container images are ready, you need to onboard the application. The onboarding process includes the following steps:

1. Create the necessary Kubernetes resources for the application, such as the services, gateway, HTTPRoute, and Rollout.
2. Configure the Rollout resource with the desired deployment strategy and settings.
3. Test the application and make sure it is working as expected.


### Example application onboarding

For this example, we picked the blue/green deployment strategy with Gateway API for traffic routing.

**Gateway Manifest**

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  # Name of the gateway.
  name: default
spec:
  gatewayClassName: exclusive-gateway
  listeners:
    # This route is used only for metrics
    - allowedRoutes:
        namespaces:
          from: All
      name: gateway-metric
      port: 11782
      protocol: TCP
    # This listener is used for Application traffic
    - allowedRoutes:
        namespaces:
          from: All
      # The domain used by the application
      # PS: change to the actual domain
      hostname: bluegreen-demo.com
      # route details
      name: bluegreen
      port: 80
      protocol: HTTP
```

**HTTPRoute Manifest**

For Blue/green deployment, a simple HTTPRoute is used to route traffic to the active service.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  # Name of the route used in the gateway
  name: bluegreen
spec:
  hostnames:
    # PS: change to the actual domain
    - bluegreen-demo.com
  parentRefs:
    # The gateway used for the application
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: default
  # traffic routing rules
  rules:
    - backendRefs:
        - group: ""
          kind: Service
          name: bluegreen-active
          port: 80
      matches:
        - path:
            type: PathPrefix
            value: /
```

**Rollout Manifest**

For this example, a simple Rollout strategy with manual promotion is used.


```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: bluegreen-demo
spec:
  minReadySeconds: 30
  replicas: 4
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app: bluegreen
  strategy:
    blueGreen:
      activeService: bluegreen-active
      previewService: bluegreen-preview
      autoPromotionEnabled: false
  workloadRef:
    apiVersion: apps/v1
    kind: Deployment
    name: bluegreen-demo
    scaleDown: onsuccess
```

For more details on how to customize the Rollout Manifest, please refer to the official specs [here](https://argoproj.github.io/argo-rollouts/features/specification/).

**Service Manifest**

An extra service for the preview version is necessary. The initial manifest is the same as the active service. The Rollout will take care of switching matching labels inside the service definition.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: bluegreen-preview
spec:
  ports:
    - port: 80
      targetPort: 8080
      protocol: TCP
      name: http
  selector:
    app: bluegreen
```

Save all the manifests in a folder and apply them using the `kubectl apply` command:

```bash
# apply manifests to the cluster
kubectl apply -n <namespace> -f <manifest-folder>

# check the status of the rollout
kubectl argo rollouts get rollout bluegreen-demo -n <namespace> --watch
```


## Step 4: Configure the Pipeline

According to your environment and current CI/CD setup, the pipeline may involve different steps:

1. Sync the container image to the target image repository (optional).
2. Deploy the application using the Kubernetes resources created in the onboarding process.
3. Manage application rollouts and traffic routing using the Rollout resource.
4. Monitor the application and adjust as needed.


### 4.1 Sync the container image to the target image repository

If the target image repository is different from the source image repository, you need to sync the container image to the target image repository. The following example will show how this can be done using the `skopeo` tool.

```bash
# authentication using username and password
## authentication with the source image repository
skopeo login -u <username> -p <password> <source-image-repository>
## authenticate with the target image repository
skopeo login -u <username> -p <password> <target-image-repository>

# copying
skopeo copy docker://<source-image> docker://<target-image>
```


A simple example would be:

```bash
# authentication using username and password
skopeo login -u myuser -p <password> index.docker.io
skopeo login -u myuser -p <password> harbor.acp.com
# copying
skopeo copy docker://index.docker.io/argoproj/rollouts-demo:red docker://harbor.acp.com/argoproj/rollouts-demo:red
```



### 4.2 Deploy the application using the Kubernetes resources created in the onboarding process

You need to deploy the application using the Kubernetes resources created in the onboarding process. This can be done using the `kubectl` command line tool. In order to authenticate to Alauda Container Platform, you need to use the `kubectl acp login` command:

```bash
kubectl acp login -u <username> -p <password> <alauda container platform url> [--idp=<idp>] [--kubeconfig=<kubeconfig-file>] [--cluster=<cluster-name>] [--namespace=<namespace>]
```

A simple example would be:

```bash
kubectl acp login -u myuser -p <password> https://acp.com --idp=ldap --cluster=cluster1
```


Switch to the target cluster using the `kubectl acp set-cluster` command:

```bash
kubectl acp set-cluster <workcluster-name>
```

#### Using yaml manifests

After authenticating to the cluster, you can deploy the application using the `kubectl apply` command:


```bash
kubectl apply -n <namespace> -f <kubernetes-resource-file/folder>
```


#### Simple image updates

For simple image updates, you can use the `kubectl set image` command to update the image of the deployment:

```bash
kubectl set image deployment/<deployment-name> <container-name>=<image-name>:<tag> -n <namespace>
```
A simple example would be:

```bash
kubectl set image deployment/bluegreen-demo rollout=harbor.acp.com/argoproj/rollouts-demo:red -n argo-demo
```



### 4.3 Manage application rollouts and traffic routing using the Rollout resource

Once the application is deployed, you can manage the application rollouts and traffic routing using the Rollout resource. You can use the `kubectl argo rollouts` command line tool to manage the Rollout resource.

For watching the rollout status, you can use the following command:

```bash
kubectl argo rollouts get rollout <rollout-name> -n <namespace> --watch
```

In case the rollout involves multiple steps including pauses or manual promotion, you can use the following command for promoting the rollout:

```bash
kubectl argo rollouts promote <rollout-name> -n <namespace>
```

Or for promoting directly to the final step, skipping all the intermediate steps:

```bash
kubectl argo rollouts promote <rollout-name> -n <namespace> --full
```

If the rollout is not successful, you can use the following command to rollback the rollout:

```bash
kubectl argo rollouts undo <rollout-name> -n <namespace>
```

If you need to pause the rollout, you can use the following command:

```bash
kubectl argo rollouts pause <rollout-name> -n <namespace>
```
For resuming the rollout, you can use the following command:

```bash
kubectl argo rollouts resume <rollout-name> -n <namespace>
```

For more information on the `kubectl argo rollouts` command line tool, please refer to the [Argo Rollouts documentation](https://argoproj.github.io/argo-rollouts/features/kubectl-plugin/).

### 4.4 Monitor the application and adjust as needed

Once the application is deployed and the pipeline is working properly, you can monitor the application deployment rollout and adjust as needed.


## Step 5: Pipeline usage and deployment

Once the pipeline is configured and fine-tuned, you can use the pipeline to deploy the application.

1. Trigger the deployment pipeline
2. Monitor the deployment status and application health
3. Promote the rollout (if using manual promotion): `kubectl argo rollouts promote <rollout-name> -n <namespace>`
4. Rollback the rollout (if needed): `kubectl argo rollouts undo <rollout-name> -n <namespace>`

## Conclusion

In this tutorial, we have covered the steps to configure and deploy a pipeline for application rollout using Argo Rollouts. We have also discussed how to monitor the application and make adjustments as needed. By following these steps, you can ensure a smooth and successful deployment of your application.

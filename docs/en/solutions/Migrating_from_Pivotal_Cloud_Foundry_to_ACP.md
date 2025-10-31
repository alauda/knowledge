# Migrating from Pivotal Cloud Foundry to Alauda Container Platform

## Overview

Migrating applications from Pivotal Cloud Foundry (PCF) to Alauda Container Platform (ACP) involves transforming Cloud Foundry-specific configurations and deployment models to Kubernetes-native resources. This document provides a comprehensive guide for this migration process using Move2Kube as the primary migration tool.

### Understanding migration concepts

#### Cloud Foundry architecture

Cloud Foundry uses a Platform-as-a-Service (PaaS) model with abstractions like buildpacks, applications, and service bindings. Applications are deployed using `cf push` commands and manifest files, with the platform handling container creation and routing.

#### Kubernetes architecture

Kubernetes uses a container orchestration model with resources like Deployments, Services, and ConfigMaps. Applications are deployed as container images with explicit configuration for networking, scaling, and resource management.

### Migration process overview

The migration from PCF to ACP involves several key phases:

| Phase | Description | Key Activities |
| ----- | ----------- | -------------- |
| Analysis | Understand PCF application structure | Extract metadata, identify components |
| Transformation | Convert to Kubernetes resources | Use Move2Kube to generate manifests |
| Adaptation | Customize for ACP | Modify networking, storage, security |
| Deployment | Deploy to ACP | Build images, apply manifests |
| Verification | Validate functionality | Test, monitor, fine-tune |

## Prerequisites

Before beginning the migration process, ensure you have:

1. Alauda Container Platform environment and account (LDAP account used in this guide)
2. Project and namespaces already created inside Alauda Container Platform with necessary permissions
3. Access to your PCF application source code (Optional) and manifest files
4. [Move2Kube CLI](https://move2kube.konveyor.io/installation/) installed
5. [Kubectl CLI](https://kubectl.docs.kubernetes.io/installation/kubectl/) installed
6. Cloud Foundry Command Line Interface (cf CLI) installed (Optional)
7. `kubectl acp plugin` installed for authentication with ACP
8. [Skopeo](https://github.com/containers/skopeo) installed for container image management
9. Access to a container registry for storing migrated application images

## Chapter 1: Analyzing Your PCF Application

Before migrating, you need to thoroughly understand your PCF application's structure, dependencies, and configuration.

### Concepts

- **PCF Manifest**: A YAML file that defines application attributes, dependencies, and configuration
- **Buildpacks**: Provide runtime support for applications in PCF
- **Service Bindings**: Connect applications to backing services like databases
- **Routes**: Define how traffic reaches your application

### Extracting PCF application metadata

Use the Cloud Foundry CLI to gather detailed information about your application:

```shell
# Login to PCF
cf login -a <PCF API URL> -u <username> -p <password>

# List all apps in the target space
cf apps

# Get detailed information about your app
cf app <app-name>

# List service bindings
cf services

# Get environment variables
cf env <app-name>

# Export app manifest
cf create-app-manifest <app-name> -p manifest.yml
```

**Explanation of commands:**

- `cf login`: Authenticates with the PCF API
- `cf apps`: Lists all applications in the current space
- `cf app`: Shows detailed information about a specific application
- `cf services`: Lists all service instances and bindings
- `cf env`: Displays environment variables for an application
- `cf create-app-manifest`: Generates a manifest file from an existing application

### Identifying application components

Review the generated `manifest.yml` file to identify key application characteristics:

```yaml
---
applications:
- name: sample-app
  memory: 1G
  instances: 2
  buildpacks:
  - java_buildpack
  path: target/sample-app.jar
  env:
    JBP_CONFIG_SPRING_AUTO_RECONFIGURATION: '{enabled: false}'
    SPRING_PROFILES_ACTIVE: cloud
  services:
  - mysql-db
  - redis-cache
  routes:
  - route: sample-app.apps.pcf.example.com
```

**Key components to identify:**

1. **Runtime requirements**: Buildpacks used (`java_buildpack`)
2. **Memory and scaling**: Memory allocation (`1G`) and instance count (`2`)
3. **Service bindings**: External services the app depends on (`mysql-db`, `redis-cache`)
4. **Environment variables**: Configuration settings (`SPRING_PROFILES_ACTIVE: cloud`)
5. **Routes and domains**: How the app is accessed (`sample-app.apps.pcf.example.com`)

### Analyzing application architecture

Document your application's architecture focusing on:

1. **Microservices components**: How the application is divided into services
2. **Service dependencies**: External systems and databases the application relies on
3. **External API integrations**: Third-party services and APIs used
4. **Persistence requirements**: Data storage needs and patterns
5. **Scalability needs**: How the application scales under load
6. **Network traffic patterns**: Communication between components

Create an architecture diagram showing the relationships between components to guide your migration planning.

## Chapter 2: Preparing for Migration with Move2Kube

Move2Kube is an open-source tool that helps migrate applications to Kubernetes by analyzing source code and generating Kubernetes manifests.

### Concepts

- **Move2Kube**: A migration tool that transforms applications to Kubernetes
- **Transformation Plan**: A configuration file that guides the migration process
- **Artifacts**: Source code, configuration files, and other resources needed for migration

### Installing Move2Kube

Install the Move2Kube CLI tool to facilitate the migration process:

```shell
# Download the latest release from GitHub
curl -L https://github.com/konveyor/move2kube/releases/latest/download/move2kube-darwin-amd64 -o move2kube

# Make it executable
chmod +x move2kube

# Move to a directory in PATH
sudo mv move2kube /usr/local/bin/
```

### Analyzing and Collecting Application Information

Before initiating the migration process from Cloud Foundry (CF) to the Application Container Platform (ACP) using Move2Kube, it's crucial to prepare the necessary resources. There are three primary approaches to gather the required information for a successful migration:

1. Source Code Preparation:

   - What to Prepare: Ensure you have access to the complete source code of your application.

   - Effectiveness: This approach allows for a more flexible and comprehensive migration, as Move2Kube can analyze the codebase to generate optimal containerization strategies. It is ideal for applications where the source code is readily available and can be modified if necessary.
   
    ```shell
   # Create a project directory
   mkdir -p pcf-migration/<app-name>
   cd pcf-migration/<app-name>
   
   # Analyze the application
   # <project-name> is the name of the application you are migrating
   # <source-path> is the path of the source application you want to migrate
   move2kube plan -n <project-name> -s <source-path>
    ```
   
2. Artifact and Manifest Preparation:

   - What to Prepare: Gather the compiled artifacts (e.g., JAR files) along with the PCF manifest files.

   - Effectiveness: This method is suitable when the source code is not available. It relies on existing build artifacts and deployment configurations, which can limit the flexibility of the migration process but is often quicker to set up.

    ```shell
   # Create a project directory
   mkdir -p pcf-migration/<app-name>
   cd pcf-migration/<app-name>
   
   # Analyze the application
   # <project-name> is the name of the application you are migrating
   # <source-path> is the path of the source application you want to migrate,it may contain build artifacts (e.g., JAR files) and a manifest.yml file
   move2kube plan -n <project-name> -s <source-path>
    ```

3. Move2Kube Collect Method:

   - What to Prepare: Use the move2kube collect command to gather configuration and deployment information from your existing CF environment.

   - Effectiveness: This approach is beneficial for capturing the current state of your application and its dependencies directly from the CF environment. It provides a snapshot of the existing setup, which can be useful for ensuring that all necessary components are considered during migration.

   - Prerequisites: This method requires the installation of the Cloud Foundry CLI (cf) and a successful login to your Cloud Foundry instance using cf login. This is necessary to access and collect the runtime information of the applications running in the Cloud Foundry environment.
   >  By default, `move2kube collect` collects the runtime information of all the apps which are deployed to the Cloud Foundry instance. But, there may be instances where there is a large number (100s or 1000s) of apps which are deployed on Cloud Foundry, and we want to restrict `move2kube collect` to collect the information of only a smaller subset of apps. This could also speed up the execution of `move2kube collect` compared to when it has to fetch the info of all the apps.
    Move2Kube can be used to collect metadata for only selected CF apps through a YAML file.First, create a new folder (say, `collect_input`) and inside the new folder create a YAML file (say, `collect_cfapps.yaml`) which contains the CF app Names/Guids for which you want to collect the runtime information. A sample YAML file is provided below to collect the `inventory` and `cfnodejsapp` apps info.

```yaml
apiVersion: move2kube.konveyor.io/v1alpha1
kind: CfCollectApps
spec:
  filters:
    # filter apps from a particular CF space by specifying the CF spaceguid
    spaceguid: dummy-cf-space-guid
  applications:
    - application:
        name: inventory
    - application:
        name: cfnodejsapp
```

```shell
# Login to CF using
cf login -a <YOUR CF API endpoint>
# <collect-input-path> is the directory contains the CfCollectApps YAML
move2kube collect -a cf -s <collect-input-path>

# Analyze the application
# <project-name> is the name of the application you are migrating
# <source-path> is the path of the source application you want to migrate,it may contain build artifacts (e.g., JAR files) and a manifest.yml file
move2kube plan -n <project-name> -s <source-path>

# The data we collected will be stored in a new directory called ./m2k_collect.
# Move the ./m2k_collect/cf directory into the source directory ./cloud-foundry
mv m2k_collect cloud-foundry/
# Analyze the application
move2kube plan -s cloud-foundry
```

The `move2kube plan`  command will create a *m2k.plan* which is essentially a yaml file.You can see what is inside the *plan* file.

```shell
cat m2k.plan
```

### Configuring Move2Kube

Create a custom configuration file to guide the migration process:

```yaml
# move2kube.yaml
move2kube:
  containerization:
    default:
      dockerfileTemplate: ""
      healthCheck: true
  transformation:
    mode: directory
    services:
      enable: true
  target:
    kubernetes:
      clusterType: kubernetes
      outputPath: ""
      outputFormat: yaml
      enablePodSecurityContext: false
```

**Explanation of configuration:**

- `containerization`: Controls how applications are containerized
  - `healthCheck`: Enables generation of health check probes
- `transformation`: Defines how the application is transformed
  - `mode`: Specifies the transformation mode (directory-based)
  - `services`: Enables service discovery and generation
- `target`: Configures the target platform
  - `clusterType`: Specifies the target Kubernetes platform
  - `outputFormat`: Defines the output format for generated resources

## Chapter 3: Transforming PCF Artifacts to Kubernetes Resources

This chapter guides you through the process of using Move2Kube to analyze your PCF application and generate Kubernetes resources.

### Concepts

- **Kubernetes Manifests**: YAML files that define Kubernetes resources
- **Containerization**: The process of packaging applications into containers
- **Resource Mapping**: Converting PCF concepts to Kubernetes equivalents

### Transforming your application

Execute the transformation based on the generated plan:

```shell
# Transform based on the plan
move2kube transform -p m2k.plan
```

During the transformation process, Move2Kube will interactively ask questions about your application. Answer these questions based on your application's requirements and the target environment.

**Key questions you may encounter:**

1. Container registry selection
2. Service binding replacements
3. Ingress/route configuration
4. Resource requirements

### Reviewing generated resources

After transformation, Move2Kube generates Kubernetes manifests in the output directory:

```shell
# Navigate to the generated output
cd m2k-output

# List generated files
ls -la
```

The output typically includes:

1. **Dockerfile(s)**: For building container images
2. **Deployment manifests**: For deploying application containers
3. **Service definitions**: For exposing applications
4. **ConfigMap and Secret resources**: For configuration and sensitive data
5. **Ingress/Route definitions**: For external access
6. **Other related resources**: Such as PersistentVolumeClaims

Review these files carefully to understand how Move2Kube has transformed your application.

## Chapter 4: Adapting Move2Kube Output for Alauda Container Platform

The resources generated by Move2Kube need to be adapted to work optimally with Alauda Container Platform's specific features and requirements.

### Concepts

- **Istio Gateway**: ACP's preferred resource for external access
- **Virtual Service**: Defines how requests are routed to internal services. Works with Gateway to forward external traffic into the cluster.
- **Storage Classes**: Kubernetes resources that define storage provisioning

### Exposing Services: Ingress vs. Istio Gateway

When adapting Move2Kube output for Alauda Container Platform, you have two options for exposing your services: using Kubernetes Ingress or Istio Gateway.

#### Using Kubernetes Ingress

If you choose to use Kubernetes Ingress, and you selected 'Ingress' during the "Choose Ingress" question in Move2Kube, the tool will automatically generate the necessary Ingress resources. An example of such a generated Ingress resource is shown below:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myproject
spec:
  # Ask your platform administrator for the correct ingressClassName
  ingressClassName: alb
  rules:
    - host: myproject.example.com
      http:
        paths:
          - backend:
              service:
                name: provider
                port:
                  name: port-8080
            path: /
            pathType: Prefix
  tls:
    - hosts:
        - myproject.example.com
      secretName: myproject-tls-cert
```

This configuration uses a static TLS certificate. If you require dynamic certificate rotation, you will need to add `cert-manager.io/cluster-issuer` annotations to the Ingress resource to enable this feature. Ask your platform administrator for the correct issuer name to use in the annotation.

#### Using Istio Gateway

The following example creates a Gateway that listens on HTTP port 80 for traffic on the `example.com` host:

```yaml
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: my-gateway
  namespace: default
spec:
  selector:
  		# Ingress gateway selector that can be used to expose services
      # Ask your platform administrator for the label
    istio: ingressgateway
  servers:
  - port:
      number: 80
      name: http
      protocol: HTTP
    hosts:
    - "example.com"
```

#### Creating VirtualService to Use the Gateway

This VirtualService routes requests from the Gateway to an internal Kubernetes service named my-service on port 8080:
```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: my-virtualservice
  namespace: default
spec:
  hosts:
  - "example.com"
  gateways:
  - my-gateway
  http:
  - match:
    - uri:
        prefix: /
    route:
    - destination:
        host: my-service
        port:
          number: 8080

```


### Updating container registry references

Update image references to point to your target registry in Alauda Container Platform:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: <app-name>
spec:
  # ...
  template:
    spec:
      containers:
      - name: <container-name>
        image: <your-registry-url>/<namespace>/<image-name>:<tag>
        # ...
```

### Handling persistent volumes

Update PersistentVolumeClaim resources to use appropriate storage classes available in Alauda Container Platform:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <pvc-name>
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  storageClassName: <alauda-storage-class>
```

**Note**: Consult your ACP administrator to determine the available storage classes in your environment.

## Chapter 5: Containerizing Application Components

This chapter covers the process of building and pushing container images for your application.

### Concepts

- **Dockerfile**: A script that defines how to build a container image
- **Container Registry**: A repository for storing and distributing container images
- **Image Tags**: Identifiers for specific versions of container images

### Reviewing and customizing Dockerfiles

Move2Kube generates Dockerfiles based on your application's buildpacks or runtime requirements. Review and modify these files if necessary to:

1. Optimize image size and layers
2. Add custom initialization scripts
3. Configure environment variables
4. Set up proper user permissions
5. Include necessary dependencies

### Building container images

Build container images using the generated Dockerfiles:

```shell
# Navigate to the directory containing the Dockerfile
cd <app-component-dir>

# Build the container image
docker build -t <your-registry-url>/<namespace>/<image-name>:<tag> .

# Log in to your container registry
docker login <your-registry-url> -u <username> -p <password>

# Push the image to the registry
docker push <your-registry-url>/<namespace>/<image-name>:<tag>
```

### Using Skopeo for image management

If you need to copy images between registries, Skopeo provides a convenient way to do this:

```shell
# Log in to source and target registries
skopeo login -u <username> -p <password> <source-registry>
skopeo login -u <username> -p <password> <target-registry>

# Copy the image
skopeo copy docker://<source-registry>/<image-path>:<tag> docker://<target-registry>/<image-path>:<tag>
```

**Note**: Any other tool that can copy images between registries can be used as well, such as `docker` or `podman`.

**Benefits of using Skopeo:**

1. No need to pull and push large images
2. Efficient transfer between registries
3. Support for various authentication methods
4. Ability to copy specific image layers


## Chapter 6: Deploying the Application to Alauda Container Platform

This chapter guides you through the process of deploying your containerized application to Alauda Container Platform.

### Concepts

- **Namespace**: A virtual cluster within Kubernetes for resource isolation
- **Resource Application Order**: The sequence in which Kubernetes resources should be applied
- **Deployment Verification**: Checking that resources are correctly created and running

### Authenticating to Alauda Container Platform

Before deploying resources, authenticate to the ACP environment:

```shell
# Log in to ACP
kubectl acp login -u <username> -p <password> <alauda-container-platform-url> --idp=ldap

# Set the target cluster
kubectl acp set-cluster <workcluster-name>
```

### Creating namespace if needed

If your namespace doesn't already exist, create it:

```shell
kubectl create namespace <your-namespace>
```

### Applying Kubernetes manifests

Apply the Kubernetes manifests in the correct order to ensure dependencies are satisfied:

```shell
# Apply configuration resources first
kubectl apply -n <your-namespace> -f configmaps/
kubectl apply -n <your-namespace> -f secrets/

# Apply service definitions
kubectl apply -n <your-namespace> -f services/

# Apply deployments
kubectl apply -n <your-namespace> -f deployments/

# Apply networking resources
kubectl apply -n <your-namespace> -f networking/
```

**Explanation of application order:**

1. **Configuration resources**: ConfigMaps and Secrets must exist before Deployments that reference them
2. **Service resources**: Services should be created before Deployments that expose them
3. **Deployment resources**: Core application components
4. **Networking resources**: External access configuration that references Services

### Verifying deployment status

Check that all resources have been successfully deployed:

```shell
# Check deployment status
kubectl get deployments -n <your-namespace>

# Check pods
kubectl get pods -n <your-namespace>

# Check services
kubectl get services -n <your-namespace>

# Check Gateway and VirtualService resources
kubectl get gateway,virtualservice -n <your-namespace>
```

For more detailed information about a specific resource:

```shell
# Get detailed information about a deployment
kubectl describe deployment <deployment-name> -n <your-namespace>

# Check pod logs
kubectl logs <pod-name> -n <your-namespace>
```

## Chapter 7: Common Migration Challenges and Solutions

This chapter addresses common challenges encountered when migrating from PCF to ACP and provides practical solutions.

### Service bindings and configuration

PCF service bindings need to be replaced with Kubernetes equivalents:

1. **Identify all service bindings** in your PCF application
2. **Create equivalent Kubernetes resources** (ConfigMaps, Secrets)
3. **Update environment variables** to match Kubernetes conventions

Example of converting PCF environment variables to ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: <app-name>-config
  namespace: <your-namespace>
data:
  DATABASE_URL: "jdbc:postgresql://postgres-service:5432/mydb"
  REDIS_HOST: "redis-service"
  REDIS_PORT: "6379"
```

For sensitive information, use Secrets instead:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: <app-name>-secrets
  namespace: <your-namespace>
type: Opaque
data:
  DATABASE_PASSWORD: <base64-encoded-password>
  API_KEY: <base64-encoded-api-key>
```

### Logging and monitoring adaptation

Adjust your application's logging to work with Kubernetes:

1. **Configure applications to log to stdout/stderr**
2. **Implement structured logging** (JSON format)
3. **Add relevant Kubernetes metadata** to log events

Example of structured logging configuration for a Spring Boot application:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: <app-name>-logging-config
data:
  application.yml: |
    logging:
      pattern:
        console: '{"timestamp":"%d{yyyy-MM-dd HH:mm:ss.SSS}","level":"%p","thread":"%t","class":"%c{1}","message":"%m"}%n'
      level:
        root: INFO
        com.example: DEBUG
```

### Environment-specific configuration

Use Kubernetes ConfigMaps for environment-specific configuration:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: <app-name>-env-config
  namespace: <your-namespace>
data:
  APP_PROFILE: "prod"
  LOG_LEVEL: "INFO"
```

Mount the ConfigMap as environment variables:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: <app-name>
spec:
  # ...
  template:
    spec:
      containers:
      - name: <app-name>
        # ...
        envFrom:
        - configMapRef:
            name: <app-name>-env-config
```

## Conclusion

Migrating from PCF to Alauda Container Platform using Move2Kube streamlines the process of transforming Cloud Foundry applications to Kubernetes-native deployments. By following this guide, you can successfully migrate your applications while preserving functionality and leveraging the advanced capabilities of Alauda Container Platform.

The migration process involves several key phases:

1. **Analysis**: Understanding your PCF application structure and dependencies
2. **Transformation**: Converting PCF artifacts to Kubernetes resources using Move2Kube
3. **Adaptation**: Customizing generated resources for ACP
4. **Deployment**: Building and deploying containerized applications
5. **Verification**: Testing and fine-tuning the deployment

Each phase requires careful planning and execution, but the result is a modern, containerized application that can take full advantage of Kubernetes' scalability, resilience, and orchestration capabilities.

For more detailed information or assistance with specific application types, refer to the official Move2Kube documentation and Alauda Container Platform resources.

## References

1. [Move2Kube Documentation](https://move2kube.konveyor.io/)
2. [Alauda Container Platform Documentation](https://docs.alauda.io/)
3. [Kubernetes Best Practices](https://kubernetes.io/docs/concepts/configuration/overview/)
4. [Argo Rollouts Documentation](https://argoproj.github.io/argo-rollouts/)

---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.x
id: KB1762309013-4C37
---
# Langflow

## Overview

Langflow is an open-source low-code tool for visually building and deploying AI agents and workflows. It provides a drag-and-drop editor to quickly create, test, and iterate AI applications. Langflow is built on Python and includes a FastAPI backend and a React-based visual editor. It supports SQLite by default and recommends PostgreSQL in production.

It contains the following main components:
- **Frontend Interface**: React-based visual editor with drag-and-drop flow building and real-time testing
- **Backend Service**: FastAPI-based web service providing REST API and MCP (Model Context Protocol) support
- **Database**: Supports SQLite (default) and PostgreSQL (recommended for production)

## Core Concepts

Langflow is built around several core concepts: **Flows** (visual workflows organizing AI logic), **Components** (reusable functional units), **Agents** (intelligent agents with tool calling and reasoning capabilities), and **API/MCP** integration (REST API and Model Context Protocol support).

Langflow provides a drag-and-drop visual interface for building AI applications with real-time testing capabilities and an extensive template library. It supports multiple LLM providers, embedding models, and vector databases, enabling flexible multi-model configurations. The platform offers both IDE mode for development and runtime mode for production deployment, making it suitable for both experimentation and enterprise use.

For detailed information about core concepts, features, and usage, please refer to the [official documentation](https://docs.langflow.org/).

## Documentation and References

- **Official Documentation**: [https://docs.langflow.org/](https://docs.langflow.org/)
- **GitHub Repository**: [https://github.com/langflow-ai/langflow](https://github.com/langflow-ai/langflow)

# Langflow Deployment Guide

This section provides detailed instructions on how to deploy Langflow to a Kubernetes cluster and common configuration parameters.

## Publishing

Download the Langflow installation file: `langflow.ALL.v1.6.4-1.tgz`

Use the violet command to publish to the platform repository:
```bash
violet push --platform-address=platform-access-address --platform-username=platform-admin --platform-password=platform-admin-password langflow.ALL.v1.6.4-1.tgz
```

## Deployment

### Prepare Storage

Langflow supports two database modes:
- **SQLite (Default)**: For development and testing, data is stored in persistent volumes
- **PostgreSQL (Recommended)**: For production environments, providing better performance and scalability

The cluster needs to have CSI pre-installed or `PersistentVolume` pre-prepared.

### Prepare Database

#### Using SQLite (Default)

SQLite is Langflow's default database, suitable for development and testing environments:
- Data is stored in persistent volumes
- Simple configuration, no additional setup required
- Supports single-instance deployment

#### Using PostgreSQL (Recommended)

Production environments strongly recommend using PostgreSQL for better performance and scalability:

The `PostgreSQL operator` provided by `Data Services` can be used to create a `PostgreSQL cluster`.

Check the access address and password in the `PostgreSQL` instance details in `Data Services`.

**Note**:
- PostgreSQL version 12 or higher is recommended
- Need to create a separate database and user
- Ensure network connectivity

### Create Application

1. Go to the `Alauda Container Platform` view and select the namespace where Langflow will be deployed.

2. In the left navigation, select `Applications` / `Applications`, then click the `Create` button on the right page.

3. In the popup dialog, select `Create from Catalog`, then the page will jump to the `Catalog` view.

4. Find `3rdparty/chart-langflow` and click `Create` to create this application.

5. On the `Catalog` / `Create langflow` form, fill in the `Name` (recommended as `langflow`) and `Custom` configuration in `Values`, then click the `Create` button to complete creation. The `Custom` content will be described below. It can also be modified after creation through the `Update` application method.

## Configuration

Users can modify the `Custom Values` of the `Application` to adjust configuration. The main configurations to focus on are as follows:

### 1. Configure Storage

#### 1.1 Configure SQLite Storage (Default)

The storage class and size can be specified by adding the following configuration:

```yaml
langflow:
  sqlite:
    volume:
      storageClassName: storage-class-name     # Replace with the actual storage class name
      size: 1Gi                                # Replace with the actual required space size
```

**Note**: When using SQLite, only single-instance deployment (replicaCount = 1) is supported.

### 2. Configure Database

#### 2.1 Enable PostgreSQL

PostgreSQL access information can be configured by setting the following fields:

```yaml
langflow:
  externalDatabase:
    enabled: true                              # Enable external database
    driver:
      value: "postgresql"
    host:
      value: postgres-host                     # PostgreSQL access address
    port:
      value: "5432"                            # PostgreSQL access port, default: 5432
    database:
      value: langflow                          # Database name, note: database will be created automatically
    user:
      value: langflow                          # Database username
    password:
      valueFrom:
        secretKeyRef:
          name: postgres-secret                # Secret name storing database access password
          key: password                        # Secret key storing database access password
```

**Note**: Due to temporary storage limitations, the current version temporarily does not support multi-instance deployment. Even with PostgreSQL database configured, only single-instance deployment (replicaCount = 1) is supported.

### 3. Configure Access Method

By default, `LoadBalancer` is used to provide access address.

#### 3.1 Modify Service Type

The `Service` type can be modified by setting the following fields:

```yaml
langflow:
  service:
    type: LoadBalancer                         # Can be changed to NodePort or ClusterIP
    port: 7860                                 # Service port
```

#### 3.2 Enable Ingress

Ingress can be configured by setting the following fields. After enabling Ingress, the Service type is usually changed to ClusterIP:

```yaml
ingress:
  enabled: true                                # Enable Ingress functionality
  hosts:
    - host: langflow.example.com               # Access domain (must be DNS name, not IP address)
      paths:
        - path: /
  tls:
    - secretName: langflow-tls                 # Secret name storing TLS certificate
      hosts:
        - langflow.example.com
```

### 4. Configure Authentication and User Management (Optional)

#### 4.1 Enable User Authentication

User authentication can be enabled by setting the following fields:

```yaml
langflow:
  auth:
    enabled: true                              # Enable authentication
    superuser:
      username: langflow                       # Superuser name
      password: ""                             # Superuser password, auto-generated if not set
    secretKey: ""                              # Secret key, auto-generated if not set
    newUserActive: false                       # Whether new users need activation
    enableSuperuserCLI: false                  # Whether to enable CLI superuser
    accessTokenExpireSeconds: 3600             # Access token expiration time (seconds)
    refreshTokenExpireSeconds: 604800          # Refresh token expiration time (seconds)
```

After enabling authentication, by default:
- Login is required to access
- Superuser can be configured
- New users can only be added by superuser through `/admin` page (self-registration is not supported)
- New user account activation: If `newUserActive=true`, new user accounts are automatically activated; If `newUserActive=false` (default), superuser needs to manually activate


### 5. Configure OAuth2 Proxy (Optional)

OAuth2 proxy can be configured to provide single sign-on functionality by setting the following fields:

```yaml
oauth2_proxy:
  enabled: true                                # Enable OAuth2 proxy
  oidcIssuer: "https://x.x.x.com/dex"          # OIDC Issuer address
  oidcClientID: "your-client-id"               # OIDC client ID
  oidcClientSecret: "your-client-secret"       # OIDC client secret (recommended to use Secret)
```

To configure `Alauda Container Platform` as OIDC Provider, configure as follows:
- `oauth2_proxy.oidcIssuer` is the platform access address plus `/dex`
- `oauth2_proxy.oidcClientID` is fixed as `langflow`
- `oauth2_proxy.oidcClientSecret` is fixed as `ZXhhbXBsZS1hcHAtc2VjcmV0`

Also create an OAuth2Client resource in the global cluster to configure Langflow's client information:

```yaml
apiVersion: dex.coreos.com/v1
kind: OAuth2Client
metadata:
  name: nrqw4z3gnrxxps7sttsiiirdeu
  namespace: cpaas-system
id: langflow                                   # Consistent with oauth2_proxy.oidcClientID in values
name: Langflow
secret: ZXhhbXBsZS1hcHAtc2VjcmV0               # Consistent with oauth2_proxy.oidcClientSecret in values
redirectURIs:
- http://xxx.xxx.xxxx.xxx:xxxxx/*              # OAuth2-Proxy access address, acquisition method described below
                                               # If multiple Langflow instances are deployed, add multiple access addresses here
```

**Note**: OAuth2 Proxy access address can be obtained from the `<Application Name>-oauth2-proxy` Service, use the appropriate access method based on Service type.

After enabling OAuth2 Proxy, it is recommended to:
- Set `langflow.service.type` to `ClusterIP`, allowing access only within the cluster. Users need to access Langflow through OAuth2 Proxy address.
- Set `langflow.auth.enabled` to `false`. Use OAuth2 Proxy to handle login authentication.

Users can log out by accessing `/oauth2/sign_out`.

### 6. Configure Runtime Mode (Backend-Only)

Runtime mode is the recommended deployment method for production environments, deploying only the Langflow backend API service without a visual interface.

#### 6.1 Enable Runtime Mode

Runtime mode (backend-only) can be enabled by setting the following fields:

```yaml
langflow:
  backendOnly: true                            # Enable backend-only mode
  env:
    - name: LANGFLOW_LOAD_FLOWS_PATH           # Set the path to load Flows
      value: "/app/flows"
  volumes:
    - name: flows                              # Load Flows content through volume
      persistentVolumeClaim:                   # From PVC or other volumes
        claimName: langflow-flows-pvc
  volumeMounts:                                # Mount volume to specified path
    - name: flows
      mountPath: /app/flows
```
When enabling `LANGFLOW_LOAD_FLOWS_PATH`, authentication must be disabled, i.e., `langflow.auth.enabled` must be set to `false`.

## Access Address

### 1. Access via Service

`Langflow` provides external access through `Service`. Check its `Service` to get the access address.

- If OAuth2 proxy is not enabled, Service name is: `<Application Name>`
- If OAuth2 proxy is enabled, Service name is: `<Application Name>-oauth2-proxy`

If the `Service` type is `LoadBalancer` and the load balancer controller in the environment has assigned an access address, please access through that address.

If the `Service` type is `LoadBalancer` or `NodePort`, access is available through `node IP` with its `NodePort`.

### 2. Access via Ingress

If Ingress is enabled, please access through the configured domain name.

# Langflow Quickstart

For a quickstart guide, please refer to the official documentation: [https://docs.langflow.org/get-started-quickstart](https://docs.langflow.org/get-started-quickstart)

# Production Environment Recommendations

This section provides practical recommendations and optimization configurations for using Langflow in production environments.

## 1. Import Existing Flows via ConfigMap

In production environments, existing Flow files can be imported into Langflow through Kubernetes ConfigMap.

### 1.1 Create ConfigMap with Flow JSON

First, create a ConfigMap containing Flow JSON files:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: langflow-flows
  namespace: <Langflow namespace>
data:
  project1.json: |
    <JSON content>
```

### 1.2 Mount ConfigMap to Container

In Langflow configuration, mount the ConfigMap to a specified directory in the container:

```yaml
langflow:
  volumes:
    - name: flows
      configMap:
        name: langflow-flows                   # ConfigMap name
  volumeMounts:
    - name: flows
      mountPath: /app/flows                    # Mount path
  env:
    - name: LANGFLOW_LOAD_FLOWS_PATH           # Set the path to load Flow files
      value: /app/flows
```

### 1.3 Auto Import

After configuration, Langflow will automatically scan and import JSON files in the `LANGFLOW_LOAD_FLOWS_PATH` directory on startup.

## 2. Load Local Models

In production environments, locally deployed models may be needed (e.g., loading local embedding models). This can be configured as follows:

### 2.1 Mount Model Files via Volume

Store model files in persistent volumes and provide them to the Langflow container through Volume mounts:

```yaml
langflow:
  volumes:
    - name: models                             # Model storage volume
      persistentVolumeClaim:
        claimName: langflow-models-pvc
  volumeMounts:                                # Mount model volume to specified path
    - name: models
      mountPath: /opt/models
```

### 2.2 Upload Models

Users can use the `kubectl cp` command to upload models to the Langflow container, as shown in the following example:

```bash
kubectl cp <local model path> -n <Langflow namespace> <Langflow Pod name>:/opt/models
```

### 2.3 Configure Local Models in Components

In Langflow's flow editor, when using corresponding model components, the local model access path can be configured as `/opt/models`.

## 3. Add Additional Python Dependencies

In production environments, when using custom components, additional Python packages may need to be installed. This can be done as follows:

### 3.1 Mount Dependencies via PVC

Mount a directory using PVC to store additional Python packages.

```yaml
langflow:
  volumes:
    - name: python-packages
      persistentVolumeClaim:
        claimName: langflow-packages-pvc       # PVC name for storing additional Python packages
  volumeMounts:
    - name: python-packages
      mountPath: /opt/python-packages          # Mount path
  env:
    - name: PYTHONPATH                         # Set Python module search path
      value: "/opt/python-packages"
```

### 3.2 Install Dependencies

When installing dependency packages, use the `pip --target` parameter to install packages to the PVC-mounted directory:

```bash
# Execute in container, install package to PVC-mounted directory
pip install --target /opt/python-packages package-name

# Or install from requirements.txt
pip install --target /opt/python-packages -r requirements.txt
```

## 4. Pass Global Variables via Environment Variables

Flow component configurations often need different values in different environments. Langflow's global variables feature allows separating these environment-specific values from Flow definitions. The values of Global Variables can be loaded from environment variables.

### 4.1 Configure Environment Variables

Add environment variables in `Custom Values` as shown in the following example:

```yaml
langflow:
  env:
    - name: LANGFLOW_VARIABLES_TO_GET_FROM_ENVIRONMENT
      value: VAR1,VAR2,VAR3                    # List environment variable names that Langflow can automatically load, separated by commas
    - name: VAR1                               # Set environment variable value, environment variable name matches Langflow global variable name
      value: xxx
    - name: VAR2                               # Can also load value from ConfigMap
      valueFrom:
        configMapKeyRef:
          name: langflow-configs
          key: var2
    - name: VAR3                               # Sensitive information should be stored using Secret
      valueFrom:
        secretKeyRef:
          name: langflow-secrets
          key: var3
```

### 4.2 Use Global Variables in Flows

In Langflow's flow editor:

1. Go to the **Settings** page
2. In the **Global Variables** section, add global variables and set their values
3. Reference these global variables in component configurations
4. When exporting Flows, **must** select "Save with my API keys", otherwise Global Variables configuration may not be included in the exported JSON file

## 5. Optimization Recommendations

To improve performance, security, and stability in production environments, the following optimization configurations are recommended:

### 5.1 Disable Usage Tracking

Langflow collects usage data by default. In production environments, this feature can be disabled to protect privacy and reduce network requests:

```yaml
langflow:
  env:
    - name: DO_NOT_TRACK                       # Disable usage tracking
      value: "true"
```

### 5.2 Disable Transaction Logs

During each request processing, Langflow records the input, output, and execution logs of each component to the database, which is the information shown in the Langflow IDE's Logs panel.
In production environments, this logging can be disabled to improve performance and reduce database pressure.

```yaml
langflow:
  env:
    - name: LANGFLOW_TRANSACTIONS_STORAGE_ENABLED
      value: "false"                           # Disable transaction logs
```

### 5.3 Set Worker Process Count

```yaml
langflow:
  numWorkers: 1                                # Set number of worker processes
```

### 5.4 Configure Resource Limits

It is recommended to configure appropriate resource limits for the Langflow container. The following YAML is only an example; adjust the values according to actual requirements:

```yaml
langflow:
  resources:
    requests:
      cpu: "2"
      memory: "4Gi"
    limits:
      cpu: "4"
      memory: "8Gi"
```

### 5.5 Set API Keys

1. Go to the **Settings** page
2. In the **Langflow API Keys** section, add API keys
3. When making API requests, add the `x-api-key: <API Key>` header; otherwise, a 401 error (unauthorized request) will be returned

### 5.6 Disable UI

Runtime mode allows Langflow to run without a browser interface, suitable for API service scenarios in production environments.

```yaml
langflow:
  backendOnly: true                            # Enable backend-only mode
```

---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.x
---
# Langflow

## Overview

Langflow is an open-source low-code tool for visually building and deploying AI agents and workflows. It provides a drag-and-drop editor to quickly create, test, and iterate AI applications. Langflow is built on Python and includes a FastAPI backend and a React-based visual editor. It supports SQLite by default and recommends PostgreSQL in production.

It contains the following main components:
- **Frontend Interface**: React-based visual editor with drag-and-drop flow building and real-time testing
- **Backend Service**: FastAPI-based web service providing REST API and MCP (Model Context Protocol) support
- **Database**: Supports SQLite (default) and PostgreSQL (recommended for production)

## Core Concepts

### Flow

Flows are the basic organizational unit for AI logic in Langflow, including:

- **Component Nodes**: Functional modules such as LLMs, vector databases, tools, etc.
- **Connections**: Data flow and dependencies between components
- **Configuration Parameters**: Settings and options for each component
- **Test Interface**: Real-time interactive testing environment

Each flow is independent and reusable AI application logic.

### Component

Components are the building blocks of flows, representing specific functional units:

- **Input/Output Ports**: Interfaces for data transfer between components
- **Configuration Options**: Component parameters and settings
- **Type System**: Ports support different data types
- **Custom Components**: Developers can write custom Python components

### Agent

Agents extend LLM capabilities with tools, reasoning, and context management:

- **Tool Calling**: Integrate external tools and APIs
- **Reasoning Engine**: Intelligent decision-making
- **Context Management**: Conversation history and context memory
- **Multi-agent Flows**: Use one agent as a tool for another

### API Endpoints and MCP Support

Langflow supports multiple integration methods:

- **REST API**: Standard HTTP interface for calling flows
- **MCP Server**: Expose flows as tools for MCP clients
- **MCP Client**: Connect to other MCP servers to extend functionality
- **Webhook Component**: Receive external events
- **Embedded Chat Component**: Embed into HTML/React/Angular apps

### Component Types

- **Core Components**: Built-in core features not tied to specific providers
- **Bundle Components**: Third-party integrations packaged as bundles
- **Input/Output Components**: Chat and text I/O for conversational and string flows
- **Custom Components**: User-defined Python components

## Core Concept Relationships

- **Flows** organize AI logic and connect components to form pipelines
- **Components** provide functional units and connect via ports
- **Agents** coordinate tools and reasoning within flows
- **APIs/MCP** expose flows to external systems

## Core Features

### Visual Flow Building

- **Drag-and-Drop Interface**: Intuitive visual editor to build complex flows without coding
- **Real-time Testing**: Built-in Playground provides instant feedback
- **Template Library**: Extensive pre-built flow templates for quick project starts
- **Code Access**: View and customize Python code for all components

### Multi-model and Provider Support

- **LLM Support**: Supports multiple large language model providers (check Langflow's component menu for specific providers)
- **Embedding Models**: Supports multiple embedding model providers
- **Vector Databases**: Supports multiple vector databases
- **Tool Integration**: Rich third-party tools and API integrations
- **Custom Components**: Python code to implement any functionality
- **Bundle Ecosystem**: Growing third-party component library, developers can check Langflow's component menu for the latest list

### Development and Production Environments

- **IDE Mode**: Full development and testing environment (frontend + backend)
- **Runtime Mode**: API service for production (backend only)
- **Headless Deployment**: Supports backend-only deployment without UI
- **Containerization**: Docker and Kubernetes support

### Enterprise Features

- **User Authentication**: Built-in user management system supporting username/password and token authentication
- **Access Control**: Fine-grained access control with superuser and regular user support
- **Database**: Supports PostgreSQL high availability configuration, recommended for production
- **Monitoring and Logging**: Integrates LangSmith and LangFuse for complete observability
- **Security Configuration**: Enterprise security best practices
- **Environment Variable Management**: API key and authentication configuration
- **Global Variables**: Cross-flow variable management

### Advanced Features

- **Component Freeze**: Freeze components to save output state and improve performance
- **Component Inspection**: View output and logs for individual components
- **Tweaks**: Temporarily override flow settings at runtime
- **Tool Mode**: Combine components as tools with agents
- **Memory Management**: Supports conversation history and context memory
- **Session ID**: Manages multi-session and multi-user interactions

### Integration and Deployment

- **REST API**: Standardized API interface, auto-generating Python, JavaScript, and curl code snippets
- **MCP Protocol**: Seamless integration with MCP clients, supports both MCP server and client roles
- **Export Functionality**: Export flows as JSON and Python code
- **Embedded Components**: Can be embedded in HTML, React, or Angular applications
- **Cloud-native**: Supports Kubernetes, Docker Compose, Docker, local installation, and other deployment methods
- **Environment Variables**: Flexible configuration and environment management

### Project Management

- **Project Organization**: Supports multiple projects and flow management, projects organize related flows like folders
- **File Management**: Upload, store, and manage files, files are organized by user and can be used by multiple flows
- **Flow Export and Import**: Export flows as JSON files, transferable between different instances
- **Flow Duplication**: Copy existing flows to create new versions
- **Shareable Playground**: Share test interface with other users for interactive testing

### Application Scenarios

Langflow can help develop various AI applications:

- **Chatbots**: Conversational AI applications
- **Document Analysis Systems**: Intelligent document processing and Q&A
- **Content Generators**: Automated content creation
- **Intelligent Agent Applications**: Autonomous AI agents performing tasks
- **Knowledge Base Q&A**: Document-based intelligent Q&A
- **Data Analysis**: AI-driven data analysis tools

## Documentation and References

Langflow provides complete official documentation and API references to help users deeply understand and use platform features:

### Official Documentation
- **Main Documentation**: [https://docs.langflow.org/](https://docs.langflow.org/)
  - Detailed introduction to Langflow's core concepts and usage workflows
  - Includes installation guides, quick start, and best practices
  - Provides common use cases, example code, tutorials, and API references

### Community Support
- **GitHub Repository**: [https://github.com/langflow-ai/langflow](https://github.com/langflow-ai/langflow)
- **Discord Community**: Join Discord server for help and discussions
- **Contribution Guide**: Welcome contributions for new features, fixes, and documentation improvements

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

By default, `LoadBalancer` is used to provide access address

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

If you want to configure `Alauda Container Platform` as OIDC Provider, configure as follows:
- `oauth2_proxy.oidcIssuer` is the platform access address plus `/dex`
- `oauth2_proxy.oidcClientID` is fixed as `langflow`
- `oauth2_proxy.oidcClientSecret` is fixed as `ZXhhbXBsZS1hcHAtc2VjcmV0`

You also need to create an OAuth2Client resource in the global cluster to configure Langflow's client information:

```yaml
apiVersion: dex.coreos.com/v1
kind: OAuth2Client
metadata:
  name: nrqw4z3gnrxxps7sttsiiirdeu
  namespace: cpaas-system
id: langflow                                    # Consistent with oauth2_proxy.oidcClientID in values
name: Langflow
secret: ZXhhbXBsZS1hcHAtc2VjcmV0                # Consistent with oauth2_proxy.oidcClientSecret in values
redirectURIs:
- http://xxx.xxx.xxxx.xxx:xxxxx/*               # OAuth2-Proxy access address, acquisition method described below
                                                # If multiple Langflow instances are deployed, add multiple access addresses here
```

**Note**: OAuth2 Proxy access address can be obtained from the `<Application Name>-oauth2-proxy` Service, use the appropriate access method based on Service type.

After enabling OAuth2 Proxy, it is recommended to:
- Set `langflow.service.type` to `ClusterIP`, allowing access only within the cluster, users need to access Langflow through OAuth2 Proxy address.
- Set `langflow.auth.enabled` to `false`, use OAuth2 Proxy to handle login authentication.

Users can log out by accessing `/oauth2/sign_out`.

### 6. Configure Runtime Mode (Backend-Only)

Runtime mode is the recommended deployment method for production environments, deploying only the Langflow backend API service without a visual interface.

#### 6.1 Enable Runtime Mode

Runtime mode (backend-only) can be enabled by setting the following fields:

```yaml
langflow:
  backendOnly: true                              # Enable backend-only mode
  env:
    - name: LANGFLOW_LOAD_FLOWS_PATH             # Set the path to load Flows
      value: "/app/flows"
  volumes:
    - name: flows                                # Load Flows content through volume
      persistentVolumeClaim:
        claimName: langflow-flows-pvc
  volumeMounts:                                  # Mount volume to specified path
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

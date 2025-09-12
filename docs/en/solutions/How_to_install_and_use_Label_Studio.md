---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.x
---
# Label Studio

## Overview

Label Studio is an open-source multi-type data labeling and annotation tool that provides standardized output formats. It supports data labeling for multiple data types, including images, audio, text, time series, and video.

It contains the following main components:
- **Backend Service**: Django-based Python web service providing REST API, Python SDK, and machine learning integration
- **Frontend Interface**: React-based web UI providing complete annotation interface, including project management, data management, annotation tools, and result export
- **Database**: Supports PostgreSQL 13+ database for storing project data and annotation results
- **Cache System**: Redis for caching and task queue management (optional)

Label Studio helps teams build and maintain high-quality data labeling workflows: from simple image classification to complex multi-modal data annotation tasks.

## Core Concepts

### Project

Projects are the basic organizational unit for data labeling in Label Studio, including:

- **Project Settings**: Annotation configuration, data import settings, user permissions, etc.
- **Data Management**: Data import, storage, and version control
- **Annotation Interface**: Configurable annotation tools and interface
- **Annotation Results**: Storage and management of annotation data

Each project has independent configuration and data space, supporting multi-user collaborative annotation.

### Labeling Interface

The labeling interface is the core tool for users to perform data annotation, supporting:

- **Multiple Annotation Types**: Image classification, object detection, text classification, named entity recognition, etc.
- **Configurable Interface**: Customize annotation interface through configuration language
- **Template Support**: Provides various predefined annotation templates
- **Shortcut Support**: Shortcut functions to improve annotation efficiency

The labeling interface uses a specially designed configuration language that can flexibly adapt to various annotation needs.

### Data Manager

The data manager is the core management tool for project data, providing:

- **Data Import**: Support importing data from files, cloud storage (AWS S3, Google Cloud Storage)
- **Data Formats**: Support JSON, CSV, TSV, and other formats
- **Data Preview**: View and preview data to be annotated
- **Data Filtering**: Filter data by status, annotator, labels, and other conditions

The data manager supports batch operations and advanced search functionality.

### Annotations

Annotations are labels and comments added by users to data, including:

- **Annotation Data**: Labels, bounding boxes, segmentation regions added by users
- **Annotation Metadata**: Annotation time, annotator, confidence, and other information
- **Annotation Status**: Draft, completed, skipped, and other statuses
- **Annotation Quality**: Annotation quality scoring and validation

Annotation data is stored in standardized JSON format for easy subsequent processing and analysis.

### Machine Learning Integration

Label Studio provides powerful machine learning integration capabilities:

- **Pre-annotation**: Use machine learning models for pre-annotation to improve efficiency
- **Online Learning**: Real-time training and model updates during annotation
- **Active Learning**: Intelligently select complex samples that need annotation
- **Model Comparison**: Compare prediction results from different models

Supports multiple machine learning frameworks and model formats.

## Core Concept Relationships

- **Projects** are the basic containers for organizing annotation tasks and data
- **Labeling Interfaces** define how users interact with data for annotation
- **Data Managers** handle data import, storage, and organization within projects
- **Annotations** store the actual labeling results and metadata
- **Machine Learning Integration** connects external models for pre-annotation and active learning

## Main Features

### Multi-user Annotation

- **User Management**: Supports user registration, login, and basic permission management
- **Collaborative Annotation**: Multiple users annotating the same project simultaneously
- **Annotation Assignment**: Flexible task assignment and progress tracking
- **Quality Control**: Annotation quality assessment and consistency checking

### Multi-type Data Support

- **Image Data**: Image classification, object detection, semantic segmentation
- **Text Data**: Text classification, named entity recognition, sentiment analysis
- **Audio Data**: Audio classification, speech recognition, audio transcription
- **Video Data**: Video classification, object tracking, action recognition
- **Time Series**: Time series classification, event recognition
- **Multi-modal Data**: Supports combined annotation like image+text, video+audio

### Flexible Annotation Configuration

- **Configuration Language**: Use XML configuration language to define annotation interface
- **Template Library**: Provides various predefined annotation templates
- **Annotation Tools**: Supports multiple built-in annotation tools
- **Interface Customization**: Supports basic interface configuration and layout

### Data Import/Export

- **Multiple Formats**: Supports common formats like JSON, CSV
- **Data Import**: Supports importing data from local files and URLs
- **Data Export**: Supports exporting annotation results in multiple formats
- **Batch Operations**: Supports batch import and export of data

### Machine Learning Integration

- **ML Backend**: Supports basic machine learning backend integration
- **Pre-annotation**: Supports using model prediction results for pre-annotation
- **API Integration**: Provides REST API and Python SDK for integration

## Documentation and References

Label Studio provides comprehensive official documentation and API references to help users understand and use platform features in depth:

### Official Documentation
- **Main Documentation**: [https://labelstud.io/guide/](https://labelstud.io/guide/)
  - Detailed introduction to Label Studio's core concepts and workflows
  - Includes installation guides, quick start, and best practices
  - Provides common use cases, example code, tutorials, and API references

# Label Studio Deployment Guide

This document provides detailed instructions on how to deploy Label Studio to a Kubernetes cluster and common configuration parameters.

## Publishing

Download the Label Studio installation file: `label-studio.ALL.v1.20.0-1.tgz`

Use the violet command to publish to the platform repository:
```bash
violet push --platform-address=platform-access-address --platform-username=platform-admin --platform-password=platform-admin-password label-studio.ALL.v1.20.0-1.tgz
```

## Deployment

### Prepare Storage

Label Studio stores data in a database and requires persistent storage. The cluster needs to have CSI pre-installed or `PersistentVolume` pre-prepared.

### Prepare Database

Label Studio supports the following databases:
- **PostgreSQL**: Version 13 or higher

The `PostgreSQL operator` provided by `Data Services` can be used to create a `PostgreSQL cluster`.

Check the access address and password in the `PostgreSQL` instance details in `Data Services`.

### Prepare Redis (Optional)

Redis is not required but recommended for production environments.

`Data Services` can be used to create a `Redis` instance.

**Note:** Label Studio only supports accessing Redis in `standalone` mode.

* Create a `Redis` in `standalone` mode:

  1. When creating the `Redis` instance, select `Redis Sentinel` for `Architecture`.

  2. After setting all parameters, switch to `YAML` mode, change `spec.arch` to `standalone`, then click the `Create` button.

  3. After creation, switch to the `Alauda Container Platform` view and find the `Service` named `rfr-<Redis instance name>-read-write`, which is the access address for this Redis instance.

### Create Application

1. Go to the `Alauda Container Platform` view and select the namespace where Label Studio will be deployed.

2. In the left navigation, select `Applications` / `Applications`, then click the `Create` button on the right page.

3. In the popup dialog, select `Create from Catalog`, then the page will jump to the `Catalog` view.

4. Find `3rdparty/chart-label-studio` and click `Create` to create this application.

5. On the `Catalog` / `Create label-studio` form, fill in the `Name` (recommended as `label-studio`) and `Custom` configuration in `Values`, then click the `Create` button to complete creation. The `Custom` content will be described below. It can also be modified after creation through the `Update` application method.

## Configuration

Users can modify the `Custom Values` of the `Application` to adjust configuration. The main configurations to focus on are as follows:

### 1. Configure Storage

#### 1.1 Configure Storage Class and Storage Size

The storage class can be specified by adding the following configuration:

```yaml
label-studio:
  persistence:
    storageClass: storage-class-name
    size: 20Gi                               # Replace with the actual required space size
```

### 2. Configure Database

#### 2.1 Configure PostgreSQL

PostgreSQL access information can be configured by setting the following fields:

```yaml
global:
  pgConfig:
    host: localhost                          # PostgreSQL access address
    port: 5432                               # PostgreSQL access port, default: 5432
    dbName: labelstudio                      # Database name, note: database will be created automatically
    userName: postgres                       # Database username
    password:
      secretName: postgre-secret             # Secret name storing database access password
      secretKey: password                    # Secret key storing database access password
```

#### 2.2 Configure Redis

Redis access information can be configured by setting the following fields:

```yaml
global:
  redisConfig:
    host: "redis://your-redis-host:6379/1"    # Redis connection address, format: redis://[:password]@host:port/db
    password:                                 # Optional, password can be included in host or provided separately via Secret
      secretName: "redis-secret"              # Secret name storing Redis access password
      secretKey: "password"                   # Secret key storing Redis password
    ssl:                                      # Optional
      redisSslCertReqs: "optional"            # SSL certificate requirements: "" means not required, "optional", "required"
      redisSslSecretName: "redis-ssl-secret"  # SSL certificate Secret name
      redisSslCaCertsSecretKey: "ca.crt"      # CA certificate Secret key
      redisSslCertFileSecretKey: "tls.crt"    # Client certificate Secret key
      redisSslKeyFileSecretKey: "tls.key"     # Client private key Secret key
```

### 3. Configure Access Method

By default, `LoadBalancer` is used to provide access address

#### 3.1 Modify Service Type

The `Service` type can be modified by setting the following fields:

```yaml
label-studio:
  app:
    service:
      type: LoadBalancer                     # Can be changed to NodePort or ClusterIP
```

#### 3.2 Enable Ingress

Ingress can be configured by setting the following fields. After enabling Ingress, the Service type is usually changed to ClusterIP:

```yaml
label-studio:
  app:
    ingress:
      enabled: true                          # Enable Ingress functionality
      host: localhost                        # Access domain (must be DNS name, not IP address)
      tls:
        - secretName: certificate-secret     # Secret name storing TLS certificate
global:
  extraEnvironmentVars:
    LABEL_STUDIO_HOST: https://label-studio.example.com       # Web access URL for frontend resource loading
```

### 4. Configure User Management

#### 4.1 Disable User Registration

User registration can be disabled by setting the following fields:

```yaml
global:
  extraEnvironmentVars:
    LABEL_STUDIO_DISABLE_SIGNUP_WITHOUT_LINK: true
```

## Access Address

### 1. Access via Service

`Label Studio` provides external access through `Service`. Check its `Service` to get the access address.

The `Service` name is: `<Application Name>-ls-app`.

If the `Service` type is `LoadBalancer` and the load balancer controller in the environment has assigned an access address, please access through that address.

If the `Service` type is `LoadBalancer` or `NodePort`, access is available through `node IP` with its `NodePort`.

### 2. Access via Ingress

If Ingress is enabled, please access through the configured LABEL_STUDIO_HOST.

## User Management

Label Studio has no default username and password. Users can complete new user registration by filling in email and password on the login page.

**Note**:
- Default configuration allows anyone to register new users
- All users have the same functional permissions and can access all projects
- To restrict user registration, configure the environment variable `LABEL_STUDIO_DISABLE_SIGNUP_WITHOUT_LINK=true` (see: [4.1 Disable User Registration](#41-disable-user-registration))

# Label Studio Quickstart

For Label Studio quickstart guide, please refer to the official documentation: [Getting Started With Label Studio: A Step-By-Step Guide](https://labelstud.io/learn/getting-started-with-label-studio/)
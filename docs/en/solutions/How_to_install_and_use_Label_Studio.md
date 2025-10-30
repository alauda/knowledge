---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.x
id: KB1757664849-0DAB
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

## S3 Integration

Label Studio supports integration with S3-compatible storage for importing data and exporting annotations. This includes Amazon S3, MinIO, and other S3-compatible storage services.

### Prerequisites

- S3-compatible storage bucket with appropriate permissions
- Access credentials (Access Key ID and Secret Access Key)

#### Using ACP MinIO as S3 Storage

> Note: ACP MinIO is only one optional choice. You may use any S3-compatible storage (e.g., Amazon S3, Ceph RGW, etc.).

You can use the built-in MinIO from ACP as S3 storage:

1. **Object Storage**: In Administrator view, go to `Storage` / `Object Storage` to check if MinIO is already created. If not, click **Configure Now** to start the setup process.

2. **Deploy MinIO Operator**: The `Create Object Storage` process has two steps. First, click **Deploy Operator** to deploy the MinIO Operator following the page guidance.

3. **Create MinIO Cluster**: After the MinIO Operator is deployed, proceed to the second step `Create Cluster`. Fill in the required information:
   - **Name**: Cluster name
   - **Access Key** and **Secret Key**: Administrator credentials
   - **Resource Configuration**: Resource allocation settings
   - **Storage Pool Configuration**: Storage pool settings
   - **Access Configuration**: Access method settings

   Click **Create Cluster** to create the MinIO Cluster.

4. **Get Access Information**: The MinIO Cluster access address can be found in the **Access Method** tab.

5. **Manage Buckets and Credentials**: Use `mc` client to access the MinIO Cluster, create buckets, and generate low-privilege Access Keys/Secret Keys. See [MinIO Client Documentation](https://docs.min.io/community/minio-object-store/reference/minio-mc.html) for usage details.

### Using S3 with Label Studio

1. **Access Storage Settings**
   - Open Label Studio project
   - Go to **Settings** > **Cloud Storage**

2. **Add Source Storage**
   - Click **Add Source Storage**
   - Select **AWS S3** as storage type
   - Fill in the required information:
     - **Storage Title**: Name for the storage connection
     - **Bucket Name**: S3 bucket name
     - **Region Name**: Storage region (e.g., us-east-1 for AWS S3, can be empty for MinIO)
     - **S3 Endpoint**: Optional custom S3 endpoint (leave empty for AWS S3, required for MinIO)
     - **Access Key ID**: Access key
     - **Secret Access Key**: Secret key
     - **Session Token**: Optional session token for temporary credentials
     - **Bucket Prefix**: Optional path prefix in the bucket (e.g., `data/`, `input/`)
     - **File Filter Regex**: Optional regex to filter files (e.g., `.*csv` or `.*(jpe?g|png|tiff)`)
   - Configure optional settings:
     - **Treat every bucket object as a source file**: Check for media files, uncheck for JSON task files
     - **Recursive scan**: Enable to scan subdirectories recursively
     - **Use pre-signed URLs**: Enable for direct browser access to S3 (recommended)
     - **Expiration minutes**: URL expiration time (default: 15 minutes) when **Use pre-signed URLs** enabled
   - Click **Check Connection** to test connectivity
   - Click **Add Storage** to create the storage connection

3. **Add Target Storage** (Optional)
   - Click **Add Target Storage** to export annotations to S3
   - Fill in similar S3 parameters like Source Storage
   - Additional Target Storage parameters:
     - **SSE KMS Key ID**: Optional KMS key for server-side encryption
   - Configure optional settings:
     - **Can delete objects from storage**: Enable to allow deletion of annotations from storage
   - Click **Check Connection** to test connectivity
   - Click **Add Storage** to create the storage connection

4. **Upload Data to S3**
   - Upload data files to the configured S3 bucket and prefix path
   - Ensure data files are accessible with the configured access credentials
   - Use `mc` client or AWS CLI for bulk uploads

5. **Import Data**
   - Click **Sync Storage** under `Source Cloud Storage` to import data from S3
   - Use sync whenever new data is added to the S3 bucket

6. **Perform Annotations**
   - Access the imported data in Label Studio interface
   - Complete annotations using the configured labeling interface

7. **Export Annotations**
   - Click **Export** button to download annotation results in various formats (JSON, CSV, etc.)
   - Or click **Sync Storage** for `Target Cloud Storage` to push annotations to S3
   - **Note**: Target Storage exports annotations in JSON format only. Use Label Studio SDK to convert JSON annotations to other formats (CSV, COCO, Pascal VOC, YOLO, etc.). See [SDK converter](https://github.com/HumanSignal/label-studio-sdk/tree/master/src/label_studio_sdk/converter) for details.

8. **Apply Data and Annotations to Model Training/Validation**
   - Download training data and annotations from S3 using `mc` client or AWS Python SDK (boto3). See [S3 examples](https://boto3.amazonaws.com/v1/documentation/api/latest/guide/s3-examples.html) for implementation details.
   - Convert annotation format using Label Studio SDK if needed.
   - Integrate data into machine learning pipelines.
   - Use annotations for model training or validation.

### Storage Structure Suggestions

- Use different buckets or different path prefixes for different projects to avoid data conflicts.
- Target and Source can use the same S3 bucket with different path prefixes (e.g., `input/` for source, `output/` for target), or use different buckets for better data isolation and access control.

## Additional Resources

For more Label Studio tutorials and guides, see [Getting Started With Label Studio](https://labelstud.io/learn/getting-started-with-label-studio/)
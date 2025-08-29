---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.x
---
# Featureform

## Overview

Featureform is an open-source machine learning feature platform designed for building, managing, and deploying machine learning features.

It simplifies the feature engineering workflow, enabling data scientists and machine learning engineers to focus on model development rather than dealing with feature infrastructure complexity.

## Core Concepts

### Feature

Features are input data that machine learning models use to make predictions. In Featureform, features contain the following core components:

- **Entity Column**: Serves as the primary key or index, identifying the object to which the feature belongs
- **Value Column**: The specific numerical or categorical value of the feature
- **Timestamp Column**: Optional time information for tracking how features change over time

Features are the core input for machine learning model training and inference, associated with entities to provide the information needed for predictions.

Features are not raw data, but rather the results of data source processing and transformation.

Raw data needs to go through Featureform's data source registration, transformation processing, and other steps to become usable features. High-quality features directly impact the performance of training models.

For example:
- In fraud detection, raw data consists of user transaction records including transaction amounts, customer birth dates, customer locations, etc., but the features used for training are the customer's average transaction values.

### Label

Labels are the target variables that machine learning models aim to predict. In supervised learning, labels are known correct answers, and models learn the relationship between features and labels to make predictions.

For example:
- In fraud detection, the label for each transaction is "fraudulent" or "normal"

### Entity

Entities are the objects described by features and labels, serving as the primary key or index for the data.

For example:
- **Customer**: User ID, Customer ID, etc.

Entities serve as the bridge connecting features and labels, allowing multiple features and labels to be organized together to form complete training data. In Featureform, entities are defined through decorators and can be associated with multiple features and labels.

### TrainingSet

Training sets are data collections used for training machine learning models, automatically connected through the entity fields defined in features and labels. Training sets contain:

- **Feature Values**: Input data for model training
- **Label Values**: Target values that the model aims to predict

Training sets organize features, labels, and entities together to provide complete data structures for model training. Entity associations are implemented by specifying entity columns (such as user ID, product ID, etc.) when defining features and labels. The Featureform system automatically connects data based on these entity columns.

## Core Concept Relationships

- **Entities** are the subjects of data, defining the objects we want to analyze
- **Features** are associated with entities, providing attribute information needed for predictions
- **Labels** are the targets we want to predict
- **Training Sets** organize features, labels, and entities together to form complete training data

## Provider (Data Infrastructure Provider)

Providers are backend systems in Featureform responsible for data storage and computation. They provide:

- **Offline Storage**: Store raw data, execute data transformations, build training sets (e.g., PostgreSQL, BigQuery, Spark, etc.)
- **Online Storage**: Provide low-latency feature services for real-time inference (e.g., Redis, Pinecone, etc.)
- **File Storage**: Provide underlying storage support for certain offline storage systems (e.g., S3, HDFS, Azure Blob, etc.)

Providers adopt a virtual feature store architecture, allowing data scientists to use unified abstract interfaces on existing infrastructure while data remains in the original systems.

## Immutable API Design

Featureform adopts an immutable API design, which is a key feature that distinguishes it from other feature platforms. In Featureform, all features, labels, and training sets are immutable after creation, meaning:

- **Resources Cannot Be Modified**: Once features, labels, or training sets are created and applied, their definitions and logic cannot be changed
- **Version Management**: If modifications are needed, new variants must be created instead of overwriting existing resources
- **Collaboration Safety**: Team members can safely use resources created by others without worrying about upstream logic changes
- **Experiment Management**: Support for creating multiple variants for experiments, each with independent lifecycles

This design ensures consistency and reliability of machine learning resources, avoiding training failures or inference errors caused by resource modifications. Through the variant system, data scientists can manage different versions of resources while maintaining production environment stability.

## Variant

Variants are the core mechanism in Featureform for implementing version management and experiment support. Each feature, label, or training set can have multiple variants, with each variant representing different versions or experimental configurations.

### Variant Benefits

- **Version Management**: Create different versions for the same resource, supporting A/B testing and experiments
- **Experiment Support**: Allow data scientists to try different feature engineering methods without affecting production environments
- **Collaborative Development**: Team members can develop different variants in parallel without mutual interference
- **Rollback Support**: When new versions have issues, quickly rollback to previous stable versions

## Documentation and References

Featureform provides comprehensive official documentation and SDK references to help users understand and use platform features effectively:

### Official Documentation
- **Main Documentation**: [https://docs.featureform.com/](https://docs.featureform.com/)
  - Comprehensive introduction to Featureform's core concepts and workflows
  - Includes architecture design, deployment guides, and best practices
  - Provides common use cases and example code

### SDK References
- **Python SDK**: [https://sdk.featureform.com/](https://sdk.featureform.com/)
  - Complete Python API reference documentation
  - Supports local mode and hosted instances
  - Includes detailed descriptions of all operations such as registration, application, and serving

## System Architecture

Featureform adopts a microservices architecture with the following core components:

### Core Services

1. **API Server**
   - Provides gRPC API interfaces
   - Acts as a gRPC gateway, forwarding requests to Metadata Service and Feature Server
   - Provides unified resource management and feature service interfaces externally

2. **Coordinator**
   - Monitors task changes in etcd
   - Coordinates task scheduling and execution
   - Manages various Runners to execute specific tasks

3. **Feature Server**
   - Provides feature services (online feature queries, batch feature services)
   - Provides training data services (training set data, column information)
   - Provides vector search functionality (supporting embedding features)

4. **Metadata Service**
   - Provides gRPC interfaces for metadata management
   - Stores definitions and metadata for all resources (features, labels, training sets, source data, etc.)
   - Manages dependencies and states between resources

### Data Storage

1. **etcd**
   - Stores configuration information and cluster state
   - Provides distributed locks and coordination services

2. **Meilisearch**
   - Provides search functionality for features and metadata
   - Supports full-text search and fuzzy matching
   - Data source: Metadata Service automatically writes when resources change, Metadata Dashboard writes when labels are updated

### Monitoring and Observability

1. **Prometheus**
   - Collects system metrics and performance data
   - Provides metric query support for Dashboard

2. **Dashboard**
   - Provides web interface for viewing system status
   - Displays feature statistics, performance metrics, and resource information
   - Pure frontend page, only provides read-only viewing functionality

3. **Metadata Dashboard**
   - Provides HTTP API interfaces to access metadata services
   - Converts Metadata Service's gRPC interfaces to HTTP interfaces
   - Provides resource queries, search, and label management functionality for Dashboard frontend
   - Supports source data preview and file statistics

### Network and Access

1. **Ingress Controller (Nginx)**
   - Manages external traffic routing and load balancing
   - Provides SSL termination and reverse proxy
   - Handles HTTP requests and caching functionality

## Component Call Relationships

```
User → Dashboard
          ↓
   Ingress Controller (Nginx)
     ↓                   ↓
  Prometheus       Metadata Dashboard → Meilisearch
     │                ↓        ↓        ↑
     │ Coordinator → etcd ← Metadata Service ← API Server ← SDK Client
     │                ↑        ↑                  │
     └────────────→ Feature Server ←──────────────┘

```
# Featureform Deployment Guide

This document provides detailed instructions on how to deploy Featureform to a Kubernetes cluster, along with essential configuration parameters.

## Publishing

Download the Featureform installation file: `featureform.amd64.v0.12.1-1.tgz`

Use the violet command to publish to the platform repository:
```bash
violet push --platform-address=platform-access-address --platform-username=platform-admin --platform-password=platform-admin-password featureform.amd64.v0.12.1-1.tgz
```

## Deployment

### Limitations

  **Only one `Featureform` application is allowed per namespace.**

  Deploying multiple instances in the same namespace may cause resource conflicts and other issues.

  **Architecture Support Limitation: Only supports x86 architecture, does not support ARM architecture.**

### Storage Preparation

  Featureform data is stored in etcd, which requires persistent storage for data persistence.
  The cluster needs to have CSI installed or `create local storage` (method described below, limited to non-production environments).

#### Creating Local Storage

  Use kubectl create to create the following resources, which can prepare local directories as PersistentVolumes for use.

```yaml
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: etcd-1
spec:
  capacity:
    storage: 10Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  local:
    path: /var/lib/etcd-1
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - xxx.xxx.xxx.xxx
```
Notes:

  1. The path specified in spec.local.path must exist and be set to 777 permissions, for example:
    ```bash
    mkdir -p /var/lib/etcd-1
    chmod 777 /var/lib/etcd-1
    ```

  2. Replace the placeholder values xxx.xxx.xxx.xxx in matchExpressions according to your environment.

  3. When deploying high-availability etcd, prepare multiple `PersistentVolume` according to the number of replicas.

###

### Creating Application

  1. Go to the `Alauda Container Platform` view and select the namespace where Featureform will be deployed.

  2. In the left navigation, select `Applications` / `Applications`, and click the `Create` button on the right side of the opened page.

  3. In the popup dialog, select `Create from Catalog`, then the page will jump to the `Catalog` view.

  4. Find `3rdparty/chart-featureform`, then click `Create` to create this application.

  5. On the `Catalog` / `Create featureform` form, fill in the `Name` (recommended to fill in as `featureform`) and `Custom` configuration in `Values`, then click the `Create` button to complete the creation. The content of `Custom` will be described below. You can also modify it after creation through the `Update` application method.

## Configuration

  Users can modify the `Custom Values` of the `Application` to adjust configurations. The key configurations are:

### 1. Configuring Image Repository

#### 1.1 Configuring Image Repository Address

  Although the `Chart` has already configured `ImageWhiteList` to automatically replace images used by workloads.

  However, when using Kubernetes Jobs to run `Featureform` tasks, image pull failures can cause task failures. Therefore, it's recommended to configure the correct image registry address.

  The configuration field is as follows:

  ```yaml
  global:
    repo: <Image Repository Address>/3rdparty/featureformcom

  ```

  How to obtain the `Image Repository Address`:
  - In the `Administrator` view, check the `Image Repository Address` field under the `Overview` Tab page of the corresponding cluster details page.

#### 1.2 Configuring Image Repository Pull Credentials

  If authentication is required when pulling images from the image repository, add the following configuration:
  ```yaml
  global:
    registry:
      imagePullSecrets:
      - name: global-registry-auth
    # for etcd
    imagePullSecrets:
    - global-registry-auth
  ingress-nginx:
    imagePullSecrets:
    - name: global-registry-auth
  meilisearch:
    image:
      pullSecret: global-registry-auth
  ```

### 2. Configuring etcd

#### 2.1 Configuring Anti-Affinity

  When using storage on local node disks (e.g., topolvm), to ensure high availability, etcd pods need to run on different nodes. Add the following configuration to achieve this:
  ```yaml
  etcd:
    podAntiAffinityPreset: hard
  ```

#### 2.2 Configuring Storage Class

  Specify the storage class by adding the following configuration:

  ```yaml
  global:
    storageClass: storage-class-name
  ```

## Access Addresses

### 1. External Access Address

`Featureform` provides external access through `nginx-ingress-controller`. Check its `Service` to obtain the access address.

The `Service` name is: `application-name-ingress-nginx-controller`.

This `Service` type is `LoadBalancer`. If there is no `LoadBalancer` controller in the environment to provide external IP, you can access it through `node IP` plus its `NodePort`.

### 2. API Access Address

`Featureform` SDK requires access to the API service `featureform-api-server`.

To access the API within the cluster, you can access it through the `ClusterIP` of `featureform-api-server` plus port 7878.

  **Note:**

  Although the ingress configuration contains API access addresses, since ingress has enabled client certificate verification mechanism, and Featureform SDK currently does not support configuring client certificates, API services cannot be accessed through ingress paths.

# Featureform Quickstart

The [quickstart directory](featureform/quickstart/) contains a quick start demonstration of Featureform.

## Overview

This Quickstart demonstration will walk you through the following three main steps:

1. **Prepare Data** - Set up PostgreSQL database and load demo data

2. **Configure Featureform** - Define resources such as data sources, features, and training sets

3. **Simulate Training and Querying** - Use defined features for model training and feature querying

Through this demonstration, you will learn how to use Featureform to build feature engineering pipelines, from raw data to usable machine learning features.

## File Descriptions

- [setup-env.sh](featureform/quickstart/setup-env.sh) - Sets environment variables used by the demo
- [load-data.py](featureform/quickstart/load-data.py) - Database preparation script for connecting to PostgreSQL and executing data.sql
- [data.sql](featureform/quickstart/data.sql) - PostgreSQL database dump file containing demo data
- [definitions.py](featureform/quickstart/definitions.py) - Featureform resource definition file
- [training.py](featureform/quickstart/training.py) - Training script
- [serving.py](featureform/quickstart/serving.py) - Serving script
- [requirements.txt](featureform/quickstart/requirements.txt) - Python dependency packages

## Usage Steps

### 1. Prepare PostgreSQL and Redis

  Ensure you have available PostgreSQL and Redis services. You can start them in the following ways:

#### Prepare PostgreSQL

  Use the `PostgreSQL operator` provided by `Data Services` to create a `PostgreSQL cluster`.

  Check the access address and access password in the `PostgreSQL` instance details of `Data Services`.

#### Prepare Redis

  Use `Data Services` to create a `Redis` instance.

  **Note:** Featureform only supports accessing Redis in `standalone` mode.

  * Create `Redis` in `standalone` mode:

    1. When creating a `Redis` instance, select `Redis Sentinel` for `Architecture`.

    2. After setting all parameters, switch to `YAML` mode, change `spec.arch` to `standalone`, then click the `Create` button.

    3. After creation, switch to the `Alauda Container Platform` view and look for the `Service` named `rfr-<Redis instance name>-read-write`, which is the access address for this Redis instance.

### 2. Install Dependencies

  **Python Version Requirements:**
  - Supports Python 3.7 - 3.10

```bash
pip install -r requirements.txt
```

### 3. Configure Environment Variables

  Edit the `setup-env.sh` file to set database connection information, then use the following command to export environment variables:

```bash
source setup-env.sh
```

#### setup-env.sh File Content Description

  The `setup-env.sh` file contains all environment variable configurations required for the demo:

```bash
#!/bin/bash

# Featureform configuration
export FF_GET_EQUIVALENT_VARIANTS=false
export FEATUREFORM_HOST=localhost:7878
export FEATUREFORM_VARIANT=demo

# PostgreSQL database connection configuration
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_USER=postgres
export POSTGRES_PASSWORD=password
export POSTGRES_DATABASE=postgres
export POSTGRES_SSLMODE=require

# Redis connection configuration
export REDIS_HOST=localhost
export REDIS_PORT=6379
export REDIS_PASSWORD=""
```

**Important Notes:**

- **FF_GET_EQUIVALENT_VARIANTS**: Must be set to `false` to avoid getting incorrect variant versions

- **FEATUREFORM_HOST**: `Featureform` API address, please configure according to your environment

- **FEATUREFORM_VARIANT**: Since Featureform adopts an immutable API without providing delete and update interfaces, to re-execute, modify this value to a new one, then re-execute `source setup-env.sh`, otherwise errors may occur

- **POSTGRES_xx**: Please configure according to your environment

- **REDIS_xx**: Please configure according to your environment

### 4. Run Database Preparation Script

```bash
python load-data.py
```

This script will:
- Connect to the PostgreSQL database
- Create necessary databases (if they don't exist)
- Execute all SQL statements in the data.sql file
- The SQL statements in data.sql include creating the transactions table and inserting demo data

#### Demo Data Description

The `data.sql` file contains a transaction dataset for demonstrating fraud detection scenarios:

- The `transactions` table contains the following fields:
  - `transactionid` - Transaction ID
  - `customerid` - Customer ID
  - `customerdob` - Customer date of birth
  - `custlocation` - Customer location
  - `custaccountbalance` - Customer account balance
  - `transactionamount` - Transaction amount
  - `timestamp` - Transaction timestamp
  - `isfraud` - Whether it's a fraudulent transaction (label)

This dataset can be used to train machine learning models to detect fraudulent transactions.

### 5. Run Featureform Definitions

```bash
python definitions.py
```

This script is the core of the Featureform demonstration, which will register and define all necessary resources. The main components are:

#### 5.1 Register Users and Providers

```python
# Register default user
ff.register_user("demo").make_default_owner()

# Register PostgreSQL provider
postgres = ff.register_postgres(
    name=f"postgres-{variant}",
    host=os.getenv("POSTGRES_HOST", "localhost"),
    port=os.getenv("POSTGRES_PORT", "5432"),
    user=os.getenv("POSTGRES_USER", "postgres"),
    password=os.getenv("POSTGRES_PASSWORD", "password"),
    database=os.getenv("POSTGRES_DATABASE", "postgres"),
    sslmode=os.getenv("POSTGRES_SSLMODE", "require"),
)

# Register Redis provider
redis = ff.register_redis(
    name=f"redis-{variant}",
    host=os.getenv("REDIS_HOST", "localhost"),
    port=int(os.getenv("REDIS_PORT", "6379")),
    password=os.getenv("REDIS_PASSWORD", ""),
)
```

#### 5.2 Register Data Sources

```python
# Register transactions table
transactions = postgres.register_table(
    name="transactions",
    table="transactions",
    variant=variant,
)
```

#### 5.3 Define Feature Transformations

```python
# SQL transformation: Calculate average transaction amount for each customer
@postgres.sql_transformation(variant=variant)
def average_user_transaction():
    return f"SELECT CustomerID as user_id, avg(TransactionAmount) " \
           f"as avg_transaction_amt from {{{{transactions.{variant}}}}} GROUP BY user_id"
```

Here, raw data is transformed into new data for subsequent use.

#### 5.4 Define Entities, Features, and Labels

```python
@ff.entity
class Customer:
    # Feature: Customer average transaction amount, where avg_transaction_amt comes from the average_user_transaction transformation above
    avg_transactions = ff.Feature(
        average_user_transaction[["user_id", "avg_transaction_amt"]],
        type=ff.Float32,
        inference_store=redis,
        variant=variant,
    )

    # Label: Whether it's a fraudulent transaction
    fraudulent = ff.Label(
        transactions[["customerid", "isfraud"]],
        type=ff.Bool,
        variant=variant,
    )
```

#### 5.5 Register Training Set

```python
# Register training set, including labels and features
ff.register_training_set(
    name="fraud_training",
    label=("fraudulent", variant),
    features=[("avg_transactions", variant)],
    variant=variant,
)
```

#### 5.6 Apply Definitions

```python
# Connect to Featureform server and apply all definitions
client = ff.Client(host=os.getenv("FEATUREFORM_HOST", "localhost:7878"), insecure=True)
client.apply()
```

`client.apply()` is synchronous by default, which will wait for Featureform to start processing the training set and wait for processing to complete. This means the script will block until all resources (including the training set) are processed.

Successful execution will output results like the following:
```
Applying Run: amazed_volhard
Creating user demo
Creating provider postgres-demo
Creating provider redis-demo
Creating source transactions demo
Creating source average_user_transaction demo
Creating entity customer
Creating feature avg_transactions demo
Creating label fraudulent demo
Creating training-set fraud_training demo

COMPLETED
 Resource Type              Name (Variant)                                      Status      Error
 Provider                   postgres-demo ()                                    READY
 Provider                   redis-demo ()                                       READY
 SourceVariant              transactions (demo)                                 READY
 Transformation             average_user_transaction (demo)                     READY
 FeatureVariant             avg_transactions (demo)                             READY
 LabelVariant               fraudulent (demo)                                   READY
 TrainingSetVariant         fraud_training (demo)                               READY
```

During processing, `Status` will show `PENDING`.

When processing fails, `Status` will show `FAILED`, and `Error` will contain relevant error logs.

**This script demonstrates Featureform's core concepts:**
- **Providers**: Data source connectors (PostgreSQL, Redis)
- **Entities**: Business objects (Customer)
- **Features**: Inputs for machine learning models (avg_transactions)
- **Labels**: Training targets for models (fraudulent)
- **Training Sets**: Combinations of features and labels
- **Variants**: Support for multi-version management

### 6. Run Training Script

```bash
python training.py
```

  This script demonstrates how to use Featureform to obtain training data. Let's look at its main components:

#### 6.1 Get Training Set

```python
# Get the previously defined fraud_training training set
dataset = client.training_set("fraud_training", variant)
```

#### 6.2 Training Loop

```python
# Training loop
for i, data in enumerate(dataset):
    # training data
    print(data)
    # training process
    # do the training here
    if i > 25:
        break

```

**Script Function Description:**
- Connect to Featureform service
- Get the training set named "fraud_training"
- Iterate through training data, where each `data` contains features and labels
- In actual applications, here the data would be truly submitted to the model's training task

**Output Example:**
```
Features: [array([25.])] , Label: [False]
Features: [array([27999.])] , Label: [True]
Features: [array([459.])] , Label: [False]
Features: [array([2060.])] , Label: [True]
Features: [array([1762.5])] , Label: [False]
Features: [array([676.])] , Label: [False]
Features: [array([566.])] , Label: [False]
...
```

### 7. Run Query Script

```bash
python serving.py
```

  This script demonstrates how to use Featureform for feature querying and inference. Let's look at its main components:

#### 7.1 Feature Querying

```python
# Query features for a specific customer
customer_feat = client.features(
    features=[("avg_transactions", variant)],
    entities={"customer": "C1214240"},
)

print("Customer Result: ")
print(customer_feat)

```

**Script Function Description:**
- Connect to Featureform service
- Query the `avg_transactions` feature for customer ID "C1214240"
- This is a typical online inference scenario for real-time prediction

**Output Example:**
```
Customer Result:
[319.0]
```

**Real Application Scenarios:**
- When new customers make transactions, query the customer's average transaction amount feature in real-time
- Combined with other features, used for real-time inference in fraud detection
- Support batch querying of features for multiple customers

# FAQ

## Frequently Asked Questions

### 1. Error when executing apply:
  ```
  "UNKNOWN:Error received from peer  {grpc_message:"resource SOURCE_VARIANT xxxx (xxx) has changed. Please use a new variant.", grpc_status:13}"
  ```

  - **Cause**: The variant hasn't changed, but its associated content has changed.
  - **Solution**: Use a new variant to re-apply

### 2. Error when executing apply:
  ```
  "UNKNOWN:Error received from peer  {grpc_message:"resource not found. LABEL_VARIANT xxxx (xxx) err: Key Not Found: LABEL_VARIANT__xxxxx__xxxx", grpc_status:5}"
  ```

  - **Cause**: The referenced variant doesn't exist.
  - **Solution**: Use the correct variant to re-apply

### 3. After apply completes, `Status` is `FAILED`, `Error` is:
  ```
  transformation failed to complete: job failed while running .....
  ```

  - **Cause**: Kubernetes Job execution failed
  - **Solution**: Check Job events and logs in the Kubernetes cluster, and handle the failure based on relevant information

### 4. After apply completes, `Status` is `FAILED`, `Error` contains the following information:
  ```
  ....create table error: unknown command `HEXISTS` .....
  ```

  - **Cause**: Redis is incorrectly using Sentinel access address
  - **Solution**: Replace Redis instance or update Redis access address

### 5. After apply completes, `Status` is `FAILED`, `Error` is:
  ```
  Featureform cannot connect to the provider during health check: (REDIS_ONLINE - client_initialization) dial tcp ......
  ```

  - **Cause**: Redis address is unreachable
  - **Solution**: Check Redis status or update Redis access address

### 6. After apply completes, `Status` is `FAILED`, `Error` is:
  ```
  Featureform cannot connect to the provider during health check: (POSTGRES_OFFLINE - ping) dial tcp:
  ```

  - **Cause**: PostgreSQL address is unreachable
  - **Solution**: Check PostgreSQL status or update PostgreSQL access address

### 7. After apply completes, `Status` is `FAILED`, `Error` is:
  ```
  Featureform cannot connect to the provider during health check: (POSTGRES_OFFLINE - ping) pq: pg_hba.conf rejects connection ....
  ```

  - **Cause**: PostgreSQL access is rejected
  - **Solution**: Check if the configured PostgreSQL username, password, and SSL mode are correct, and verify PostgreSQL database user permission settings

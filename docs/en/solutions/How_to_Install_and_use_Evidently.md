---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.x
id: KB1756692696-9DEE
---
# Evidently

## Overview

Evidently is an open-source AI system evaluation and monitoring platform designed for building, testing, and monitoring data-driven AI systems.

It contains two main components:
- **Open-source Python Library**: Provides 70+ evaluation metrics, declarative testing APIs, and lightweight visualization interfaces
- **Localized UI Service**: Provides complete local deployment monitoring dashboard, including project management, dataset management, evaluation result visualization, and real-time monitoring interface

Helping teams build and maintain reliable, high-performance AI products: from predictive machine learning models to complex LLM-driven systems.

## Core Concepts

### Dataset

Datasets are the basic representation of data in Evidently, built on pandas DataFrame. Datasets contain:

- **Raw Data**: Input data in pandas DataFrame format
- **Data Definition**: Metadata definitions for column types and purposes
- **Descriptor Results**: Derived columns generated through descriptors
- **Statistical Information**: Basic statistical information about the dataset

Datasets support multiple data source formats, including CSV, Parquet, and Evidently-specific formats.

### DataDefinition

Data definition is the metadata description of a dataset, defining the data type and purpose of each column:

- **Basic Column Types**: Numerical columns, categorical columns, text columns, datetime columns, list columns
- **Special Columns**: ID columns, timestamp columns
- **Descriptor Columns**: Numerical and categorical columns generated through descriptors

Data definition also supports specifying machine learning task types:
- **Machine Learning Tasks**: Classification, regression, recommendation system, LLM task definitions

Data definition supports automatic type inference and can also explicitly specify column types for better performance and functionality.

### Descriptors

Descriptors are tools for analyzing and transforming data, generating new columns or providing data insights:

- **Text Analysis**: Sentiment analysis, text length, word count, sentence count, non-alphabetic character percentage, etc.
- **LLM Evaluation**: Rejection detection, bias detection, toxicity detection, PII detection, correctness, faithfulness, completeness, etc.
- **Content Detection**: Contains specific vocabulary, regex matching, link detection, start/end matching, etc.
- **Structured Validation**: JSON, Python, SQL format validation

Descriptors are computed when datasets are created, with results added as new columns to the dataset.

### Report

Reports are core components of Evidently used to generate evaluation results and visualizations:

- **Metric Collections**: Lists containing multiple metrics or metric containers
- **Metadata**: Basic information and labels for reports
- **Snapshot Generation**: Generate snapshots containing results through the `run()` method

Reports support various preset configurations, such as data quality monitoring, model performance evaluation, data drift detection, etc.

### Metrics

Metrics are computational units used to evaluate data quality and model performance:

- **Data Quality Metrics**: Missing values, duplicate values, data distribution, etc.
- **Model Performance Metrics**: Accuracy, precision, recall, F1 score, etc.
- **Drift Detection Metrics**: Statistical tests, distribution comparisons, etc.

Metrics can be used individually or combined into metric containers.

### Presets

Presets are predefined metric collections that simplify configuration for common monitoring scenarios:

- **Text Evaluation Presets**: `TextEvals` - Text and LLM evaluation
- **Data Drift Presets**: `DataDriftPreset` - Data distribution drift detection
- **Data Overview Presets**: `DataSummaryPreset` - Dataset overview and statistics
- **Classification Presets**: `ClassificationPreset` - Classification task quality
- **Regression Presets**: `RegressionPreset` - Regression task quality

Presets provide out-of-the-box monitoring solutions, greatly simplifying configuration complexity.

## Core Concept Relationships

- **Datasets** are the basic containers for data, containing raw data and metadata
- **Data Definitions** describe the column types and purposes of datasets
- **Descriptors** compute on datasets, generating new analysis columns
- **Reports** use metrics and presets to evaluate datasets
- **Metrics** provide specific evaluation computation logic
- **Presets** combine related metrics into complete monitoring solutions

## Local UI Service

### Service Architecture

Evidently's local UI Service provides a complete local deployment solution, supporting project data management, security authentication, interactive monitoring interface, and API interfaces.

### Core Features

#### Project Management
- **Workspace Management**: Create and manage multiple project workspaces
- **Project Creation**: Support for creating new monitoring projects
- **Project Configuration**: Flexible project settings and metadata management

#### Report Management
- **Report Storage**: Store and manage evaluation result reports
- **Report Viewing**: View and download evaluation reports
- **Report Metadata**: Manage report metadata and label information

#### Monitoring Dashboard
- **Metric Visualization**: Display model performance and data quality metrics
- **Historical Trends**: View metric changes over time
- **Report Viewing**: View and browse evaluation reports

#### Visualization Interface
- **Report Display**: View and display evaluation report visualization results
- **Chart Display**: Display various metrics and statistical charts

## Main Features

### Data Quality Monitoring

- **Basic Statistics**: Row count, column count, missing values, duplicate value statistics
- **Data Distribution**: Numerical distribution, categorical distribution, text feature analysis
- **Data Integrity**: Null value detection, format validation, consistency checks

### Model Performance Evaluation

- **Classification Models**: Accuracy, precision, recall, F1 score, ROC-AUC, confusion matrix
- **Regression Models**: MAE, MSE, RMSE, MAPE, R², residual analysis
- **Recommendation Systems**: NDCG, MAP, MRR, HitRate, PrecisionTopK, RecallTopK, and other ranking quality metrics

### Data Drift Detection

- **Statistical Tests**: KS test, PSI, Wasserstein distance, etc.
- **Distribution Comparison**: Distribution change detection for numerical, categorical, and text data
- **Embedding Drift**: Drift detection for vector embeddings

### LLM System Evaluation

- **Content Quality**: Correctness, faithfulness, completeness evaluation
- **Safety Detection**: Toxicity, bias, PII detection
- **Behavior Analysis**: Rejection detection, negativity analysis
- **Consistency Monitoring**: Answer length, emotional tone consistency

### Supported Data Formats

- **Input Formats**: pandas DataFrame, CSV, Parquet, Evidently-specific format (.evidently_dataset)
- **Output Formats**: HTML reports, JSON results, Evidently dataset format
- **Visualization**: Interactive HTML interface, charts and tables

## Use Cases

### Machine Learning Model Monitoring

- **Model Performance Tracking**: Real-time monitoring of model performance in production environments
- **Data Drift Detection**: Timely detection of changes in input data distribution
- **Model Degradation Alerts**: Set alert thresholds based on performance metrics

### LLM Application Monitoring

- **Content Quality Assurance**: Monitor the quality and consistency of LLM outputs
- **Security Compliance**: Detect harmful content, bias, and privacy leaks
- **User Experience**: Track answer length, emotional tone, and other user experience metrics

### Data Quality Assurance

- **Data Validation**: Ensure the integrity and correctness of input data
- **Anomaly Detection**: Identify outliers and patterns in data
- **Quality Reports**: Generate regular data quality reports

## Documentation and References

Evidently provides comprehensive official documentation and API references to help users understand and use platform features in depth:

### Official Documentation
- **Main Documentation**: [https://docs.evidentlyai.com/](https://docs.evidentlyai.com/)
  - Detailed introduction to Evidently's core concepts and workflows
  - Includes installation guides, quick start, and best practices
  - Provides common use cases, example code, tutorials, and API references

# Evidently UI Deployment Guide

This document provides detailed instructions on how to deploy Evidently UI to Kubernetes clusters, along with common configuration parameters.

## Upload

Download the Evidently installation file: `evidently.ALL.v0.7.14-1.tgz`

Use the violet command to publish to the platform repository:
```bash
violet push --platform-address=platform-access-address --platform-username=platform-admin --platform-password=platform-admin-password evidently.ALL.v0.7.14-1.tgz
```

## Deployment

### Storage Preparation

Evidently UI stores data in the file system and requires persistent storage. The cluster needs to have CSI pre-installed or `PersistentVolume` pre-prepared.

### Creating Application

1. Go to the `Alauda Container Platform` view and select the namespace where Evidently UI will be deployed.

2. In the left navigation, select `Applications` / `Applications`, and click the `Create` button on the right side of the opened page.

3. In the popup dialog, select `Create from Catalog`, then the page will jump to the `Catalog` view.

4. Find `3rdparty/chart-evidently-ui`, then click `Create` to create this application.

5. On the `Catalog` / `Create evidently` form, fill in the `Name` (recommended to fill in as `evidently`) and `Custom` configuration in `Values`, then click the `Create` button to complete the creation. The content of `Custom` will be described below. You can also modify it after creation through the `Update` application method.

## Configuration

Users can modify the `Custom Values` of the `Application` to adjust configurations. The key configurations are:

### 1. Storage Configuration

#### 1.1 Storage Class Configuration

Specify the storage class by adding the following configuration:

```yaml
statefulset:
  storage:
    storageClass: storage-class-name
```

### 2. Demo Project Configuration

Evidently supports launching demo projects:

```yaml
# Launch all available demo projects
demoProjects:
- all

# Or launch specific demo projects
demoProjects:
- bikes

# Or disable demo projects
demoProjects: []
```

Available demo projects:
- `bikes` - Bicycle rental data monitoring project

### 3. Authentication Configuration

#### 3.1 Enable Authentication

```yaml
secret:
  value: "your-secret-key"
```

After configuring the authentication key, Evidently will enable access control:

- **Web UI Access**: The UI interface will become read-only mode, unable to perform create, modify, delete and other operations
- **API Access**: All API operations require providing the correct key in the request header
  ```bash
  # Request header format
  evidently-secret: your-secret-key
  ```
- **SDK Usage**: The same key needs to be configured in the SDK for normal use

**Note**:
- When no key is configured, Evidently will allow anonymous access, which poses security risks in production environments
- Web UI does not support token authentication. After configuring the key, the UI will automatically become read-only mode

## Access Addresses

### 1. External Access Address

`Evidently UI` provides external access through `Service`. Check its `Service` to obtain the access address.

The `Service` name is the same as the application's name.

This `Service` type is `LoadBalancer`. If there is no `LoadBalancer` controller in the environment to provide external IP, you can access it through `node IP` with its `NodePort`.

### 2. Internal Access Address

To access Evidently UI within the cluster, you can access through the `ClusterIP` of the service (which has the same name as the application) with port 8000.

# Evidently Quickstart

This Quickstart demonstration will walk you through the following two main steps:

1. **LLM Evaluation** - Use LLM to evaluate the quality and characteristics of text responses

2. **Data Drift Detection** - Use Evidently to detect data drift and model performance monitoring

Through this demonstration, you will learn how to use Evidently for machine learning model monitoring, data quality checking, and LLM evaluation.

## File Descriptions

- [setup-env.sh](/evidently/quickstart/setup-env.sh) - Sets environment variables used by the demo
- [llm_evaluation.py](/evidently/quickstart/llm_evaluation.py) - LLM evaluation demonstration script
- [data_and_ml_checks.py](/evidently/quickstart/data_and_ml_checks.py) - Data drift detection and ML model monitoring demonstration script
- [requirements.txt](/evidently/quickstart/requirements.txt) - Python dependency packages

## Usage Steps

### 1. Prepare Evidently UI Service

Refer to the [deployment documentation](#evidently-ui-deployment-guide) to learn how to deploy Evidently UI in a Kubernetes environment.

### 2. Install Dependencies

**Python Version Requirements:**
- Supports Python 3.10

```bash
pip install -r requirements.txt
```

### 3. Configure Environment Variables

Edit the `setup-env.sh` file to set the relevant information, then use the following command to export environment variables:

```bash
source setup-env.sh
```

#### setup-env.sh File Content Description

The `setup-env.sh` file contains all environment variable configurations required for the demo:

```bash
#!/bin/bash

# Evidently configuration
export EVIDENTLY_URL="http://localhost:8000"
export EVIDENTLY_SECRET="your-secret"
export DEBUG="false"

# LLM configuration (for LLM evaluation)
export LLM_PROVIDER="deepseek"
export LLM_API_KEY="your-api-key"
export LLM_API_URL=""
export LLM_MODEL="deepseek-chat"
```

**Important Notes:**

- **EVIDENTLY_URL**: Evidently UI service address, please configure according to your environment
- **EVIDENTLY_SECRET**: Evidently UI secret key for authentication
- **DEBUG**: Set to `true` to enable detailed log output
- **LLM_xx**: Configuration for LLM evaluation, supports multiple LLM providers

### 4. Run LLM Evaluation Demo

```bash
python llm_evaluation.py
```

This script demonstrates how to use Evidently to evaluate responses through LLM. Let's look at its main components:

#### 4.1 Prepare Test Data

```python
def prepare_data():
    """Prepare test data and return DataFrame"""
    data = [
        ["What is the chemical symbol for gold?", "Gold chemical symbol is Au."],
        ["What is the capital of Japan?", "The capital of Japan is Tokyo."],
        ["Tell me a joke.", "Why don't programmers like nature? Too many bugs!"],
        # ... more test data
    ]

    columns = ["question", "answer"]
    eval_df = pd.DataFrame(data, columns=columns)
    return eval_df
```

**Data Format Description:**
- Uses **pandas DataFrame** as the standard data format
- DataFrame contains two columns: `question` (question) and `answer` (answer)
- This format facilitates data analysis and monitoring with Evidently

#### 4.2 Create LLM Evaluation Dataset

```python
def create_dataset(eval_df):
    """Create dataset with LLM evaluation descriptors"""
    eval_dataset = Dataset.from_pandas(
        eval_df,
        data_definition=DataDefinition(),
        descriptors=[
            Sentiment("answer", alias="Sentiment"),
            TextLength("answer", alias="Length"),
            DeclineLLMEval("answer", alias="Denials", provider=llm_provider, model=llm_model),
        ],
        options=options
    )

    return eval_dataset
```

**Descriptor Description:**

1. **Sentiment** - Sentiment Analysis Descriptor
   - Analyzes the emotional tendency of answer text (positive, negative, neutral)
   - Helps monitor emotional consistency of answers
   - Detects if answers are too negative or positive

2. **TextLength** - Text Length Descriptor
   - Counts the number of characters and words in answer text
   - Monitors the distribution and changes of answer length
   - Detects if answers are too short or too long

3. **DeclineLLMEval** - LLM Decline Detection Descriptor
   - **Uses LLM to judge whether the answer contains declining language**
   - LLM analyzes answer content to identify whether it expresses refusal or inability to answer
   - Evaluates the decline rate and decline patterns of answers, providing more intelligent text understanding

**More Descriptor Options:**
Evidently provides rich Descriptors for text and LLM evaluation.

For detailed list, please refer to: [Evidently AI - All Descriptors](https://docs.evidentlyai.com/metrics/all_descriptors)

#### 4.3 Generate Evaluation Report

```python
def generate_report(eval_dataset):
    """Generate evaluation report"""
    report = Report([
        TextEvals()
    ])
    my_eval = report.run(eval_dataset, None)
    return my_eval
```

**TextEvals Description:**
- **TextEvals** is Evidently's text evaluation preset, specifically for text and LLM evaluation
- It automatically runs all configured Descriptors and generates comprehensive evaluation reports
- Reports contain detailed analysis results and visualization charts for each Descriptor

**More Preset Options:**
Evidently provides various preset templates, including:
- **Text Evals**: Text and LLM evaluation
- **Data Drift**: Data distribution drift detection
- **Data Summary**: Dataset overview and statistics
- **Classification**: Classification task quality evaluation
- **Regression**: Regression task quality evaluation

For detailed information, please refer to: [Evidently AI - All Presets](https://docs.evidentlyai.com/metrics/all_presets)

#### 4.4 View Reports

After running the script, you can view reports in the following ways:

1. **Access Evidently UI**: Open browser and visit the `EVIDENTLY_URL` address configured in environment variables
2. **Find Project**: Find the project named "llm_evaluation" in the UI
3. **View Reports**: Click on the project to view detailed evaluation reports and visualization charts

### 5. Run Data Drift Detection Demo

```bash
python data_and_ml_checks.py
```

This script demonstrates how to use Evidently for data drift detection. Let's look at its main components:

#### 5.1 Data Preparation

```python
def prepare_data():
    """Prepare reference dataset and production dataset"""
    logger.info("Loading adult dataset...")
    adult_data = datasets.fetch_openml(name="adult", version=2, as_frame="auto")
    adult = adult_data.frame
    adult_ref = adult[~adult.education.isin(["Some-college", "HS-grad", "Bachelors"])]
    adult_prod = adult[adult.education.isin(["Some-college", "HS-grad", "Bachelors"])]

    return adult_ref, adult_prod
```

**Data Format Description:**
- Uses **pandas DataFrame** as the standard data format
- Loads data from OpenML dataset
- Divides data into reference dataset (`adult_ref`) and production dataset (`adult_prod`)
- This format facilitates data drift detection and comparative analysis with Evidently

#### 5.2 Dataset Creation

```python
def create_datasets(adult_ref, adult_prod):
    """Create reference dataset and production dataset"""
    schema = DataDefinition(
        numerical_columns=["education-num", "age", "capital-gain", "hours-per-week", "capital-loss", "fnlwgt"],
        categorical_columns=["education", "occupation", "native-country", "workclass", "marital-status", "relationship", "race", "sex", "class"],
    )

    ref_dataset = Dataset.from_pandas(
        pd.DataFrame(adult_ref),
        data_definition=schema
    )

    prod_dataset = Dataset.from_pandas(
        pd.DataFrame(adult_prod),
        data_definition=schema
    )

    return ref_dataset, prod_dataset
```

#### 5.3 Generate Report

```python
def generate_report(ref_dataset, prod_dataset):
    """Generate data drift report"""
    report = Report([
        DataDriftPreset()
    ])
    my_eval = report.run(ref_dataset, prod_dataset)
    return my_eval
```

**DataDriftPreset Description:**
- **DataDriftPreset** is Evidently's data drift detection preset, specifically designed for detecting data distribution changes
- It automatically runs various statistical tests to detect drift in numerical and categorical features
- Reports include drift detection results for each column, statistical significance tests, and visualization charts

#### 5.4 View Reports

After running the data drift detection script, you can view reports in the following ways:

1. **Access Evidently UI**: Open browser and visit the `EVIDENTLY_URL` address configured in environment variables
2. **Find Project**: Find the project named "data_and_ml_checks" in the UI
3. **View Reports**: Click on the project to view detailed data drift detection reports and visualization charts

## Other Examples

In addition to the above quick start demonstrations, Evidently provides more advanced features and examples:

### Tracing Functionality
- **Tracing QuickStart**: Used to capture LLM application inputs and outputs and evaluate them
- Note: Tracing functionality is only available for Evidently Cloud, not for self-hosted environments
- For detailed description, please refer to: [Evidently AI - Tracing QuickStart](https://docs.evidentlyai.com/quickstart_tracing)

### Advanced LLM Evaluation Features
According to [Evidently AI Examples Documentation](https://docs.evidentlyai.com/examples/introduction), Evidently also provides the following advanced features:

- **LLM evaluations**: Comprehensive tutorials covering various LLM evaluation methods
- **RAG evals**: Specialized evaluation methods for Retrieval-Augmented Generation (RAG) systems
- **LLM as a judge**: Use LLM as an evaluator to create and evaluate LLM judges
- **LLM-as-a-jury**: Use multiple LLMs to evaluate the same output

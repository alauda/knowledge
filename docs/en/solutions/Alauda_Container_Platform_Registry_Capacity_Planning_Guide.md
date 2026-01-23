---
kind:
   - Solution
products:
  - Alauda Container Platform
ProductsVersion:
   - 4.x
---

# Alauda Container Platform Registry & Registry Gateway Capacity Planning Guide

## Introduction
This document provides hardware resource specification recommendations for **Alauda Container Platform Registry** in Kubernetes environments. The stack consists of two core components:

* **Alauda Container Platform Registry**: The OCI image registry server responsible for storing and distributing image layers and manifests. It is I/O and network-intensive.
* **Registry Gateway**: A proxy middleware that enforces policies such as image size limits and repository tag count limits before requests reach the registry. It is primarily CPU and network-latency intensive.

The recommendations are based on an analysis of component architectures, source code, and known performance characteristics, targeting three common deployment scales.

## Component Analysis & Resource Profiles

### Alauda Container Platform Registry

**Resource Profile**:
* **I/O Intensive**: Performance is heavily dependent on storage backend speed (for layer push/pull operations).
* **Memory Sensitive**: Requires adequate memory for layer caching during pushes and pulls, and for handling concurrent connections.
* **Moderate CPU**: CPU is used for compression, hashing, and request handling.

### Registry Gateway

**Resource Profile**:
* **CPU Intensive**: Due to JSON parsing, size calculation, and request proxying.
* **Latency Sensitive**: Performance is tightly coupled with the response time of the backend Registry's tag listing endpoint.
* **Memory Sensitive**: Needs buffer for large manifest requests and maintains session cache.

## Core Evaluation Dimensions
This guide provides resource configuration recommendations based on the following two dynamic load indicators:
* **Daily Average Access Traffic**: Reflects ongoing daily load levels.
* **Peak Access Traffic**: Reflects the maximum concurrent pressure the system needs to handle.
These traffic flows primarily consist of two types of operations:
* **Push Operations**: Trigger image uploads, manifest parsing, and tag validation, placing higher demands on gateway CPU and memory.
* **Pull Operations**: Mainly generate pressure on registry I/O and network

## Traffic Level Definitions

| Traffic Level | Daily Pull/Push Operations | Peak Concurrent Pull/Push Operations | Typical Scenario |
| --------- |  -------------- | --------------------- | -------------------------- |
| Low Traffic | <1,000 | < 50 | Small team development/testing, light usage |
| Medium Traffic | 1,000-10,000 | 50-200 | Production environment with formal CI/CD pipelines |
| High Traffic | >10,000 | >200 | Enterprise central registry, shared by multiple teams |

## Recommended Resource Configurations

### Scenario 1: Low Traffic
Applicable: Small team development/testing, infrequent image updates

| Component | Recommended Replicas | Container Resources (Requests / Limits) | Notes |
| --------- | -------------------- | -------------------------------------- | ---------------- |
| Alauda Container Platform Registry | 2 | CPU: `500m` / `1000m` <br> Memory: `512Mi` / `1Gi` | Basic configuration sufficient. |
| Registry Gateway | 2 | CPU: `250m` / `500m` <br> Memory: `256Mi` / `512Mi` | Basic configuration sufficient. |

### Scenario 2: Medium Traffic
Applicable: Production environment with regular release processes, multiple pipelines

| Component | Recommended Replicas | Container Resources (Requests / Limits) | Notes |
| --------- | -------------------- | -------------------------------------- | ---------------- |
| Alauda Container Platform Registry | 3 | CPU: `1000m` / `2000m` <br> Memory: `1Gi` / `2Gi` | The use of object storage (S3-compatible) is advisable. |
| Registry Gateway | 3 | CPU: `500m` / `1000m` <br> Memory: `512Mi` / `1Gi` | HPA required to handle push peaks. |

### Scenario 3: High Traffic
Applicable: Enterprise central registry serving multiple teams and all environments

| Component | Recommended Replicas | Container Resources (Requests / Limits) | Notes |
| --------- | -------------------- | -------------------------------------- | ---------------- |
| Alauda Container Platform Registry | 5 | CPU: `2000m` / `4000m` <br> Memory: `2Gi` / `4Gi` | The use of object storage is advisable. |
| Registry Gateway | 5 | CPU: `1000m` / `2000m` <br> Memory: `1Gi` / `2Gi` | HPA mandatory, scaling based on CPU and latency metrics. |

## Considerations for Dedicated Node Deployment
In production environments, deploying the `Alauda Container Platform Registry` and `Registry Gateway` on **dedicated nodes** (separate from core PaaS components) is strongly recommended when any of the following conditions apply:
* **High Concurrency/Throughput**: The registry handles over 10,000 daily operations, or experiences frequent batch image pulls during cluster scaling.
* **High Availability & Strict SLA Requirements**: Requires >99.9% availability, supports replication, or needs independent upgrade/disaster recovery procedures.
* **Resource Isolation & Security Compliance**: Mandated by multi-tenancy or regulatory audits, requiring separate security policies, logging, and data isolation.
**Benefits**: Prevents resource contention with critical platform services (e.g., API Server), minimizes performance interference, and simplifies security management.

## Final Recommendation
It is recommended to configure resources based on daily/peak traffic, with basic setup for low traffic and HPA for medium/high traffic. For production environments, high concurrency (over 10k daily operations), or scenarios requiring high availability and strong isolation, it is strongly advised to deploy the Registry and Gateway on dedicated nodes. This approach avoids resource contention with core PaaS components, minimizes performance fluctuations, and facilitates independent disaster recovery, security policies, and storage optimization, ensuring service stability and data isolation.

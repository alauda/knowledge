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

## Recommended Specifications by Cluster Scale
The following tables provide baseline recommendations for resource requests and limits. Vertical scaling (increasing replica resources) and horizontal scaling (increasing replica count) should be combined.

### Scenario 1: ~100 Concurrent Pods (Light Usage)
| Component | Recommended Replicas | Container Resources (Requests / Limits) | Notes |
| --------- | -------------------- | -------------------------------------- | ---------------- |
| Alauda Container Platform Registry | 1-2 | CPU: `500m` / `1000m` <br> Memory: `512Mi` / `1Gi` | Single replica may suffice. |
| Registry Gateway | 1-2 | CPU: `200m-300m` / `500m` <br> Memory: `256Mi-512Mi` / `1Gi` | Resources accommodate bursty image pushes requiring manifest parsing. |

### Scenario 2: ~1000 Concurrent Pods (Medium Usage)
| Component | Recommended Replicas | Container Resources (Requests / Limits) | Notes |
| --------- | -------------------- | -------------------------------------- | ---------------- |
| Alauda Container Platform Registry | 2-3 | CPU: `1000m` / `2000m` <br> Memory: `1Gi` / `2Gi` | Requires multiple replicas. |
| Registry Gateway | 2-3 | CPU: `300m-500m` / `1000m-2000m` <br> Memory: `512Mi-1Gi` / `2Gi` | The synchronous tag-list check becomes a primary bottleneck. Higher CPU limits are needed. |

### Scenario 3: ~5000 Concurrent Pods (Large Usage)
| Component | Recommended Replicas | Container Resources (Requests / Limits) | Notes |
| --------- | -------------------- | -------------------------------------- | ---------------- |
| Alauda Container Platform Registry | 3-5+ | CPU: `2000m` / `4000m` <br> Memory: `2Gi` / `4Gi` | Requires significant horizontal scaling. |
| Registry Gateway | 3-5+ | CPU: `500m-1000m` / `2000m-4000m` <br> Memory: `1Gi-2Gi` / `4Gi` | Tag validation latency can cause cascading delays. |

## Final Recommendation
Start with the baseline suggestions for your target scale, implement comprehensive monitoring, and iteratively adjust resources and replica counts based on observed performance metrics.

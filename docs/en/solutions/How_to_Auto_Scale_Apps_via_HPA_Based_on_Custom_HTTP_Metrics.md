---
kind:
   - Solution
products:
  - Alauda Container Platform
ProductsVersion:
   - 4.x
---

# How to Auto-Scale Applications via HPA Based on Custom HTTP Metrics

## Introduction
This guide provides a step-by-step tutorial on implementing autoscaling for applications in Kubernetes based on custom HTTP metrics. The solution includes:

  - Developing a demo application that exposes Prometheus metrics for HTTP request count.
  - Containerizing the application and deploying it to Kubernetes.
  - Configuring Prometheus to scrape metrics.
  - Setting up Prometheus Adapter to expose custom metrics to Kubernetes.
  - Creating Horizontal Pod Autoscaler (HPA) that uses custom HTTP metrics for scaling decisions.
  - Validating the autoscaling behavior with load testing.

## Prerequisites

  - Kubernetes cluster with Prometheus and Prometheus Adapter installed.
  - `kubectl` command-line tool configured to access the cluster.
  - Go (if building the application locally).
  - Container runtime (if building the application locally).

## Architecture Overview
```text
┌─────────────────┐     Metrics     ┌─────────────────┐
│   Go Application│────────────────▶│   Prometheus    │
│   (Port 8080)   │◀────────────────│     Server      │
└─────────────────┘     Scrape      └─────────────────┘
         │                                   │
         │ Pod Metrics                       │ Custom Metrics
         ▼                                   ▼
┌─────────────────┐                 ┌─────────────────┐
│   Kubernetes    │                 │   Prometheus    │
│   HPA Controller│◀────────────────│     Adapter     │
└─────────────────┘    Custom       └─────────────────┘
         │            Metrics API
         │ Scaling
         ▼
┌─────────────────┐
│   Deployment    │
│   (Auto-scaled) │
└─────────────────┘
```

## Step-by-Step Implementation

### Step 1: Get the Demo Application

Refer to the open-source repository for the complete Go application implementation:
GitHub Repository: [http-metrics-exporter](https://github.com/zhhray/http-metrics-exporter)
The application includes:
  - HTTP server exposing metrics on `/metrics` endpoint.
  - Prometheus metrics for HTTP request count.

### Step 2: Build and Push the Application Image

Refer to the Dockerfile in the GitHub repository for containerization details:

Dockerfile Location: [Dockerfile](https://github.com/zhhray/http-metrics-exporter/blob/main/Dockerfile)

Build and push the container image:
  ```bash
  git clone https://github.com/zhhray/http-metrics-exporter.git
  cd http-metrics-exporter
  # Build the application locally
  make build-linux

  # Build the container image
  make docker-build

  # Push the container image to a target registry
  # You can modify the DOCKER_REGISTRY in Makefile as needed
  make docker-push
  ```

### Step 3: Prepare Namespace on ACP Console
  - Navigate to [Projects] page, click `Create Project` button.
  - Provide the following information:
    - Name: `demo`
    - Cluster: Select the cluster where the demo application will be installed.
  - Click `Create Project` button to create the project.
  - Navigate to [Projects] -> [Namespace] page, click `Create Namespace` button.
  - Provide the following information:
    - Cluster: Select the cluster where the demo application will be installed.
    - Namespace: `demo-ns`
  - Click `Create` button to create the namespace.

### Step 4: Kubernetes Deployment

All Kubernetes deployment manifests are available in the GitHub repository:

Deployment Resources: [deploy resources](https://github.com/zhhray/http-metrics-exporter/tree/main/deploy)

Key resources include:
 - `resources.yaml`: Deployment and Service configuration
 - `servicemonitor.yaml`: Prometheus ServiceMonitor configuration
 - `hpa.yaml`: Horizontal Pod Autoscaler configuration
 - `load-test-scaling.sh`: Load testing script

Deploy the application resources to Kubernetes:
  ```bash
  kubectl apply -f deploy/resources.yaml
  # Output:
  service/metrics-app created
  deployment.apps/metrics-app created
  ```
Deploy the Prometheus ServiceMonitor Configuration:
  ```bash
  kubectl apply -f deploy/servicemonitor.yaml
  # Output:
  servicemonitor.monitoring.coreos.com/metrics-app-monitor created
  ```
Configure Prometheus Adapter Configuration:
  ```bash
  kubectl edit configmap cpaas-monitor-prometheus-adapter -n cpaas-system
  # Add the following lines to the configmap:
  - seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
    seriesFilters: []
    resources:
      overrides:
        namespace: {resource: "namespace"}
        pod: {resource: "pod"}
    name:
      matches: "http_requests_total"
      as: "http_requests_per_second"
    metricsQuery: 'sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)'
   
  # Delete prometheus-adapter pod to reload config
  kubectl delete pod -n cpaas-system $(kubectl get pod -n cpaas-system | grep prometheus-adapter | awk '{print $1}')
  # Output:
  pod "cpaas-monitor-prometheus-adapter-57fbc5cb78-gjclc" deleted

  # Check metrics
  kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/demo-ns/pods/*/http_requests_per_second" | jq .
  {
    "kind": "MetricValueList",
    "apiVersion": "custom.metrics.k8s.io/v1beta1",
    "metadata": {},
    "items": [
        {
        "describedObject": {
            "kind": "Pod",
            "namespace": "demo-ns",
            "name": "metrics-app-79d749bbd-bvdw7",
            "apiVersion": "/v1"
        },
        "metricName": "http_requests_per_second",
        "timestamp": "2026-01-20T10:27:46Z",
        "value": "295m",
        "selector": null
        },
        {
        "describedObject": {
            "kind": "Pod",
            "namespace": "demo-ns",
            "name": "metrics-app-79d749bbd-j8vkd",
            "apiVersion": "/v1"
        },
        "metricName": "http_requests_per_second",
        "timestamp": "2026-01-20T10:27:46Z",
        "value": "304m",
        "selector": null
        }
    ]
  }
  ```
Deploy the Horizontal Pod Autoscaler Configuration:
  ```bash
  kubectl apply -f deploy/hpa.yaml
  # Output:
  horizontalpodautoscaler.autoscaling/metrics-app-hpa created
  ```
### Step 5: Load Test and Verify

Scp `deploy/load-test-scaling.sh` to the master node of k8s cluster which the metrics-app is running.

The script will send requests to the metrics-app endpoint, triggering the HPA to scale up or down based on the defined metrics.

Execute the load test script:
  ```bash
  chmod 755 load-test-scaling.sh
  ./load-test-scaling.sh
  # Output:
  === Effective Load Test Script ===

  1. Current Status:
  NAME              REFERENCE                TARGETS   MINPODS   MAXPODS   REPLICAS   AGE
  metrics-app-hpa   Deployment/metrics-app   295m/5    1         10        1          17h
  
  2. Creating load test Pod...
  pod/load-test-pod created
  3. Waiting for load test Pod to start...
  pod/load-test-pod condition met
  4. Monitoring HPA changes (5 minutes)...
  Timestamp | Desired Replicas | Current Replicas | Current Metric | Status
  -----------------------------------------------------------------------
  11:48:44 | 1               | 1               | .30            | ⏸️ Stable
  11:48:55 | 1               | 1               | 39.38          | ⏸️ Stable
  11:49:05 | 1               | 1               | 39.38          | ⏸️ Stable
  11:49:15 | 3               | 1               | 97.19          | ⬆️ Scaling Up
  11:49:26 | 3               | 1               | 151.96         | ⬆️ Scaling Up
  11:49:36 | 3               | 3               | 151.96         | ⏸️ Stable
  11:49:47 | 6               | 3               | 180.46         | ⬆️ Scaling Up
  11:49:57 | 6               | 3               | 84.36          | ⬆️ Scaling Up
  11:50:08 | 6               | 6               | 90.73          | ⏸️ Stable
  11:50:18 | 10              | 6               | 61.33          | ⬆️ Scaling Up
  11:50:29 | 10              | 6               | 58.10          | ⬆️ Scaling Up
  11:50:39 | 10              | 10              | 56.58          | ⏸️ Stable
  11:50:49 | 10              | 10              | 44.74          | ⏸️ Stable
  11:51:00 | 10              | 10              | 34.19          | ⏸️ Stable
  11:51:10 | 10              | 10              | 31.17          | ⏸️ Stable
  11:51:20 | 10              | 10              | 33.69          | ⏸️ Stable
  11:51:31 | 10              | 10              | 33.84          | ⏸️ Stable
  11:51:41 | 10              | 10              | 31.80          | ⏸️ Stable
  11:51:52 | 10              | 10              | 32.83          | ⏸️ Stable
  11:52:02 | 10              | 10              | 32.26          | ⏸️ Stable
  11:52:12 | 10              | 10              | 31.62          | ⏸️ Stable
  11:52:23 | 10              | 10              | 31.94          | ⏸️ Stable
  11:52:33 | 10              | 10              | 28.20          | ⏸️ Stable
  11:52:44 | 10              | 10              | 27.83          | ⏸️ Stable
  11:52:54 | 10              | 10              | 30.93          | ⏸️ Stable
  11:53:05 | 10              | 10              | 30.47          | ⏸️ Stable
  11:53:15 | 10              | 10              | 30.32          | ⏸️ Stable
  11:53:25 | 10              | 10              | 29.80          | ⏸️ Stable
  11:53:36 | 10              | 10              | 29.42          | ⏸️ Stable
  11:53:46 | 10              | 10              | 28.87          | ⏸️ Stable
  
  5. Cleaning up load test Pod...
  pod "load-test-pod" force deleted
  
  Final Status:
  NAME              REFERENCE                TARGETS    MINPODS   MAXPODS   REPLICAS   AGE
  metrics-app-hpa   Deployment/metrics-app   29217m/5   1         10        10         17h
  ```

The load test successfully validated that the HPA implementation is working correctly. The system automatically scales based on HTTP request rates, ensuring optimal resource utilization during traffic spikes. The custom metrics pipeline (application → Prometheus → Prometheus Adapter → HPA) is functioning as designed, providing a robust auto-scaling solution for HTTP-based applications.

After the load test completed and the load-test-pod was deleted, the HTTP request rate dropped significantly. Following the HPA's scale-down configuration, the deployment automatically scaled back down to the minimum of 1 pod over time. 

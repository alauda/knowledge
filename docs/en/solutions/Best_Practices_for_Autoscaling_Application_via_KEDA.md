---
kind:
   - Best Practices
products:
  - Alauda Container Platform
ProductsVersion:
   - 4.x
id: none
---

# Auto Scaling Application via KEDA

## Integrating ACP Monitoring with Prometheus Plugin
### Prerequisites
Before using this functionality, ensure that:
- [Installing KEDA Operator](/solutions/How_to_Install_KEDA_Operator.md)
- Installing ACP Monitoring with Prometheus Plugin
- Retrieve the Prometheus endpoint URL and secretName for the current Kubernetes cluster:
    ```bash
    PrometheusEndpoint=$(kubectl get feature monitoring -o jsonpath='{.spec.accessInfo.database.address}')
    ```
- Retrieve the Prometheus secret for the current Kubernetes cluster:
    ```bash
    PrometheusSecret=$(kubectl get feature monitoring -o jsonpath='{.spec.accessInfo.database.basicAuth.secretName}')
    ```
- Create a deployment named **`<your-deployment>`** in the **`<your-namespace>`** namespace.

### Procedure

- Configure Prometheus Authentication Secret in **keda** Namespace.

**Steps to Copy Secret from cpaas-system to keda Namespace**
```bash
# Get Prometheus auth info
PrometheusUsername=$(kubectl get secret $PrometheusSecret -n cpaas-system -o jsonpath='{.data.username}' | base64 -d)
PrometheusPassword=$(kubectl get secret $PrometheusSecret -n cpaas-system -o jsonpath='{.data.password}' | base64 -d)

# create secret in keda namespace
kubectl create secret generic $PrometheusSecret \
  -n keda \
  --from-literal=username=$PrometheusUsername \
  --from-literal=password=$PrometheusPassword
```

- Configure KEDA Authentication for Prometheus Access Using **ClusterTriggerAuthentication**.

To configure authentication credentials for KEDA to access Prometheus, define a ClusterTriggerAuthentication resource that references the Secret containing the username and password. Below is an example configuration:
```bash
kubectl apply -f - <<EOF
apiVersion: keda.sh/v1alpha1
kind: ClusterTriggerAuthentication
metadata:
  name: cluster-prometheus-auth
spec:
  secretTargetRef:
    - key: username
      name: $PrometheusSecret
      parameter: username
    - key: password
      name: $PrometheusSecret
      parameter: password
EOF
```

- Configure Autoscaling for Kubernetes Deployments Using Prometheus Metrics with **ScaledObject**.

To scale a Kubernetes Deployment based on Prometheus metrics, define a **ScaledObject** resource referencing the configured ClusterTriggerAuthentication. Below is an example configuration:
```bash
kubectl apply -f - <<EOF
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: prometheus-scaledobject
  namespace: <your-namespace>
spec:
  cooldownPeriod: 300          # Time in seconds to wait before scaling down
  maxReplicaCount: 5           # Maximum number of replicas
  minReplicaCount: 1           # Minimum replicas (note: HPA may enforce a minimum of 1)
  pollingInterval: 30          # Interval (seconds) to poll Prometheus metrics
  scaleTargetRef:
    name: <your-deployment>    # Name of the target Kubernetes Deployment
  triggers:
    - authenticationRef:
        kind: ClusterTriggerAuthentication
        name: cluster-prometheus-auth  # Reference to the ClusterTriggerAuthentication
      metadata:
        authModes: basic       # Authentication method (basic auth in this case)
        query: sum(container_memory_working_set_bytes{container!="POD",container!="",namespace="<your-namespace>",pod=~"<your-deployment-name>.*"})
        queryParameters: timeout=10s  # Optional query parameters
        serverAddress: $PrometheusEndpoint
        threshold: "1024000"   # Threshold value for scaling
        unsafeSsl: "true"      # Skip SSL certificate validation (not recommended for production)
      type: prometheus         # Trigger type
EOF
```

### Verification
To verify that the ScaledObject has scaled the deployment, you can check the number of replicas of the target deployment:
```bash
kubectl get deployment <your-deployment> -n <your-namespace>
```
Or you can use the following command to check the number of pods:
```bash
kubectl get pods -n <your-namespace> -l <your-deployment-label-key>=<your-deployment-label-value>
```
The number of replicas should increase or decrease based on the metrics specified in the ScaledObject.
If the deployment is scaled correctly, you should see the number of pods have changed to `maxReplicaCount` value.

## Pausing Autoscaling in KEDA
KEDA allows you to pause autoscaling of workloads temporarily, which is useful for:
- Cluster maintenance.
- Avoiding resource starvation by scaling down non-critical workloads.

### Procedure
#### Immediate Pause with Current Replicas
Add the following annotation to your **ScaledObject** definition to pause scaling without changing the current replica count:
```yaml
metadata:
  annotations:
    autoscaling.keda.sh/paused: "true"
```

#### Pause After Scaling to a Specific Replica Count
Use this annotation to scale the workload to a specific number of replicas and then pause:
```yaml
metadata:
  annotations:
    autoscaling.keda.sh/paused-replicas: "<number>"
```

#### Behavior When Both Annotations are Set
If both **paused** and **paused-replicas** are specified:
  - KEDA scales the workload to the value defined in **paused-replicas**.
  - Autoscaling is paused afterward.

#### Unpausing Autoscaling
To resume autoscaling:
  - Remove both paused and paused-replicas annotations from the ScaledObject.
  - If only paused: "true" was used, set it to false:
    ```yaml
    metadata:
      annotations:
        autoscaling.keda.sh/paused: "false"
    ```

### Scaling to Zero

#### Autoscaling to Zero
KEDA unlike the HPA, can scale to zero. If you set the minReplicaCount value in the `ScaledObject` CR to 0, KEDA scales the workload down from 1 to 0 replicas or up from 0 replicas to 1. This is known as the activation phase. After scaling up to 1 replica, the HPA takes control of the scaling. This is known as the scaling phase.

Example ScaledObject Configuration:
```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: example-scaledobject
  namespace: <your-namespace>
spec:
  scaleTargetRef:
    name: example-deployment
  minReplicaCount: 0
```

#### Manual Scaling to Zero and Pause Autoscaling
Specifies the replicas to `0` and stop autoscaling:
```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: example-scaledobject
  namespace: <your-namespace>
  annotations:
    autoscaling.keda.sh/paused-replicas: "0"  # Scale to 0 replicas and pause
```

#### Verification

To verify that the ScaledObject has scaled to zero, you can check the number of replicas of the target deployment:
```bash
kubectl get deployment <your-deployment> -n <your-namespace>
```

Or you can check the number of pods in the target deployment:
```bash
kubectl get pods -n <your-namespace> -l <your-deployment-label-key>=<your-deployment-label-value>
```
The number of pods should be zero, indicating that the deployment has scaled to zero.

## Other KEDA scalers

KEDA **scalers** can both detect if a deployment should be activated or deactivated, and feed custom metrics for a specific event source.

KEDA supports a wide range of additional **scalers**. For more details, see the official documentation: [KEDA Scalers](https://keda.sh/docs/scalers/).
